import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { getSecret, listSecretIds, removeSecret, setSecret } from '../../config/keystore';

/**
 * `secrets` CLI surface. Two intended consumers:
 *
 * 1. Humans: `feishu-omp-bridge secrets set/list/remove` to manage the
 *    encrypted keystore manually.
 *
 * 2. lark-cli (and any other tool implementing openclaw's exec-provider
 *    protocol): `feishu-omp-bridge secrets get` reads a JSON-RPC request
 *    from stdin and writes the decrypted secret to stdout. This is what
 *    `accounts.app.secret = { source: "exec", ... }` resolves through when
 *    lark-cli binds against ~/.feishu-omp-bridge/config.json.
 */

interface ExecRequest {
  protocolVersion?: number;
  provider?: string;
  ids?: string[];
}

interface ExecResponseValue {
  protocolVersion: number;
  values: Record<string, string>;
  errors?: Record<string, { message: string }>;
}

const PROTOCOL_VERSION = 1;

/**
 * exec-provider 请求形状校验：必须是**非 null、非数组的 JSON 对象**。
 * stdin 为字面 `null`、`[]`、数字或字符串时 JSON.parse 并不报错，但直接
 * 取 `req.ids` 会对 null 抛 TypeError、对数组/标量产生垃圾行为 —— 这里
 * 统一拦下，让调用方走 exit(2) 分支。纯函数，便于测试。
 */
export function isValidExecRequest(value: unknown): value is ExecRequest {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * `secrets get` — exec-provider protocol mode.
 *
 * Reads a JSON object from stdin:
 *   { "protocolVersion": 1, "provider": "<name>", "ids": ["app-cli_xxx", ...] }
 *
 * Writes a JSON object to stdout:
 *   { "protocolVersion": 1, "values": { "app-cli_xxx": "..." } }
 *
 * Missing entries land in `errors` rather than `values` — caller decides.
 * Process exits 0 on a successful protocol exchange (even with per-id
 * errors). Non-zero exit means we couldn't parse stdin or the keystore
 * file itself is broken.
 */
export async function runSecretsGet(): Promise<void> {
  const input = await readAllStdin();
  let parsed: unknown;
  try {
    parsed = JSON.parse(input || '{}');
  } catch (err) {
    console.error(`secrets get: invalid stdin JSON: ${(err as Error).message}`);
    process.exit(2);
  }
  // 字面 `null` 等标量能通过 JSON.parse，但不是合法请求 —— 统一按
  // 「stdin JSON 非法」处理，exit(2)。
  if (!isValidExecRequest(parsed)) {
    console.error('secrets get: invalid stdin JSON: expected a JSON object');
    process.exit(2);
  }
  const req = parsed;
  const ids = req.ids ?? [];
  const resp: ExecResponseValue = {
    protocolVersion: PROTOCOL_VERSION,
    values: {},
  };
  for (const id of ids) {
    try {
      const v = await getSecret(id);
      if (v !== undefined) {
        resp.values[id] = v;
      } else {
        (resp.errors ??= {})[id] = { message: 'not found' };
      }
    } catch (err) {
      (resp.errors ??= {})[id] = { message: (err as Error).message };
    }
  }
  process.stdout.write(`${JSON.stringify(resp)}\n`);
}

export async function runSecretsSet(appId: string | undefined): Promise<void> {
  if (!appId) {
    console.error('用法: feishu-omp-bridge secrets set --app-id <id>');
    process.exit(1);
  }
  const id = `app-${appId}`;
  const plaintext = await promptPassword(`输入 ${appId} 的 App Secret: `);
  if (!plaintext) {
    console.error('✗ 取消(secret 为空)');
    process.exit(1);
  }
  await setSecret(id, plaintext);
  console.log(`✓ 已加密存到 ~/.feishu-omp-bridge/secrets.enc`);
}

export async function runSecretsList(): Promise<void> {
  const ids = await listSecretIds();
  if (ids.length === 0) {
    console.log('当前没有加密存储的 secret。');
    return;
  }
  console.log(`# 当前共 ${ids.length} 个 secret 在加密存储里\n`);
  for (const id of ids) {
    console.log(`  - ${id}`);
  }
}

export async function runSecretsRemove(appId: string | undefined): Promise<void> {
  if (!appId) {
    console.error('用法: feishu-omp-bridge secrets remove --app-id <id>');
    process.exit(1);
  }
  const id = `app-${appId}`;
  const removed = await removeSecret(id);
  if (!removed) {
    console.error(`✗ 没找到 secret: ${id}`);
    process.exit(1);
  }
  console.log(`✓ 已删除 ${id}`);
}

// ────────────────────────────────────────────────────────────

async function readAllStdin(): Promise<string> {
  if (process.stdin.isTTY) return ''; // no input piped
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

/**
 * Read a line from stdin without echoing it to the terminal. Mute the
 * output stream during input so the secret never appears on screen / in
 * scroll-back. Falls back to plain readline for non-TTY input.
 */
async function promptPassword(prompt: string): Promise<string> {
  const isTTY = Boolean(process.stdin.isTTY);
  return new Promise((resolve) => {
    const muted = new Writable({
      write(_chunk: Buffer | string, _enc, cb) {
        // Only suppress AFTER the prompt has been written. We let the
        // initial prompt through by writing it ourselves below, then
        // swallow everything else.
        cb();
      },
    });
    process.stdout.write(prompt);
    const rl = createInterface({
      input: process.stdin,
      output: isTTY ? muted : process.stdout,
      terminal: isTTY,
    });
    rl.question('', (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer.trim());
    });
  });
}
