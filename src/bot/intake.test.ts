import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedMessage } from '@larksuiteoapi/node-sdk';

const {
  tryHandleCommand,
  addReaction,
  buildPrompt,
  fetchQuotedContext,
  isUserAllowed,
  isChatAllowed,
  getRequireMentionInGroup,
} = vi.hoisted(() => ({
  tryHandleCommand: vi.fn(),
  addReaction: vi.fn(),
  buildPrompt: vi.fn((msg: unknown[]) => `prompt:${(msg[0] as { content?: string })?.content ?? ''}`),
  fetchQuotedContext: vi.fn(async () => undefined),
  isUserAllowed: vi.fn(() => true),
  isChatAllowed: vi.fn(() => true),
  getRequireMentionInGroup: vi.fn(() => false),
}));

vi.mock('../commands', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../commands')>();
  return { ...actual, tryHandleCommand };
});
vi.mock('../config/schema', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config/schema')>();
  return {
    ...actual,
    isUserAllowed,
    isChatAllowed,
    getRequireMentionInGroup,
  };
});
vi.mock('./reaction', () => ({ addReaction }));
vi.mock('./prompt', () => ({ buildPrompt }));
vi.mock('./quote', () => ({ fetchQuotedContext }));

import type { IntakeDeps } from './intake';
import { intakeMessage, messageIdSeen, rememberMessageId, resetSeenMessageIds } from './intake';

function makeMsg(content: string, overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    content,
    chatId: 'oc_1',
    messageId: 'om_1',
    senderId: 'ou_1',
    senderName: 'tester',
    chatType: 'p2p',
    rawContentType: 'text',
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: false,
    createTime: 0,
    ...overrides,
  } as NormalizedMessage;
}

function makeDeps(overrides: Partial<IntakeDeps> = {}): IntakeDeps {
  return {
    channel: {} as never,
    agent: {} as never,
    sessions: {} as never,
    workspaces: {} as never,
    activeRuns: {
      has: vi.fn(() => false),
      submitPrompt: vi.fn(async () => true),
    } as never,
    media: { resolve: vi.fn(async () => []) } as never,
    pending: { push: vi.fn(() => 1), cancel: vi.fn(() => []) } as never,
    controls: { cfg: {} } as never,
    chatModeCache: { resolve: vi.fn(async () => 'p2p') } as never,
    ...overrides,
  } as IntakeDeps;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetSeenMessageIds();
  tryHandleCommand.mockResolvedValue(false);
  addReaction.mockResolvedValue(undefined);
  isUserAllowed.mockReturnValue(true);
  isChatAllowed.mockReturnValue(true);
  getRequireMentionInGroup.mockReturnValue(false);
});

