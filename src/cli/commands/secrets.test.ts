import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// keystore 全部桩掉：协议层测试不碰加密存储。
const h = vi.hoisted(() => ({ getSecret: vi.fn<(id: string) => Promise<string | undefined>>() }));
vi.mock('../../config/keystore', () => ({
  getSecret: h.getSecret,
  setSecret: vi.fn(async () => {}),
  removeSecret: vi.fn(async () => true),
  listSecretIds: vi.fn(async () => []),
}));

import { isValidExecRequest, runSecretsGet } from './secrets';

/** 把 stdin 换成一次性可读流（readAllStdin 消费 data/end/error 事件）。 */
function stubStdin(content: string): void {
  const stream = new Readable({ read() {} });
  stream.push(content);
  stream.push(null); // EOF
  Object.defineProperty(process, 'stdin', { value: stream, configurable: true });
}

/** process.exit 桩：记录退出码并抛哨兵，模拟真实 exit 的「到此为止」语义。 */
function exitThrows(): number[] {
  const codes: number[] = [];
  vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
    codes.push(Number(code ?? 0));
    throw new Error(`__process_exit_${code ?? 0}__`);
  }) as unknown as () => never);
  return codes;
}

const realStdin = Object.getOwnPropertyDescriptor(process, 'stdin');

beforeEach(() => {
  h.getSecret.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  if (realStdin) Object.defineProperty(process, 'stdin', realStdin);
  vi.restoreAllMocks();
});

describe('isValidExecRequest', () => {
  it('字面 null / 数组 / 标量全部拒绝', () => {
    expect(isValidExecRequest(null)).toBe(false);
    expect(isValidExecRequest(undefined)).toBe(false);
    expect(isValidExecRequest([])).toBe(false);
    expect(isValidExecRequest('null')).toBe(false);
    expect(isValidExecRequest(42)).toBe(false);
    expect(isValidExecRequest(true)).toBe(false);
  });

  it('非空 JSON 对象接受（ids 可有可无）', () => {
    expect(isValidExecRequest({})).toBe(true);
    expect(isValidExecRequest({ protocolVersion: 1, provider: 'bridge', ids: ['app-x'] })).toBe(
      true,
    );
  });
});

describe('runSecretsGet', () => {
  it.each(['null', '[]', '42', '"x"', 'true'])(
    'stdin=%s 通过 JSON.parse 但不是请求对象 → exit(2)',
    async (input) => {
      stubStdin(input);
      const codes = exitThrows();

      await expect(runSecretsGet()).rejects.toThrow('__process_exit_2__');

      expect(codes).toEqual([2]);
    },
  );

  it('回退缺陷：stdin 为字面 null 不再炸出 TypeError，而是走 exit(2)', async () => {
    stubStdin('null');
    const codes = exitThrows();

    await expect(runSecretsGet()).rejects.toThrow('__process_exit_2__');

    expect(codes).toEqual([2]);
  });

  it('stdin 不是 JSON → 照旧 exit(2)', async () => {
    stubStdin('not json{');
    const codes = exitThrows();

    await expect(runSecretsGet()).rejects.toThrow('__process_exit_2__');

    expect(codes).toEqual([2]);
  });

  it('合法请求走正常协议回包：values 命中、缺失进 errors、零退出', async () => {
    stubStdin('{"protocolVersion":1,"provider":"bridge","ids":["app-a","app-b"]}');
    h.getSecret.mockImplementation(async (id: string) =>
      id === 'app-a' ? 's3cr3t' : undefined,
    );
    const written: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    }) as unknown as typeof process.stdout.write);

    await runSecretsGet(); // 不应触发 exit

    const resp = JSON.parse(written.join('')) as {
      protocolVersion: number;
      values: Record<string, string>;
      errors?: Record<string, { message: string }>;
    };
    expect(resp.protocolVersion).toBe(1);
    expect(resp.values).toEqual({ 'app-a': 's3cr3t' });
    expect(resp.errors?.['app-b']?.message).toContain('not found');
  });
});
