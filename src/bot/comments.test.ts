import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommentEvent, LarkChannel } from '@larksuiteoapi/node-sdk';
import type { AgentAdapter, AgentRun } from '../agent/types';
import type { AppConfig } from '../config/schema';
import type { SessionStore } from '../session/store';
import type { WorkspaceStore } from '../workspace/store';
import { handleCommentMention } from './comments';
import { resetCommentDedup } from './comment-dedup';

interface RecordedRequest {
  method?: string;
  url?: string;
  data?: unknown;
}

function makeChannel(requests: RecordedRequest[]): LarkChannel {
  return {
    rawClient: {
      request: async (req: RecordedRequest) => {
        requests.push(req);
        return {};
      },
      wiki: {
        v2: {
          space: {
            getNode: async () => {
              throw new Error('not a wiki node');
            },
          },
        },
      },
      drive: {
        v1: {
          fileComment: {
            get: async () => ({
              data: {
                reply_list: {
                  replies: [
                    {
                      reply_id: 'r1',
                      content: {
                        elements: [{ type: 'text_run', text_run: { text: '@bot 帮我看看' } }],
                      },
                    },
                  ],
                },
                quote: 'quoted',
                is_whole: false,
              },
            }),
          },
        },
      },
    },
  } as unknown as LarkChannel;
}

function makeAgent(answer: string): AgentAdapter {
  return {
    id: 'fake',
    displayName: 'Fake',
    isAvailable: async () => true,
    run: (): AgentRun => ({
      events: (async function* () {
        yield { type: 'text', delta: answer } as const;
        yield { type: 'done' } as const;
      })(),
      stop: async () => {},
      waitForExit: async () => true,
    }),
  };
}

function makeEvt(partial: Partial<CommentEvent> = {}): CommentEvent {
  return {
    fileToken: 'dox_1',
    fileType: 'docx',
    commentId: 'cmt_1',
    replyId: 'r1',
    mentionedBot: true,
    operator: { openId: 'ou_1' },
    ...partial,
  } as unknown as CommentEvent;
}

function makeDeps(channel: LarkChannel, agent: AgentAdapter) {
  return {
    channel,
    evt: makeEvt(),
    agent,
    sessions: {
      sessionFor: () => undefined,
      bind: () => {},
    } as unknown as SessionStore,
    workspaces: { cwdFor: () => '/repo', setCwd: () => {} } as unknown as WorkspaceStore,
    cfg: {} as AppConfig,
  };
}

beforeEach(() => resetCommentDedup());
describe('handleCommentMention', () => {
  it('posts the agent answer back as a comment reply', async () => {
    const requests: RecordedRequest[] = [];
    await handleCommentMention(makeDeps(makeChannel(requests), makeAgent('答案在这里')));

    const reply = requests.find((req) => req.url?.includes('/replies?'));
    expect(reply).toBeDefined();
    expect(JSON.stringify(reply?.data)).toContain('答案在这里');
  });

  it('ignores a comment that does not mention the bot', async () => {
    const requests: RecordedRequest[] = [];
    const deps = makeDeps(makeChannel(requests), makeAgent('never'));
    deps.evt = makeEvt({ mentionedBot: false });

    await handleCommentMention(deps);
    expect(requests).toEqual([]);
  });

  it('skips a second mention in the same doc while one is in flight', async () => {
    const requests: RecordedRequest[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = vi.fn(
      (): AgentRun => ({
        events: (async function* () {
          await gate;
          yield { type: 'done' } as const;
        })(),
        stop: async () => {},
        waitForExit: async () => true,
      }),
    );
    const agent = { ...makeAgent(''), run } as unknown as AgentAdapter;

    const first = handleCommentMention(makeDeps(makeChannel(requests), agent));
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    // Two concurrent @-mentions in one doc would resume the same session jsonl.
    await handleCommentMention(makeDeps(makeChannel(requests), agent));
    expect(run).toHaveBeenCalledTimes(1);

    release();
    await first;
  });

  it('stops the agent run when the event stream throws', async () => {
    const stop = vi.fn(async () => {});
    const agent = {
      ...makeAgent(''),
      run: vi.fn((): AgentRun => ({
        events: (async function* () {
          throw new Error('stream failed');
        })(),
        stop,
        waitForExit: async () => true,
      })),
    } as unknown as AgentAdapter;

    await expect(handleCommentMention(makeDeps(makeChannel([]), agent))).rejects.toThrow('stream failed');
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('posts one in-flight notice for a second event in the same doc', async () => {
    const requests: RecordedRequest[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = vi.fn(
      (): AgentRun => ({
        events: (async function* () {
          await gate;
          yield { type: 'done' } as const;
        })(),
        stop: async () => {},
        waitForExit: async () => true,
      }),
    );
    const agent = { ...makeAgent(''), run } as unknown as AgentAdapter;
    const channel = makeChannel(requests);
    const firstDeps = makeDeps(channel, agent);
    const secondDeps = makeDeps(channel, agent);
    secondDeps.evt = makeEvt({ commentId: 'cmt_2', replyId: 'r2' });

    const first = handleCommentMention(firstDeps);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    await handleCommentMention(secondDeps);
    const notices = requests.filter((req) => JSON.stringify(req.data).includes('正在处理中'));
    expect(notices).toHaveLength(1);
    expect(run).toHaveBeenCalledTimes(1);

    release();
    await first;
  });

  it('does not rerun an identical event delivered sequentially', async () => {
    const run = vi.fn(() => ({
      events: (async function* () {
        yield { type: 'done' } as const;
      })(),
      stop: async () => {},
      waitForExit: async () => true,
    }));
    const agent = { ...makeAgent('答案'), run } as unknown as AgentAdapter;
    const channel = makeChannel([]);
    const deps = makeDeps(channel, agent);

    await handleCommentMention(deps);
    await handleCommentMention(deps);
    expect(run).toHaveBeenCalledTimes(1);
  });
 });
