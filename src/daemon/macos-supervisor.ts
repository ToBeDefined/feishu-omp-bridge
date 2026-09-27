import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from '../config/paths';
import { log } from '../core/logger';

/**
 * macOS 15+ 的「本地网络」(Local Network Privacy) 按**进程身份**放行，而且只在
 * 「用户可见的 app」首次访问时弹窗授权：直接由 launchd 拉起的 `node` 属于
 * 后台 CLI，既弹不出授权框、也不会出现在 设置→隐私与安全性→本地网络 列表里，
 * 于是任何到**同网段**地址的连接都被内核直接拒绝（node: EHOSTUNREACH，
 * Python/ftplib: `[Errno 65] No route to host`），而路由网段和公网不受影响。
 *
 * 后果就是：Feishu 那条链路（launchd → node → omp(bun) → bash → 工具进程）
 * 连不上内网服务（例：FutClient 的 FTP 二进制库 172.18.86.237:21），但用户
 * 在终端里跑同样的命令却没问题 —— 终端 app 早已获得该权限，子进程继承其身份。
 *
 * 解法：给守护进程套一个**有 bundle id、有签名、有 NSLocalNetworkUsageDescription**
 * 的 GUI app（本模块负责在安装/启动时编译并签名），由它作为父进程拉起
 * `node <bridge> run`。这样整棵进程树都归到这个 app 身份下：macOS 会弹一次
 * 授权框，用户点「允许」后，bridge 及其所有工具子进程都能访问本地网络。
 *
 * 编译需要 Xcode Command Line Tools（swiftc）与一个代码签名身份；两者缺失时
 * 直接返回 undefined，调用方回退到原来的直启方式（LAN 仍会被拦，但不影响其它功能）。
 */

export const SUPERVISOR_BUNDLE_ID = 'ai.feishu-omp-bridge.supervisor';
const APP_DIR_NAME = 'FeishuOmpBridge.app';
const EXECUTABLE_NAME = 'FeishuOmpBridgeSupervisor';

export function supervisorAppPath(): string {
  return join(paths.appDir, 'macos', APP_DIR_NAME);
}

export function supervisorExecutablePath(): string {
  return join(supervisorAppPath(), 'Contents', 'MacOS', EXECUTABLE_NAME);
}

/**
 * 已授权标记：授权框成功后由 supervisor 写入。命中后 supervisor 不再弹窗、
 * 不再探测，直接以 accessory（无 Dock 图标/窗口）方式运行守护进程。
 */
export function supervisorGrantMarkerPath(): string {
  return join(paths.appDir, 'macos', 'local-network-granted');
}

const BUILD_STAMP_FILE = '.build-stamp';

/** 设置里的显示名 —— 用户就是照着这个名字在「本地网络」列表里授权。 */
const APP_DISPLAY_NAME = 'Feishu OMP Bridge';

const INFO_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleDevelopmentRegion</key>
	<string>en</string>
	<key>CFBundleDisplayName</key>
	<string>${APP_DISPLAY_NAME}</string>
	<key>CFBundleExecutable</key>
	<string>${EXECUTABLE_NAME}</string>
	<key>CFBundleIdentifier</key>
	<string>${SUPERVISOR_BUNDLE_ID}</string>
	<key>CFBundleInfoDictionaryVersion</key>
	<string>6.0</string>
	<key>CFBundleName</key>
	<string>${APP_DISPLAY_NAME}</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>CFBundleShortVersionString</key>
	<string>1.0</string>
	<key>CFBundleVersion</key>
	<string>1</string>
	<key>LSMinimumSystemVersion</key>
	<string>12.0</string>
	<key>NSHighResolutionCapable</key>
	<true/>
	<key>NSLocalNetworkUsageDescription</key>
	<string>feishu-omp-bridge 需要访问本地网络，以便 OMP 执行的内网命令（例如内部 FTP / GitLab 镜像 / 局域网服务）能够连通。</string>
</dict>
</plist>
`;

/**
 * Swift 版 supervisor：AppKit app，负责
 *  1) 首次运行时探测本机默认路由器（触发/等待 macOS 本地网络授权弹窗），
 *     探测成功后写入 marker 并收起窗口；
 *  2) 以子进程方式运行 `node <bridge> run`，继承 launchd 给的 stdout/stderr；
 *  3) 转发 SIGTERM/SIGINT，并以其退出码退出 —— 保持 launchd 的
 *     RunAtLoad / KeepAlive / kickstart 语义不变。
 *
 * 注意：这里刻意不用 Swift 字符串插值（TS 模板串会吃掉反斜杠），全部用 `+` 拼接。
 */
const SWIFT_SOURCE = `import AppKit
import Foundation
import SystemConfiguration

