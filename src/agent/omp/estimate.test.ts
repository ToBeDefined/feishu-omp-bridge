import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compactTimeoutMs, estimateCompactSeconds, estimateSessionTokens, findSessionFile, tokensFromLine } from './estimate';

function assistantLine(input: number, cacheRead: number, totalTokens?: number): string {
  return JSON.stringify({
    type: 'message',
    message: {
      role: 'assistant',
      content: [],
      usage: { input, output: 3, cacheRead, cacheWrite: 0, ...(totalTokens !== undefined ? { totalTokens } : {}) },
    },
  });
}

describe('tokensFromLine', () => {
  it('reads context occupancy from assistant usage', () => {
    expect(tokensFromLine(assistantLine(159, 410560))).toBe(410719);
  });

  it('falls back to totalTokens when the components are absent', () => {
    const line = JSON.stringify({ type: 'message', message: { role: 'assistant', usage: { output: 63, totalTokens: 410782 } } });
    expect(tokensFromLine(line)).toBe(410782);
  });

  it('prefers contextTokens over the usage sum', () => {
    const line = JSON.stringify({ type: 'message', message: { role: 'assistant', usage: { input: 1, cacheRead: 2, contextTokens: 9999 } } });
    expect(tokensFromLine(line)).toBe(9999);
  });

  it('reads a compaction frame via tokensAfter', () => {
    const line = JSON.stringify({ type: 'compaction', tokensBefore: 410782, tokensAfter: 55371, method: 'soft' });
    expect(tokensFromLine(line)).toBe(55371);
  });

  it('ignores user/custom/malformed lines', () => {
    expect(tokensFromLine(JSON.stringify({ type: 'message', message: { role: 'user', content: 'hi', usage: { totalTokens: 5 } } }))).toBe(0);
    expect(tokensFromLine(JSON.stringify({ type: 'custom', usage: { totalTokens: 5 } }))).toBe(0);
    expect(tokensFromLine('{"type":"message",')).toBe(0);
    expect(tokensFromLine('')).toBe(0);
    expect(tokensFromLine('no usage here at all')).toBe(0);
  });
});

describe('estimateSessionTokens', () => {
  it('finds the newest usage across chunk boundaries', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omp-estimate-'));
    // Padding forces the file past the 256 KiB chunk size so the scan crosses
    // at least one boundary; the real usage line sits at the very end.
    const pad = assistantLine(1, 900);
    const lines = [pad];
    while (lines.join('\n').length < 300 * 1024) lines.push(pad);
    lines.push(assistantLine(20, 688108));
    lines.push(JSON.stringify({ type: 'custom', value: 'trailing frame without usage' }));
    await writeFile(join(dir, '2026-01-01T00-00-00-000Z_s1.jsonl'), lines.join('\n') + '\n', 'utf8');

    const est = await estimateSessionTokens(dir, 's1');

    expect(est?.tokens).toBe(688128);
    expect(est?.bytes).toBeGreaterThan(300 * 1024);
  });

  it('returns undefined when the session file is missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omp-estimate-'));
    expect(await estimateSessionTokens(dir, 'ghost')).toBeUndefined();
    expect(await estimateSessionTokens('/nonexistent-dir-xyz', 's1')).toBeUndefined();
  });

  it('picks the lexicographically newest file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omp-estimate-'));
    await writeFile(join(dir, '2026-01-01T00-00-00-000Z_s1.jsonl'), assistantLine(1, 100) + '\n', 'utf8');
    await writeFile(join(dir, '2026-02-01T00-00-00-000Z_s1.jsonl'), assistantLine(1, 700) + '\n', 'utf8');
    expect((await estimateSessionTokens(dir, 's1'))?.tokens).toBe(701);
    expect(await findSessionFile(dir, 's1')).toContain('2026-02-01');
  });

  it('reads usage when a CJK character straddles the 256 KiB chunk boundary', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omp-estimate-cjk-'));
    const CHUNK = 256 * 1024;
    const old = assistantLine(1, 100) + '\n';
    const prefix = '{"type":"message","message":{"role":"assistant","content":"';
    const zh = '中';
    const afterZh = '","usage":{"input":20,"output":3,"cacheRead":688108,"cacheWrite":0}}}\n';
    const padAfterBytes = CHUNK - 2 - Buffer.byteLength(afterZh, 'utf8');
    const padAfter = 'a'.repeat(padAfterBytes);
    const body = old + prefix + zh + afterZh + padAfter;
    const zhIndex = Buffer.byteLength(old + prefix, 'utf8');
    const size = Buffer.byteLength(body, 'utf8');
    expect(zhIndex).toBe(size - CHUNK - 1);
    await writeFile(join(dir, '2026-01-01T00-00-00-000Z_s1.jsonl'), body, 'utf8');

    const est = await estimateSessionTokens(dir, 's1');
    expect(est?.tokens).toBe(688128);
  });

  it('returns zero tokens when the session has no usage frames', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omp-estimate-empty-'));
    await writeFile(join(dir, '2026-01-01T00-00-00-000Z_s1.jsonl'), '{"type":"session","id":"s1"}\n', 'utf8');
    expect(await estimateSessionTokens(dir, 's1')).toEqual({ tokens: 0, bytes: expect.any(Number) });
  });

  it('returns undefined when the matched path is not a readable file', async () => {
    const { mkdir } = await import('node:fs/promises');
    const dir = await mkdtemp(join(tmpdir(), 'omp-estimate-dir-'));
    await mkdir(join(dir, '2026-01-01T00-00-00-000Z_s1.jsonl'));
    expect(await estimateSessionTokens(dir, 's1')).toBeUndefined();
  });
});

describe('compactTimeoutMs', () => {
  it('floors at 600 s for small or unknown sessions', () => {
    expect(compactTimeoutMs(0)).toBe(600_000);
    expect(compactTimeoutMs(50_000)).toBe(600_000);
  });

  it('scales with the token count', () => {
    // 399,995 tok × 1.35 s/k × 3 = 1,619.98 s → ceil 1620 s.
    expect(compactTimeoutMs(399_995)).toBe(1_620_000);
    // The incident session: ≈690k tokens → ceil(2794.5) s ≈46.6 min.
    expect(compactTimeoutMs(690_000)).toBe(2_795_000);
  });

  it('caps at 6 hours', () => {
    expect(compactTimeoutMs(10_000_000)).toBe(6 * 3600_000);
  });
});

describe('estimateCompactSeconds', () => {
  it('is 1.35 s per 1k tokens', () => {
    expect(estimateCompactSeconds(0)).toBe(0);
    expect(estimateCompactSeconds(1000)).toBe(1.35);
  });
});
