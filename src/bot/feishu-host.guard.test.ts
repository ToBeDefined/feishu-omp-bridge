import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import { createFeishuHostIntegration, type FeishuHostContext } from './feishu-host';
import { paths } from '../config/paths';

const origApp = paths.appDir;
const origMedia = paths.mediaDir;
const dirs: string[] = [];

async function sandbox(): Promise<{ appDir: string; mediaDir: string; work: string }> {
  const appDir = await mkdtemp(join(tmpdir(), 'app-'));
  const mediaDir = join(appDir, 'media');
  const work = await mkdtemp(join(tmpdir(), 'work-'));
  await mkdir(mediaDir, { recursive: true });
  dirs.push(appDir, work);
  (paths as { appDir: string }).appDir = appDir;
  (paths as { mediaDir: string }).mediaDir = mediaDir;
  return { appDir, mediaDir, work };
}

function ctxFor(work: string): FeishuHostContext {
  return {
    cwd: work,
    chatId: 'oc_1',
    messageId: 'om_1',
    agentName: 'OMP',
    isChatAllowed: () => true,
  } as unknown as FeishuHostContext;
}

/** 只取 send_file 工具的 execute（不触发任何网络：校验在发送之前）。 */
function sendFileExecute(ctx: FeishuHostContext): (args: Record<string, unknown>) => Promise<unknown> {
  const integration = createFeishuHostIntegration({} as never, ctx);
  const tool = integration.tools.find((t) => t.definition.name === 'feishu_send_file')!;
  return (args) => tool.execute(args as never) as Promise<unknown>;
}

afterEach(async () => {
  (paths as { appDir: string }).appDir = origApp;
  (paths as { mediaDir: string }).mediaDir = origMedia;
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

describe('feishu_send_file 的路径守卫', () => {
  it('拒绝应用私有文件（凭据/会话），即使 cwd 就是 $HOME 也一样', async () => {
    const { appDir } = await sandbox();
    // 三个真实存在的私有文件：凭据 / 配置 / 会话（都不该被外发）
    const privates = ['secrets.enc', 'config.json', 'sessions.json'].map((n) => join(appDir, n));
    for (const p of privates) await writeFile(p, 'PRIVATE', 'utf8');
    // 模拟「cwd 回退成 $HOME」：cwd 取 appDir 的父目录 ⇒ appDir 落在可发送根之内。
    const exec = sendFileExecute(ctxFor(join(appDir, '..')));
    for (const p of privates) {
      await expect(exec({ path: p })).rejects.toThrow(/私有文件/);
    }
  });

  it('跟随符号链接：指向 secrets.enc 的「媒体缓存里的图片」仍被拒', async () => {
    const { appDir, mediaDir } = await sandbox();
    const secret = join(appDir, 'secrets.enc');
    await writeFile(secret, 'SECRET', 'utf8');
    const sneaky = join(mediaDir, 'sneaky.png');
    await symlink(secret, sneaky);
    const exec = sendFileExecute(ctxFor(appDir));
    await expect(exec({ path: sneaky })).rejects.toThrow(/私有文件|工作目录之外/);
  });

  it('工作目录与媒体缓存里的真实文件仍然放行（不进网络：到上传前一步）', async () => {
    const { mediaDir, work } = await sandbox();
    const inWork = join(work, 'a.txt');
    await writeFile(inWork, 'ok', 'utf8');
    const cached = join(mediaDir, 'pic.png');
    await writeFile(cached, 'PNG', 'utf8');
    const exec = sendFileExecute(ctxFor(work));
    // 放行 ⇒ 不会抛“私有文件/工作目录之外”，而是走到上传（fake channel 会报别的错）。
    for (const p of [inWork, cached]) {
      const err = await exec({ path: p }).then(
        () => undefined,
        (e: Error) => e,
      );
      expect(String(err?.message ?? '')).not.toMatch(/私有文件|工作目录之外/);
    }
  });
});

describe('按 messageId 的工具也要过 allowedChats', () => {
  const excluded = 'oc_excluded';

  function ctxWithAllowlist(work: string): FeishuHostContext {
    return {
      cwd: work,
      chatId: 'oc_allowed',
      replyToMessageId: 'om_self',
      agentName: 'OMP',
      // 当前会话允许，另一个群里被排除
      isChatAllowed: (id: string) => id === 'oc_allowed',
    } as unknown as FeishuHostContext;
  }

  function fakeChannel(ownerChatId: string): LarkChannel {
    return {
      rawClient: {
        im: {
          v1: {
            message: {
              get: async () => ({ data: { items: [{ chat_id: ownerChatId, msg_type: 'text', body: { content: '{}' } }] } }),
              delete: async () => ({ data: {} }),
            },
            messageReaction: { create: async () => ({ data: { reaction_id: 'r1' } }) },
          },
        },
      },
      send: async () => {},
    } as unknown as LarkChannel;
  }

  it('get_message / recall / reply 指向被排除会话的消息时被拒；本会话消息放行', async () => {
    const work = await mkdtemp(join(tmpdir(), 'work-'));
    dirs.push(work);
    const ctx = ctxWithAllowlist(work);

    // 被排除的会话：三个工具都要拒
    for (const name of ['feishu_get_message', 'feishu_recall_message', 'feishu_add_reaction']) {
      const integration = createFeishuHostIntegration(fakeChannel(excluded), ctx);
      const tool = integration.tools.find((t) => t.definition.name === name)!;
      await expect(tool.execute({ messageId: 'om_other' } as never)).rejects.toThrow(/不允许操作该会话/);
    }
    // 本会话（触发消息）免检：不进校验，走到真实调用
    const integration = createFeishuHostIntegration(fakeChannel('oc_allowed'), ctx);
    const getTool = integration.tools.find((t) => t.definition.name === 'feishu_get_message')!;
    const err = await getTool.execute({ messageId: 'om_other' } as never).then(() => undefined, (e: Error) => e);
    expect(String(err?.message ?? '')).not.toMatch(/不允许操作该会话/);
  });
});
