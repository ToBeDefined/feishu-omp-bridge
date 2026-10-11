import { spawnSync } from 'node:child_process';
import { readAndPrune, resolveTarget, isAlive } from '../../runtime/registry';
import { getServiceAdapter, type ServiceAdapter } from '../../daemon/service-adapter';
import { formatAgo } from '../../utils/time';

/**
 * Pretty-print the list of running feishu-omp-bridge processes.
 *
 * `readAndPrune` drops dead entries but does not persist the pruned state —
 * fine for a read-only view. Persistence happens on the next `register` /
 * `unregister` / `updateEntry` call.
 */
export function runPs(): void {
  const live = readAndPrune();
  if (live.length === 0) {
    console.log('当前没有 bot 在运行。');
    return;
  }
  console.log(`# 当前共 ${live.length} 个 bot 在运行\n`);
  const rows = live.map((e, idx) => {
    const ago = formatAgo(Date.now() - new Date(e.startedAt).getTime());
    const app = e.botName ? `${e.botName} (${e.appId})` : e.appId;
    return {
      idx: String(idx + 1),
      id: e.id,
      pid: String(e.pid),
      app,
      started: ago,
      version: e.version,
    };
  });
  const headers = { idx: '#', id: 'ID', pid: 'PID', app: 'Bot', started: '启动', version: '版本' };
  printTable([headers, ...rows]);
}

/**
 * 从 daemon 适配器解析「服务管理器当前托管的进程 pid」。
 * 服务定义不存在 / 未在运行 / 状态文本里没有 pid —— 一律返回 undefined，
 * 调用方应退回裸 kill 路径。
 */
export function findManagedPid(adapter: ServiceAdapter): number | undefined {
  if (!adapter.fileExists() || !adapter.isRunning()) return undefined;
  try {
    const pid = adapter.parseStatus(adapter.describeStatus()).pid;
    if (pid === undefined) return undefined;
    const n = Number.parseInt(pid, 10);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 目标 pid 是否属于托管进程树。三种形态都能命中：
 *   - launchd 直启 node / systemd MainPID：targetPid === managedPid；
 *   - macOS supervisor app：launchd 的 pid 是 supervisor，bridge node 是
 *     它的子进程 —— 沿 ppid 向上找托管 pid；
 *   - schtasks：任务进程是 launcher .cmd，node 是子进程。
 * `parentOf` 注入以便测试；实现里用 `ps -o ppid=`。
 */
export function inManagedTree(
  targetPid: number,
  managedPid: number,
  parentOf: (pid: number) => number | undefined,
): boolean {
  if (targetPid === managedPid) return true;
  let current = targetPid;
  // 有界深度：防 ppid 成环（沙盒/容器里可能出现）导致死循环。
  for (let depth = 0; depth < 16; depth++) {
    const parent = parentOf(current);
    if (parent === undefined || parent <= 1) return false;
    if (parent === managedPid) return true;
    current = parent;
  }
  return false;
}

/** `ps -o ppid= -p <pid>` 查父进程；失败 / 非 POSIX 平台返回 undefined。 */
function parentPid(pid: number): number | undefined {
  try {
    const r = spawnSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' });
    if (r.status !== 0 || r.error) return undefined;
    const n = Number.parseInt((r.stdout ?? '').trim(), 10);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  } catch {
    return undefined;
  }
}

export async function runKillCli(target: string | undefined): Promise<void> {
  if (!target) {
    console.error('用法: feishu-omp-bridge kill <bot id 或序号>');
    process.exit(1);
  }
  const entry = resolveTarget(target);
  if (!entry) {
    console.error(`✗ 没找到匹配的 bot:${target}`);
    console.error('  用 `feishu-omp-bridge ps` 看可选目标。');
    process.exit(1);
  }
  console.log(`正在关闭 bot ${entry.id}…`);
  // KeepAlive 陷阱：若目标进程由 launchd/systemd/schtasks 托管，裸
  // kill 之后服务管理器会立刻把它拉活，这里却报「已关闭」——假象。先问
  // daemon 适配器：目标是否就是托管进程（或托管进程的后代）？是则改走
  // 服务管理器 stop + waitUntilStopped，输出才与事实一致。非托管（前台
  // run、别的用户的进程）维持原逻辑。
  const adapter = getServiceAdapter();
  if (adapter) {
    const managedPid = findManagedPid(adapter);
    if (managedPid !== undefined && inManagedTree(entry.pid, managedPid, parentPid)) {
      console.log(`  目标由 ${adapter.platformName} 托管，改用服务管理器关闭…`);
      const r = await adapter.stop();
      if (!r.ok) {
        console.error(`✗ 关闭失败：${r.stderr.trim()}`);
        process.exit(1);
      }
      // stop 在 OS 层是异步生效的（launchd bootout 尤其），必须等到真正
      // 停下才能如实报告成功。
      const stopped = await adapter.waitUntilStopped(5000);
      if (!stopped) {
        console.error('✗ 5 秒内服务未停止。请检查 launchctl / systemctl 状态，');
        console.error('  或用 `feishu-omp-bridge unregister` 清理服务注册后重试。');
        process.exit(1);
      }
      console.log(`✓ 已关闭 bot ${entry.id}。`);
      return;
    }
  }
  try {
    process.kill(entry.pid, 'SIGTERM');
  } catch (err) {
    console.error(`✗ 关闭失败:${(err as Error).message}`);
    process.exit(1);
  }
  // Poll for up to 2s; SIGKILL as last resort. 100ms poll keeps the wait
  // tight on quick exits without spamming kill(0).
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (!isAlive(entry.pid)) {
      console.log(`✓ 已关闭 bot ${entry.id}。`);
      return;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  console.warn('⚠️ 2 秒内没退出,强制关闭。');
  try {
    process.kill(entry.pid, 'SIGKILL');
  } catch (err) {
    console.error(`✗ 强制关闭失败:${(err as Error).message}`);
    process.exit(1);
  }
}


/** Minimal fixed-width table. Header row is index 0. */
function printTable(rows: Record<string, string>[]): void {
  if (rows.length === 0) return;
  const headerRow = rows[0];
  if (!headerRow) return;
  const cols = Object.keys(headerRow);
  const widths: Record<string, number> = {};
  for (const col of cols) {
    widths[col] = Math.max(...rows.map((r) => displayWidth(r[col] ?? '')));
  }
  for (const r of rows) {
    const line = cols
      .map((c) => padEndDisplay(r[c] ?? '', widths[c] ?? 0))
      .join('  ');
    console.log(line);
  }
}

function displayWidth(s: string): number {
  // Approximate — CJK chars take 2 cells. Avoids pulling in wcwidth.
  let w = 0;
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    w += code > 0x2e80 ? 2 : 1;
  }
  return w;
}

function padEndDisplay(s: string, target: number): string {
  const pad = target - displayWidth(s);
  return pad > 0 ? s + ' '.repeat(pad) : s;
}
