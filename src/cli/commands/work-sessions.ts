/**
 * `bridge migrate work-sessions`：用历史日志把散落的 OMP 会话段归并回工作会话。
 *
 * 默认 **dry-run**（只打印计划，不碰文件）；`--apply` 才先备份再落盘。核心
 * `runWorkSessionBackfill` 显式接收全部路径参数，不依赖模块级 `paths`，测试可
 * 注入临时目录，绝不触碰真实的 `~/.feishu-omp-bridge`。
 */
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { scanSessionFile } from '../../commands/session/context';
import { paths } from '../../config/paths';
import {
  backfillWorkSessions, parseLogLine, type LogEvent, type SegmentMeta,
} from '../../session/backfill';
import type { WorkSession } from '../../session/work-session';
import { WorkSessionStore, type SessionsFileV2 } from '../../session/work-store';

/** 只认日期日志（`2026-10-11.log`）；`daemon-stdout.log` 等一律忽略。 */
const DATED_LOG = /^\d{4}-\d{2}-\d{2}\.log$/;

export interface WorkSessionBackfillOptions {
  sessionsFile: string;
  logsDir: string;
  ompSessionsDir: string;
  apply: boolean;
  /** 仅用于 CLI 透传（当前回填不需要读 config）；保留在签名里便于将来解析自定义目录。 */
  configPath?: string;
  /** 输出行回调；缺省 `console.log`。测试注入以捕获输出。 */
  out?: (line: string) => void;
}

export interface WorkSessionBackfillResult {
  dryRun: boolean;
  scopes: number;
  workSessions: number;
  orphans: number;
  workSessionIds: string[];
}

