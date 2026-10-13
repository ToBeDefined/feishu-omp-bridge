import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { paths } from '../../config/paths';
import type { CommandContext } from '../index';
import { scanSessionFiles } from './sessions';

const origDir = paths.ompSessionsDir;
let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'sessions-scan-'));
  paths.ompSessionsDir = tmp;
});

afterEach(async () => {
  paths.ompSessionsDir = origDir;
  await rm(tmp, { recursive: true, force: true });
});

/** 最小 ctx：scanSessionFiles 只碰 cfg（取目录）和 sessions（取标题/归属）。 */
function makeCtx(): CommandContext {
  return {
    controls: { cfg: {} },
    sessions: {
      titlesBySessionId: () => ({}),
      chats: () => [],
      sessionFor: () => undefined,
    },
  } as unknown as CommandContext;
}

function sessionFrame(id: string, cwd: string): string {
  return `${JSON.stringify({ type: 'session', id, cwd, timestamp: '2026-01-01T00:00:00Z' })}\n`;
}

function userTurn(text: string): string {
  return `${JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'text', text }] } })}\n`;
}

describe('scanSessionFiles 缓存', () => {
  it('文件追加后（mtime/size 变化）重扫能看到新内容', async () => {
    const ctx = makeCtx();
    const file = join(tmp, 'a.jsonl');
    await writeFile(file, sessionFrame('s1', tmp) + userTurn('第一问'), 'utf8');

    const first = await scanSessionFiles(ctx);
    expect(first.find((s) => s.sessionId === 's1')?.turns).toBe(1);

    await appendFile(file, userTurn('第二问'), 'utf8');
    const second = await scanSessionFiles(ctx);
    const row = second.find((s) => s.sessionId === 's1');
    expect(row?.turns).toBe(2);
    expect(row?.lastMessage).toBe('第二问');
  });

  it('文件未变时重扫结果一致（命中缓存）', async () => {
    const ctx = makeCtx();
    await writeFile(join(tmp, 'a.jsonl'), sessionFrame('s1', tmp) + userTurn('问题'), 'utf8');
    const first = await scanSessionFiles(ctx);
    const second = await scanSessionFiles(ctx);
    expect(second).toEqual(first);
  });
});
