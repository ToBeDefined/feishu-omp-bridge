import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runWorkSessionBackfill } from './work-sessions';

let root: string;
let sessionsFile: string;
let logsDir: string;
let ompDir: string;

/** v1 平铺文件：一个 chat + 一条已存在的 OMP 会话。 */
const V1 = `${JSON.stringify({
  oc_A: { sessionId: 'sess-1', cwd: '/repo', createdAt: 1000, updatedAt: 5000, title: '活一' },
}, null, 2)}\n`;

const bind = (ts: number, sessionId: string): string =>
  JSON.stringify({ ts, phase: 'session', event: 'set', chatId: 'oc_A', sessionId });

const sessionJsonl = (id: string, ts: string): string =>
  `${JSON.stringify({ type: 'session', id, cwd: '/repo', timestamp: ts })}\n`;

async function writeFixture(): Promise<void> {
  await writeFile(sessionsFile, V1, 'utf8');
  await writeFile(
    join(logsDir, '2026-10-04.log'),
    [
      bind(1_700_000_000_000, 'sess-1'),
      'not json at all — must be ignored',
      bind(1_700_000_001_000, 'sess-2'),
    ].join('\n'),
    'utf8',
  );
  // Garbage in the daemon log must never affect the backfill (not a dated log).
  await writeFile(join(logsDir, 'daemon-stdout.log'), 'noise\n{"garbage":true}\n', 'utf8');
  await writeFile(join(ompDir, '1700000000_sess-1.jsonl'), sessionJsonl('sess-1', '2026-10-04T00:00:00.000Z'), 'utf8');
  await writeFile(join(ompDir, '1700000100_sess-2.jsonl'), sessionJsonl('sess-2', '2026-10-04T00:01:00.000Z'), 'utf8');
  // sess-3 has no binding in the logs → orphan (scope: null).
  await writeFile(join(ompDir, '1700000200_sess-3.jsonl'), sessionJsonl('sess-3', '2026-10-04T00:02:00.000Z'), 'utf8');
}

async function backupsIn(dir: string): Promise<string[]> {
  return (await readdir(dir)).filter((n) => n.includes('.bak'));
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'work-sessions-cli-'));
  sessionsFile = join(root, 'sessions.json');
  logsDir = join(root, 'logs');
  ompDir = join(root, 'omp-sessions');
  await mkdir(logsDir, { recursive: true });
  await mkdir(ompDir, { recursive: true });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('runWorkSessionBackfill dry-run', () => {
  it('prints the plan, changes no bytes and writes no backup', async () => {
    await writeFixture();
    const lines: string[] = [];
    const res = await runWorkSessionBackfill({
      sessionsFile, logsDir, ompSessionsDir: ompDir, apply: false, out: (l) => lines.push(l),
    });

    expect(res.dryRun).toBe(true);
    expect(res.workSessions).toBe(3);        // sess-1 + sess-2 + orphan sess-3
    expect(res.orphans).toBe(1);
    expect(await readFile(sessionsFile, 'utf8')).toBe(V1);
    expect(await backupsIn(root)).toEqual([]);

    const text = lines.join('\n');
    expect(text).toContain('（dry-run，不写盘；加 --apply 落盘）');
    expect(text).toContain('(v1)');
    expect(text).toContain('（1 个文件 / 2 条可用事件）');   // daemon log + non-JSON ignored
    expect(text).toContain('oc_A（当前工作会话 = sess-1）');
    expect(text).toContain('「活一」');
    expect(text).toContain('└ sess-3');                       // orphan listed
  });
});

describe('runWorkSessionBackfill --apply', () => {
  it('writes v2 and keeps v1 backups with the original bytes', async () => {
    await writeFixture();
    const lines: string[] = [];
    const res = await runWorkSessionBackfill({
      sessionsFile, logsDir, ompSessionsDir: ompDir, apply: true, out: (l) => lines.push(l),
    });

    expect(res.dryRun).toBe(false);
    const onDisk = JSON.parse(await readFile(sessionsFile, 'utf8')) as { v: number; workSessions: Record<string, unknown> };
    expect(onDisk.v).toBe(2);
    expect(Object.keys(onDisk.workSessions).sort()).toEqual(['sess-1', 'sess-2', 'sess-3']);

    const backups = await backupsIn(root);
    const stamp = backups.find((n) => /\.bak-\d{8}-\d{6}$/.test(n));
    expect(stamp).toBeDefined();
    expect(await readFile(join(root, stamp ?? ''), 'utf8')).toBe(V1);   // timestamped backup = original
    expect(backups).toContain('sessions.json.v1.bak');                  // v1 → extra copy
    expect(await readFile(`${sessionsFile}.v1.bak`, 'utf8')).toBe(V1);

    expect(lines.join('\n')).toContain('写盘: 备份');
    // No atomic-write temp file left behind.
    expect((await readdir(root)).some((n) => n.includes('.tmp-'))).toBe(false);
  });

  it('is idempotent: a second --apply leaves identical bytes and output', async () => {
    await writeFixture();
    const first: string[] = [];
    await runWorkSessionBackfill({ sessionsFile, logsDir, ompSessionsDir: ompDir, apply: true, out: (l) => first.push(l) });
    const firstBytes = await readFile(sessionsFile, 'utf8');

    const second: string[] = [];
    await runWorkSessionBackfill({ sessionsFile, logsDir, ompSessionsDir: ompDir, apply: true, out: (l) => second.push(l) });
    const secondBytes = await readFile(sessionsFile, 'utf8');

    expect(secondBytes).toBe(firstBytes);
    // Only run-to-run noise may differ: the backup timestamp, and the source
    // version marker (the first apply upgraded the file from v1 to v2).
    const strip = (ls: string[]): string => ls
      .filter((l) => !l.startsWith('写盘: 备份'))
      .map((l) => l.replace(/\(v[12]\)/, '(v?)'))
      .join('\n');
    expect(strip(second)).toBe(strip(first));
  });
});

describe('runWorkSessionBackfill empty inputs', () => {
  it('reports a missing sessions file without throwing', async () => {
    const lines: string[] = [];
    const res = await runWorkSessionBackfill({
      sessionsFile, logsDir, ompSessionsDir: ompDir, apply: false, out: (l) => lines.push(l),
    });
    expect(res.workSessions).toBe(0);
    expect(lines.join('\n')).toContain('没有会话文件');
    expect(await backupsIn(root)).toEqual([]);
  });

  it('handles missing logs and session dirs with a v2 file present', async () => {
    await writeFile(sessionsFile, JSON.stringify({ v: 2, scopes: {}, workSessions: {} }), 'utf8');
    await rm(logsDir, { recursive: true, force: true });
    await rm(ompDir, { recursive: true, force: true });

    const lines: string[] = [];
    const res = await runWorkSessionBackfill({
      sessionsFile, logsDir, ompSessionsDir: ompDir, apply: false, out: (l) => lines.push(l),
    });

    expect(res.workSessions).toBe(0);
    expect(res.orphans).toBe(0);
    const text = lines.join('\n');
    expect(text).toContain('（0 个文件 / 0 条可用事件）');
    expect(text).toContain('会话文件: 0 个（0 个有归属、0 个无归属）');
    expect(text).toContain('└ （无）');
  });
});
