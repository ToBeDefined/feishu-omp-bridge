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
import { intakeMessage } from './intake';

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

  it('a context-resetting command (/new, /cd, /ws) drops queued messages', async () => {
    for (const cmd of ['/new', '/reset', '/cd', '/ws']) {
      vi.clearAllMocks();
      const deps = makeDeps();
      deps.msg = makeMsg(cmd);
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