describe('intakeMessage mid-run routing', () => {
  it('queues an ordinary message even when a run is active (never follow_up)', async () => {
    const deps = makeDeps();
    deps.activeRuns = { has: vi.fn(() => true), submitPrompt: vi.fn(async () => true) } as never;
    deps.msg = makeMsg('hello');

    await intakeMessage(deps);

    expect(deps.pending.push).toHaveBeenCalledWith('oc_1', deps.msg);
    expect(deps.activeRuns.submitPrompt).not.toHaveBeenCalled();
  });

  it('steers an active run for a `!`-prefixed message', async () => {
    const deps = makeDeps();
    const submitPrompt = vi.fn(async () => true);
    deps.activeRuns = { has: vi.fn(() => true), submitPrompt } as never;
    deps.msg = makeMsg('!先不要改代码');

    await intakeMessage(deps);

    expect(submitPrompt).toHaveBeenCalledWith('oc_1', 'steer', expect.stringContaining('!先不要改代码'), []);
    expect(deps.pending.push).not.toHaveBeenCalled();
  });

  it('steer falls back to the queue when no run is active', async () => {
    const deps = makeDeps();
    deps.activeRuns = { has: vi.fn(() => false), submitPrompt: vi.fn(async () => true) } as never;
    deps.msg = makeMsg('!先不要改代码');

    await intakeMessage(deps);

    expect(deps.pending.push).toHaveBeenCalled();
    expect(deps.activeRuns.submitPrompt).not.toHaveBeenCalled();
  });

  it('a non-resetting command does not drop queued messages', async () => {
    const deps = makeDeps();
    deps.msg = makeMsg('/search foo');
    tryHandleCommand.mockResolvedValue(true);

    await intakeMessage(deps);

    expect(deps.pending.cancel).not.toHaveBeenCalled();
    expect(deps.pending.push).not.toHaveBeenCalled();
  });

  it('a context-resetting command (/new, /cd <path>, /ws use) drops queued messages', async () => {
    for (const cmd of ['/new', '/reset', '/cd /repo', '/ws use x']) {
      vi.clearAllMocks();
      resetSeenMessageIds();
      const deps = makeDeps();
      deps.msg = makeMsg(cmd);
      tryHandleCommand.mockResolvedValue(true);

      await intakeMessage(deps);
      expect(deps.pending.cancel).toHaveBeenCalledWith('oc_1');
    }
  });

  it('带目标的 /resume 丢排队消息，不带参数的（= /history 清单）不丢', async () => {
    for (const [content, drops] of [
      ['/resume 019f9432', true],
      ['/session 019f9432', true],
      ['/resume', false],
      ['/session', false],
      // 只读清单类命令也一样不丢。
      ['/history', false],
      ['/s foo', false],
      // 裸 /cd（忘写路径）与只看/管理命名工作空间的 /ws 子命令都不换上下文。
      ['/cd', false],
      ['/cd /repo', true],
      ['/ws', false],
      ['/ws list', false],
      ['/ws save x', false],
      ['/ws use x', true],
      ['/ws undo', true],
    ] as Array<[string, boolean]>) {
      vi.clearAllMocks();
      resetSeenMessageIds();
      const deps = makeDeps();
      deps.msg = makeMsg(content);
      tryHandleCommand.mockResolvedValue(true);

      await intakeMessage(deps);
      expect(deps.pending.cancel).toHaveBeenCalledTimes(drops ? 1 : 0);
    }
  });

  it('starting a new conversation drops queued messages', async () => {
    for (const content of ['/new', '/reset', '/cd /repo']) {
      vi.clearAllMocks();
      resetSeenMessageIds();
      const deps = makeDeps();
      deps.msg = makeMsg(content);
      tryHandleCommand.mockResolvedValue(true);

      await intakeMessage(deps);
      expect(deps.pending.cancel).toHaveBeenCalledWith('oc_1');
    }
  });

  it('silently drops a message from an unauthorized user', async () => {
    isUserAllowed.mockReturnValue(false);
    const deps = makeDeps();
    deps.msg = makeMsg('hello');

    await intakeMessage(deps);

    expect(deps.pending.push).not.toHaveBeenCalled();
    expect(deps.pending.cancel).not.toHaveBeenCalled();
    expect(deps.activeRuns.submitPrompt).not.toHaveBeenCalled();
    expect(addReaction).not.toHaveBeenCalled();
  });

  it('silently drops a non-mention in a strict group', async () => {
    getRequireMentionInGroup.mockReturnValue(true);
    const deps = makeDeps();
    deps.msg = makeMsg('hello', { chatType: 'group', mentionedBot: false });

    await intakeMessage(deps);

    expect(deps.pending.push).not.toHaveBeenCalled();
    expect(addReaction).not.toHaveBeenCalled();
  });

  it('passes image paths when steering an active run', async () => {
    const submitPrompt = vi.fn(async () => true);
    const deps = makeDeps();
    deps.activeRuns = { has: vi.fn(() => true), submitPrompt } as never;
    deps.media = { resolve: vi.fn(async () => [{ kind: 'image', path: '/tmp/a.png' }]) } as never;
    deps.msg = makeMsg('!看图', { resources: [{ type: 'image' }] as never });

    await intakeMessage(deps);

    expect(submitPrompt).toHaveBeenCalledWith(
      'oc_1',
      'steer',
      expect.any(String),
      ['/tmp/a.png'],
    );
    expect(deps.pending.push).not.toHaveBeenCalled();
  });

  it('falls back to the queue when active-run steering fails', async () => {
    const submitPrompt = vi.fn(async () => false);
    const deps = makeDeps();
    deps.activeRuns = { has: vi.fn(() => true), submitPrompt } as never;
    deps.msg = makeMsg('!先不要改代码');

    await intakeMessage(deps);

    expect(deps.pending.push).toHaveBeenCalledWith('oc_1', deps.msg);
    expect(submitPrompt).toHaveBeenCalled();
  });
});

describe('messageId 去重', () => {
  it('同一 messageId 重推只入队一次，不同 messageId 不受影响', async () => {
    const deps1 = makeDeps();
    deps1.msg = makeMsg('hello', { messageId: 'om_dup' });
    await intakeMessage(deps1);
    expect(deps1.pending.push).toHaveBeenCalledTimes(1);

    // WS 抖动重推：同 id 静默丢弃
    const deps2 = makeDeps();
    deps2.msg = makeMsg('hello again', { messageId: 'om_dup' });
    await intakeMessage(deps2);
    expect(deps2.pending.push).not.toHaveBeenCalled();
    expect(addReaction).toHaveBeenCalledTimes(1); // 只有 deps1 那次
    expect(deps2.activeRuns.submitPrompt).not.toHaveBeenCalled();

    // 不同 id 正常入队
    const deps3 = makeDeps();
    deps3.msg = makeMsg('other', { messageId: 'om_other' });
    await intakeMessage(deps3);
    expect(deps3.pending.push).toHaveBeenCalledTimes(1);
  });

  it('去重检查在白名单之前：重复消息即便来自未授权用户也已丢弃', async () => {
    rememberMessageId('om_dup');
    isUserAllowed.mockReturnValue(false);
    const deps = makeDeps();
    deps.msg = makeMsg('hello', { messageId: 'om_dup' });

    await intakeMessage(deps);

    // 走不到白名单检查，不会因为未授权打 skip 日志之外的路径——总之不再入队。
    expect(deps.pending.push).not.toHaveBeenCalled();
  });

  it('rememberMessageId 是有界的：超过 1000 条淘汰最旧', () => {
    resetSeenMessageIds();
    for (let i = 0; i < 1000; i++) rememberMessageId(`om_${i}`, i);
    expect(messageIdSeen('om_0')).toBe(true);
    rememberMessageId('om_1000', 1000);
    expect(messageIdSeen('om_0')).toBe(false);
    expect(messageIdSeen('om_1')).toBe(true);
    expect(messageIdSeen('om_1000')).toBe(true);
    // 重复 remember 已存在的 id：不触发淘汰（只刷新时间戳，插入序不变）
    rememberMessageId('om_1', 999);
    expect(messageIdSeen('om_2')).toBe(true);
    // 新 id 再入：淘汰插入序最旧的 om_1（重复 set 不改变 Map 插入序）
    rememberMessageId('om_1001', 1001);
    expect(messageIdSeen('om_1')).toBe(false);
    expect(messageIdSeen('om_2')).toBe(true);
    resetSeenMessageIds();
  });
});
