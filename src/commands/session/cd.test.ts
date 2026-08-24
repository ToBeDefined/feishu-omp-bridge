import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import type { CommandContext } from '../index';
import { tryHandleCommand } from '../index';
import { resolveTarget } from './cd';

let root: string;
let base: string;
let sibling: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cd-test-'));
  base = join(root, 'proj');
  await mkdir(join(base, 'src'), { recursive: true });
  sibling = join(root, 'other');
  await mkdir(sibling, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function makeCtx(cwd: string): {
  ctx: CommandContext;
  setCwd: Mock;
  clear: Mock;
  interrupt: Mock;
  sent: string[];
} {
  const setCwd = vi.fn();
  const clear = vi.fn();
  const interrupt = vi.fn();
  const sent: string[] = [];
  const ctx = {
    channel: {
      send: async (_chatId: string, payload: { markdown?: string }) => {
        sent.push(payload.markdown ?? '');
      },
    } as never,
    msg: {
      content: '',
      chatId: 'oc_1',
      messageId: 'om_1',
      senderId: 'ou_1',
    } as never,
    scope: 'oc_1',
    chatMode: 'p2p',
    sessions: { clear } as never,
    workspaces: { cwdFor: () => cwd, setCwd } as never,
    agent: {} as never,
    activeRuns: { interrupt } as never,
    controls: { cfg: { preferences: { access: { admins: [] } } } } as never,
  } as CommandContext;
  return { ctx, setCwd, clear, interrupt, sent };
}

describe('resolveTarget', () => {
  it('resolves plain relative paths against cwd', () => {
    expect(resolveTarget('src', '/home/proj')).toBe('/home/proj/src');
  });

  it('resolves ./ and nested relative paths', () => {
    expect(resolveTarget('./src', '/home/proj')).toBe('/home/proj/src');
    expect(resolveTarget('a/b/c', '/base')).toBe('/base/a/b/c');
  });

  it('resolves .. relative to cwd', () => {
    expect(resolveTarget('../x', '/home/proj/sub')).toBe('/home/proj/x');
  });

  it('keeps absolute paths and normalizes .. inside them', () => {
    expect(resolveTarget('/a/b', '/home/proj')).toBe('/a/b');
    expect(resolveTarget('/a/b/../c', '/home/proj')).toBe('/a/c');
  });

  it('expands ~ and ~/ to $HOME', () => {
    expect(resolveTarget('~', '/home/proj')).toBe(homedir());
    expect(resolveTarget('~/x', '/home/proj')).toBe(resolve(homedir(), 'x'));
  });

  it('falls back to $HOME when cwd is unset', () => {
    expect(resolveTarget('src', undefined)).toBe(resolve(homedir(), 'src'));
    expect(resolveTarget('../x', undefined)).toBe(resolve(homedir(), '../x'));
  });
});

describe('/cd', () => {
  it('switches to a relative path under the current cwd', async () => {
    const { ctx, setCwd, clear, interrupt, sent } = makeCtx(base);
    ctx.msg.content = '/cd src';
    await expect(tryHandleCommand(ctx)).resolves.toBe(true);
    expect(setCwd).toHaveBeenCalledWith('oc_1', join(base, 'src'));
    expect(clear).toHaveBeenCalledWith('oc_1');
    expect(interrupt).toHaveBeenCalledWith('oc_1');
    expect(sent.join('\n')).toContain('已切换');
  });

  it('resolves .. relative to the current cwd', async () => {
    const { ctx, setCwd } = makeCtx(base);
    ctx.msg.content = '/cd ../other';
    await tryHandleCommand(ctx);
    expect(setCwd).toHaveBeenCalledWith('oc_1', sibling);
  });

  it('keeps absolute paths unchanged', async () => {
    const { ctx, setCwd } = makeCtx(base);
    ctx.msg.content = `/cd ${base}`;
    await tryHandleCommand(ctx);
    expect(setCwd).toHaveBeenCalledWith('oc_1', base);
  });

  it('rejects a relative path that is not a directory', async () => {
    const file = join(base, 'readme.md');
    await writeFile(file, 'x');
    const { ctx, setCwd, clear, sent } = makeCtx(base);
    ctx.msg.content = '/cd readme.md';
    await tryHandleCommand(ctx);
    expect(setCwd).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
    expect(sent.join('\n')).toContain('路径不是目录');
  });

  it('reports a non-existent relative path without switching', async () => {
    const { ctx, setCwd, clear, sent } = makeCtx(base);
    ctx.msg.content = '/cd nosuch';
    await tryHandleCommand(ctx);
    expect(setCwd).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
    expect(sent.join('\n')).toContain('路径不存在');
  });

  it('shows usage on empty input', async () => {
    const { ctx, setCwd, sent } = makeCtx(base);
    ctx.msg.content = '/cd';
    await tryHandleCommand(ctx);
    expect(setCwd).not.toHaveBeenCalled();
    expect(sent.join('\n')).toContain('用法');
  });
});