/** `YYYYMMDD-HHmmss`（本地时间），用于备份文件名。 */
function timestampStamp(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 读日期日志、逐行解析；不存在的目录 / 不可读文件都不抛，当作没有。 */
async function readLogEvents(logsDir: string): Promise<{ files: number; events: LogEvent[] }> {
  let names: string[];
  try {
    names = await readdir(logsDir);
  } catch {
    return { files: 0, events: [] };
  }
  const dated = names.filter((n) => DATED_LOG.test(n)).sort();
  const events: LogEvent[] = [];
  for (const name of dated) {
    let text: string;
    try {
      text = await readFile(join(logsDir, name), 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      const ev = parseLogLine(line);
      if (ev !== undefined) events.push(ev);
    }
  }
  return { files: dated.length, events };
}

/** 扫 OMP 会话文件头部得到段元数据；缺 id/cwd 的文件跳过。 */
async function readSegments(ompSessionsDir: string): Promise<SegmentMeta[]> {
  let names: string[];
  try {
    names = (await readdir(ompSessionsDir)).filter((n) => n.endsWith('.jsonl'));
  } catch {
    return [];
  }
  const out: SegmentMeta[] = [];
  for (const name of names) {
    const path = join(ompSessionsDir, name);
    try {
      const [text, info] = await Promise.all([readFile(path, 'utf8'), stat(path)]);
      const { meta } = scanSessionFile(text);
      if (!meta?.id || !meta.cwd) continue;
      const parsed = meta.timestamp ? Date.parse(meta.timestamp) : NaN;
      out.push({
        sessionId: meta.id,
        cwd: meta.cwd,
        startedAtMs: Number.isNaN(parsed) ? info.mtimeMs : parsed,
        lastActiveAtMs: info.mtimeMs,
      });
    } catch {
      continue;
    }
  }
  return out;
}

function renderTree(scope: string, list: WorkSession[], active: string | undefined, out: (l: string) => void): void {
  list.sort((a, b) => a.createdAtMs - b.createdAtMs);
  out(`${scope}（当前工作会话 = ${active ?? '无'}）`);
  list.forEach((ws, i) => {
    const branch = i === list.length - 1 ? '└' : '├';
    const title = ws.title?.trim() ? ws.title.trim() : '(未命名)';
    out(`  ${branch} ${ws.id}  「${title}」  ${ws.segments.length} 段`);
  });
  out('');
}

/**
 * 回填工作会话。返回统计；失败抛错（文件缺失不算失败——见下）。
 */
export async function runWorkSessionBackfill(
  opts: WorkSessionBackfillOptions,
): Promise<WorkSessionBackfillResult> {
  const out = opts.out ?? ((line: string): void => console.log(line));
  const dryRun = !opts.apply;

  let raw: string;
  try {
    raw = await readFile(opts.sessionsFile, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    out(`没有会话文件: ${opts.sessionsFile}`);
    out('（先启动过一次 bridge 生成 sessions.json，再回来回填）');
    return { dryRun, scopes: 0, workSessions: 0, orphans: 0, workSessionIds: [] };
  }

  let sourceVersion: 1 | 2 = 1;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && 'v' in parsed && parsed.v === 2) {
      sourceVersion = 2;
    }
  } catch {
    // 坏 JSON：store.load 会兜底重置；这里按 v1 备份，保留原始字节。
  }

  // persist:false —— 读盘（含 v1→v2 迁移）只进内存，dry-run 绝不写盘。
  const store = new WorkSessionStore(opts.sessionsFile);
  await store.load({ persist: false });
  const base: SessionsFileV2 = store.snapshot();

  const log = await readLogEvents(opts.logsDir);
  const segments = await readSegments(opts.ompSessionsDir);
  const merged = backfillWorkSessions(base, log.events, segments);

  const wsBySegment = new Map<string, WorkSession>();
  for (const ws of Object.values(merged.workSessions)) {
    for (const seg of ws.segments) wsBySegment.set(seg.sessionId, ws);
  }
  let orphans = 0;
  for (const seg of segments) {
    if (wsBySegment.get(seg.sessionId)?.scope === null) orphans += 1;
  }

  if (dryRun) out('（dry-run，不写盘；加 --apply 落盘）');
  out('');
  out(`当前文件: ${opts.sessionsFile} (v${sourceVersion})`);
  out(`日志: ${opts.logsDir}（${log.files} 个文件 / ${log.events.length} 条可用事件）`);
  out(`会话文件: ${segments.length} 个（${segments.length - orphans} 个有归属、${orphans} 个无归属）`);
  out('');

  const byScope = new Map<string, WorkSession[]>();
  const unscoped: WorkSession[] = [];
  for (const ws of Object.values(merged.workSessions)) {
    if (ws.scope === null) {
      unscoped.push(ws);
      continue;
    }
    const list = byScope.get(ws.scope) ?? [];
    list.push(ws);
    byScope.set(ws.scope, list);
  }
  for (const [scope, list] of byScope) {
    renderTree(scope, list, merged.scopes[scope]?.activeWorkSession, out);
  }
  out('无归属（日志覆盖不到，各自 1 条）');
  out(unscoped.length > 0 ? `  └ ${unscoped.map((w) => w.id).join(' / ')}` : '  └ （无）');
  out('');

  if (opts.apply) {
    const backupPath = `${opts.sessionsFile}.bak-${timestampStamp(new Date())}`;
    await writeFile(backupPath, raw, 'utf8');
    if (sourceVersion === 1) await writeFile(`${opts.sessionsFile}.v1.bak`, raw, 'utf8');
    store.importSnapshot(merged);
    await store.flush();
    out(`写盘: 备份 ${backupPath}，然后写 v2`);
  }

  return {
    dryRun,
    scopes: Object.keys(merged.scopes).length,
    workSessions: Object.keys(merged.workSessions).length,
    orphans,
    workSessionIds: Object.keys(merged.workSessions),
  };
}

export interface MigrateWorkSessionsCliOptions {
  apply?: boolean;
  sessions?: string;
  logs?: string;
  ompSessions?: string;
  config?: string;
}

/** CLI 入口：把缺省路径解析成 opts，交给核心。 */
export async function runMigrateWorkSessionsCli(opts: MigrateWorkSessionsCliOptions): Promise<void> {
  await runWorkSessionBackfill({
    sessionsFile: opts.sessions ?? paths.sessionsFile,
    logsDir: opts.logs ?? join(paths.appDir, 'logs'),
    ompSessionsDir: opts.ompSessions ?? paths.ompSessionsDir,
    apply: opts.apply === true,
    ...(opts.config !== undefined ? { configPath: opts.config } : {}),
  });
}