// usage: FeishuOmpBridgeSupervisor --marker <path> [--probe-seconds <n>] -- <cmd> [args...]
var markerPath = ""
var probeSeconds = 45.0
var childArgs: [String] = []
let argv = CommandLine.arguments
var idx = 1
while idx < argv.count {
    let arg = argv[idx]
    if arg == "--" {
        childArgs = Array(argv[(idx + 1)...])
        break
    }
    if arg == "--marker", idx + 1 < argv.count {
        markerPath = argv[idx + 1]
        idx += 2
        continue
    }
    if arg == "--probe-seconds", idx + 1 < argv.count {
        probeSeconds = Double(argv[idx + 1]) ?? 45.0
        idx += 2
        continue
    }
    idx += 1
}

if childArgs.isEmpty {
    FileHandle.standardError.write("usage: FeishuOmpBridgeSupervisor --marker <path> [--probe-seconds <n>] -- <cmd> [args...]\\n".data(using: .utf8)!)
    exit(64)
}

let granted = !markerPath.isEmpty && FileManager.default.fileExists(atPath: markerPath)

func note(_ message: String) {
    FileHandle.standardError.write(("[supervisor] " + message + "\\n").data(using: .utf8)!)
}

// 默认路由器：同网段探测目标。取不到就跳过探测（不影响子进程启动）。
func defaultRouter() -> String? {
    guard let store = SCDynamicStoreCreate(nil, "feishu-omp-bridge-supervisor" as CFString, nil, nil) else { return nil }
    guard let value = SCDynamicStoreCopyValue(store, "State:/Network/Global/IPv4" as CFString) as? [String: Any] else { return nil }
    return value["Router"] as? String
}

// 到达本地网络 = 连接成功或被拒绝(ECONNREFUSED)；EHOSTUNREACH/ENETUNREACH/EACCES 表示被 LNP 拦住。
func reachesLocalNetwork(_ host: String) -> Bool {
    var addr = sockaddr_in()
    addr.sin_family = sa_family_t(AF_INET)
    addr.sin_port = UInt16(80).bigEndian
    if inet_pton(AF_INET, host, &addr.sin_addr) != 1 { return false }
    let fd = socket(AF_INET, SOCK_STREAM, 0)
    if fd < 0 { return false }
    defer { close(fd) }
    var tv = timeval(tv_sec: 2, tv_usec: 0)
    setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
    let rc = withUnsafePointer(to: &addr) { pointer in
        pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
            Darwin.connect(fd, sa, socklen_t(MemoryLayout<sockaddr_in>.size))
        }
    }
    if rc == 0 { return true }
    return errno == ECONNREFUSED
}

let app = NSApplication.shared
app.setActivationPolicy(granted ? .accessory : .regular)

var window: NSWindow?
if !granted {
    let frame = NSRect(x: 0, y: 0, width: 560, height: 168)
    let w = NSWindow(contentRect: frame, styleMask: [.titled, .closable], backing: .buffered, defer: false)
    w.title = "feishu-omp-bridge 需要「本地网络」权限"
    let text = NSTextField(wrappingLabelWithString: "macOS 默认拦截后台服务的本地网络访问，导致 bridge 里执行的内网命令（FTP / 局域网服务）报 \\"No route to host\\"。\\n\\n请在系统弹窗中点「允许」。若没有弹窗：系统设置 → 隐私与安全性 → 本地网络 → 打开「" + ${JSON.stringify(APP_DISPLAY_NAME)} + "」。\\n\\n授权成功后本窗口会自动关闭。")
    text.frame = NSRect(x: 20, y: 20, width: frame.width - 40, height: frame.height - 40)
    w.contentView?.addSubview(text)
    w.center()
    w.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
    window = w
}

signal(SIGTERM, SIG_IGN)
signal(SIGINT, SIG_IGN)

let child = Process()
child.executableURL = URL(fileURLWithPath: childArgs[0])
child.arguments = Array(childArgs.dropFirst())
child.standardInput = FileHandle.standardInput
child.standardOutput = FileHandle.standardOutput
child.standardError = FileHandle.standardError
child.terminationHandler = { proc in
    if proc.terminationReason == .uncaughtSignal {
        exit(128 + proc.terminationStatus)
    }
    exit(proc.terminationStatus)
}

do {
    try child.run()
} catch {
    note("failed to spawn child: " + String(describing: error))
    exit(69)
}

func onSignal(_ sig: Int32) {
    if child.isRunning { child.terminate() }
    DispatchQueue.global().asyncAfter(deadline: .now() + 8) {
        if child.isRunning { kill(child.processIdentifier, SIGKILL) }
    }
}
let termSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
termSource.setEventHandler { onSignal(SIGTERM) }
termSource.resume()
let intSource = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
intSource.setEventHandler { onSignal(SIGINT) }
intSource.resume()

if !granted {
    DispatchQueue.global().async {
        let deadline = Date().addingTimeInterval(probeSeconds)
        guard let router = defaultRouter() else {
            note("no default router; skipping local network probe")
            return
        }
        while Date() < deadline {
            if reachesLocalNetwork(router) {
                try? "granted\\n".write(toFile: markerPath, atomically: true, encoding: .utf8)
                DispatchQueue.main.async {
                    window?.orderOut(nil)
                    NSApp.setActivationPolicy(.accessory)
                    note("local network access confirmed via " + router)
                }
                return
            }
            Thread.sleep(forTimeInterval: 2)
        }
        note("local network still blocked after " + String(Int(probeSeconds)) + "s; grant it in System Settings > Privacy & Security > Local Network")
    }
}

app.run()
`;

function run(cmd: string, args: string[], cwd?: string): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync(cmd, args, { encoding: 'utf8', cwd });
  return { ok: r.status === 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** 显式表示「不签名」的值（ad-hoc）：声明在意愿上等价于关掉 app 身份。 */
const AD_HOC_IDENTITIES: Record<string, true> = { '-': true, 'ad-hoc': true, adhoc: true, none: true, null: true };

/**
 * 从 `security find-identity -v -p codesigning` 的输出里挑可用的签名身份。
 * 按「有效期长 → 短」偏好排序（Developer ID Application 5 年 > Apple Development
 * 1 年 > Mac Developer），同级保持钥匙串顺序 —— 证书过期会让签名失效，进而丢掉
 * 本地网络授权，所以优先用寿命长的。绝不写死某个具体证书。
 */
export function parseSigningIdentities(output: string): string[] {
  const names = output
    .split('\n')
    .map((line) => line.match(/"([^"]+)"/)?.[1])
    .filter((name): name is string => Boolean(name))
    .filter((name) => /^(Developer ID Application|Apple Development|Mac Developer):/.test(name));
  const rank = (name: string): number => {
    if (name.startsWith('Developer ID Application')) return 0;
    if (name.startsWith('Apple Development')) return 1;
    return 2;
  };
  return names.sort((a, b) => rank(a) - rank(b));
}

/** 选定身份的落盘位置：换证书/证书顺序变化都不会悄悄改签名，避免无谓重新授权。 */
function signIdentityCachePath(): string {
  return join(paths.appDir, 'macos', 'sign-identity');
}

/** 选定结果；identity 为 undefined 表示 ad-hoc 签名。 */
export interface SignChoice {
  /** undefined = ad-hoc 签名（无身份，可能会被 macOS 静默拒绝且无法弹窗）。 */
  identity?: string;
  source: 'env' | 'cache' | 'keychain' | 'none';
}

/**
 * 决定用什么身份签名，优先级：
 *  1. `FOB_MACOS_SIGN_IDENTITY`（显式指定；`-`/`ad-hoc`/`none` 表示 ad-hoc）
 *  2. 上次选定的身份（`~/.feishu-omp-bridge/macos/sign-identity`，仍在钥匙串里才复用）
 *  3. 钥匙串里现有的 codesigning 身份（见 {@link parseSigningIdentities}）
 *  4. 都没有 → ad-hoc，并提示设置 FOB_MACOS_SIGN_IDENTITY
 */
export interface SigningIdentityInputs {
  /** `FOB_MACOS_SIGN_IDENTITY` 的原始值（未设置时 undefined）。 */
  envValue?: string;
  /** `~/.feishu-omp-bridge/macos/sign-identity` 里记录的上次选择。 */
  cached?: string;
  /** 钥匙串里现有的 codesigning 身份，见 {@link parseSigningIdentities}。 */
  keychain: string[];
}

/**
 * 纯函数版选择逻辑（顺序即优先级），便于测试：
 *  env 显式指定（含 ad-hoc 哨兵）> 缓存的身份（仍存在于钥匙串）> 钥匙串第一个 > 无。
 * 缓存优先是为了**稳定**：身份一变，macOS 就当成另一个 app，本地网络授权要重新点。
 */
export function chooseSigningIdentity(inputs: SigningIdentityInputs): SignChoice {
  const explicit = inputs.envValue?.trim();
  if (explicit) {
    if (AD_HOC_IDENTITIES[explicit.toLowerCase()] === true) return { source: 'env' };
    return { identity: explicit, source: 'env' };
  }
  const cached = inputs.cached?.trim();
  if (cached) {
    if (AD_HOC_IDENTITIES[cached.toLowerCase()] === true) return { source: 'cache' };
    if (inputs.keychain.includes(cached)) return { identity: cached, source: 'cache' };
  }
  const [first] = inputs.keychain;
  return first ? { identity: first, source: 'keychain' } : { source: 'none' };
}

function resolveSignIdentity(): SignChoice {
  const listed = run('security', ['find-identity', '-v', '-p', 'codesigning']);
  const choice = chooseSigningIdentity({
    envValue: process.env.FOB_MACOS_SIGN_IDENTITY,
    cached: readPersistedIdentity(),
    keychain: listed.ok ? parseSigningIdentities(listed.stdout) : [],
  });
  if (choice.identity && choice.source !== 'cache') persistIdentity(choice.identity);
  return choice;
}

function readPersistedIdentity(): string | undefined {
  try {
    return readFileSync(signIdentityCachePath(), 'utf8').trim() || undefined;
  } catch {
    return undefined;
  }
}

function persistIdentity(identity: string): void {
  try {
    mkdirSync(join(paths.appDir, 'macos'), { recursive: true });
    writeFileSync(signIdentityCachePath(), `${identity}\n`, 'utf8');
  } catch (err) {
    log.warn('daemon', 'macos-sign-identity-cache-failed', {
      reason: err instanceof Error ? err.message : String(err),
    });
  }
}

function swiftcAvailable(): boolean {
  return run('xcrun', ['--find', 'swiftc']).ok;
}

/**
 * 按需编译 + 签名 supervisor app。返回可执行文件路径；不可用（非 macOS /
 * 无 swiftc / 编译失败）时返回 undefined，由调用方回退到直启。
 * 编译结果按「Swift 源码 + 签名身份」的哈希缓存，重启不会重复编译。
 */
export async function ensureSupervisorApp(): Promise<string | undefined> {
  if (process.platform !== 'darwin') return undefined;
  const { identity, source } = resolveSignIdentity();
  const stamp = createHash('sha256')
    .update(SWIFT_SOURCE)
    .update(INFO_PLIST)
    .update(identity ?? 'ad-hoc')
    .digest('hex');
  const exe = supervisorExecutablePath();
  const stampFile = join(supervisorAppPath(), BUILD_STAMP_FILE);
  if (existsSync(exe) && existsSync(stampFile) && readFileSync(stampFile, 'utf8').trim() === stamp) {
    return exe;
  }
  if (!swiftcAvailable()) {
    log.warn('daemon', 'macos-supervisor-skipped', { reason: 'swiftc not found (install Xcode Command Line Tools)' });
    return undefined;
  }
  try {
    mkdirSync(join(supervisorAppPath(), 'Contents', 'MacOS'), { recursive: true });
    writeFileSync(join(supervisorAppPath(), 'Contents', 'Info.plist'), INFO_PLIST, 'utf8');
    const buildDir = join(paths.appDir, 'macos', 'build');
    mkdirSync(buildDir, { recursive: true });
    const sourcePath = join(buildDir, 'Supervisor.swift');
    writeFileSync(sourcePath, SWIFT_SOURCE, 'utf8');
    const compile = run('xcrun', ['swiftc', '-O', '-o', exe, sourcePath, '-framework', 'AppKit', '-framework', 'SystemConfiguration']);
    if (!compile.ok) throw new Error(`swiftc failed: ${compile.stderr.trim() || 'unknown error'}`);
    chmodSync(exe, 0o755);
    const sign = run('codesign', [
      '--force',
      '--sign',
      identity ?? '-',
      '--identifier',
      SUPERVISOR_BUNDLE_ID,
      supervisorAppPath(),
    ]);
    if (!sign.ok) throw new Error(`codesign failed: ${sign.stderr.trim() || 'unknown error'}`);
    writeFileSync(stampFile, `${stamp}\n`, 'utf8');
    log.info('daemon', 'macos-supervisor-built', {
      executable: exe,
      signedWith: identity ?? 'ad-hoc',
      identitySource: source,
    });
    if (!identity) {
      log.warn('daemon', 'macos-supervisor-adhoc', {
        hint: 'set FOB_MACOS_SIGN_IDENTITY to a keychain codesigning identity (e.g. "Apple Development: you@example.com (XXXXXXXXXX)"); ad-hoc signatures cannot request Local Network access and change on every rebuild',
      });
    }
    return exe;
  } catch (err) {
    log.warn('daemon', 'macos-supervisor-skipped', { reason: err instanceof Error ? err.message : String(err) });
    rmSync(join(supervisorAppPath(), BUILD_STAMP_FILE), { force: true });
    return undefined;
  }
}
