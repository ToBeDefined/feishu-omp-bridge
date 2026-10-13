import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { paths } from '../config/paths';
import { log } from '../core/logger';
import { compactCard, restartCard } from './templates';

interface ManagedEntry {
  cardId: string;
  sequence: number;
}

/**
 * What the card was for. Recorded so the next boot can decide how to finish
 * it: a `/restart` card must become「重启完成」, a streaming reply must keep
 * its content and be marked interrupted, etc.
 */
export type RunningCardKind = 'stream' | 'release' | 'restart' | 'compact' | 'form';

/**
 * Card left in-flight when the process died. `card` is the LAST rendered
 * snapshot — Feishu's message-get API only returns a card reference
 * ("请升级至最新版本客户端"), never the content, so the content must be
 * persisted locally to survive a restart.
 */
interface PersistedRunningCard {
  messageId: string;
  /** Empty for streaming cards (they patch via the message API, not cardkit). */
  cardId: string;
  chatId: string;
  kind: RunningCardKind;
  card?: object;
  /** How many times a boot has already failed to finalize this leftover. */
  attempts?: number;
  /** 退避到期时间（ISO）：到期前不再尝试补卡。 */
  nextAttemptAt?: string;
}

// Module-local because state is per-process. Lost on restart, which is fine —
// a new run of /account will mint a fresh card.
const byMessageId = new Map<string, ManagedEntry>();

/**
 * messageIds whose card can be left mid-flight (streaming replies, progress
 * cards, forms). ONLY these are snapshotted to disk — fire-and-forget info
 * cards complete within one request and need no crash recovery, so tracking
 * them would just accumulate dead entries.
 */
const tracked = new Set<string>();

export interface ManagedCardSendResult {
  messageId: string;
  cardId: string;
}

/**
 * Create a CardKit 2.0 card instance and send a message that references it.
 * Returns both ids; we keep them in a module-local map so future cardAction
 * events can update the card by its messageId.
 *
 * If `replyTo` is provided, posts via im.v1.message.reply so the card threads
 * under the user's triggering message; otherwise posts as a top-level chat
 * message via im.v1.message.create.
 */
/**
 * 飞书大量错误是 **HTTP 200 + 非 0 `code`** 返回的（实测：`9499 Invalid parameter value: Sequence`、
 * `200800 create universal card fail`）。只看「有没有抛异常」会把失败当成功 —— 于是兜底永远不触发，
 * 用户看到的就是「点了没反应 / 卡片停在旧内容」。所有卡片调用都必须过这一关。
 */
export function assertApiOk(res: unknown, step: string, fields: Record<string, unknown> = {}): void {
  const code = (res as { code?: unknown } | null | undefined)?.code;
  if (code === undefined || code === 0) return;
  const msg = (res as { msg?: unknown }).msg;
  const err = new Error(`card api ${step} failed: code ${String(code)} ${String(msg)}`);
  log.fail('card', err, { step, code, ...fields });
  throw err;
}

/** 这张卡最近的 CardKit sequence（跨进程承接用：新进程要发 > 它的序号）。 */
/**
 * CardKit 的 `sequence` 必须**严格大于**卡片实体当前的值：等于会被静默忽略（HTTP 200 + `code:0`，
 * 但卡面一动不动），过小还会被拒（`300317`）。实测：同一实体 `sequence=1` 无变化、`sequence=2`
 * 立刻生效 —— 因为 `card.create` 已经占用了 1，而我们从 1 开始数 → **每张卡的第一次更新都空转**。
 * 毫秒时间戳超出 int32（`9499 Invalid parameter value: Sequence`），所以用「秒」做基准：
 * 跨进程单调、永不等于 1、且长期留在 int32 内。
 */
let seqFloor = 0;
export function freshSequence(last?: number): number {
  const now = Math.floor(Date.now() / 1000);
  seqFloor = Math.max(seqFloor + 1, now, (last ?? 0) + 1);
  return seqFloor;
}

/**
 * 每张卡已用过的最大 sequence 的水位（跨进程有效）。
 *
 * CardKit 的 `sequence` 是**实体级严格递增**：低于实体已用值的更新要么被拒
 * （`300317`），要么更糟 —— HTTP 200 + `code 0` 却**不生效**。进程重启后若从
 * `now` 重新起算，就可能落到水位之下，表现为「点了没反应/闪回旧页」。
 * 所以水位必须落盘，且下一次取 `max(now, 水位 + 1)`。
 */
interface SeqWatermark {
  [cardId: string]: number;
}

function watermarkPath(): string {
  return join(dirname(paths.sessionsFile), 'card-sequences.json');
}

function loadWatermarks(): SeqWatermark {
  try {
    const raw = readFileSync(watermarkPath(), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as SeqWatermark) : {};
  } catch {
    return {};
  }
}

function saveWatermarks(map: SeqWatermark): void {
  try {
    writeFileSync(watermarkPath(), `${JSON.stringify(map)}\n`, 'utf8');
  } catch (err) {
    log.warn('card', 'sequence-watermark-write-failed', { err: String(err) });
  }
}

/** 该卡已知的最高序号（含历史进程写下的）。 */
export function sequenceWatermark(cardId: string): number {
  return loadWatermarks()[cardId] ?? 0;
}

function rememberSequence(cardId: string, sequence: number): void {
  const map = loadWatermarks();
  if ((map[cardId] ?? 0) >= sequence) return;
  map[cardId] = sequence;
  // 只保留最近的若干张卡，避免文件无限增长。
  const keys = Object.keys(map);
  if (keys.length > 200) {
    for (const key of keys.slice(0, keys.length - 200)) delete map[key];
  }
  saveWatermarks(map);
}

export function managedSequence(messageId: string): number | undefined {
  return byMessageId.get(messageId)?.sequence;
}

export async function sendManagedCard(
  channel: LarkChannel,
  chatId: string,
  card: object,
  replyTo?: string,
  opts: { track?: boolean; kind?: RunningCardKind } = {},
): Promise<ManagedCardSendResult> {
  const created = await channel.rawClient.cardkit.v1.card.create({
    data: { type: 'card_json', data: JSON.stringify(card) },
  });
  const cardId = (created as { data?: { card_id?: string } }).data?.card_id;
  if (!cardId) {
    throw new Error(`cardkit.card.create returned no card_id: ${JSON.stringify(created).slice(0, 200)}`);
  }

  const content = JSON.stringify({ type: 'card', data: { card_id: cardId } });
  let messageId: string | undefined;
  if (replyTo) {
    const sent = await channel.rawClient.im.v1.message.reply({
      path: { message_id: replyTo },
      data: { msg_type: 'interactive', content },
    });
    messageId = (sent as { data?: { message_id?: string } }).data?.message_id;
  } else {
    const sent = await channel.rawClient.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: chatId, msg_type: 'interactive', content },
    });
    messageId = (sent as { data?: { message_id?: string } }).data?.message_id;
  }
  if (!messageId) {
    throw new Error('send card-by-reference returned no message_id');
  }

  byMessageId.set(messageId, { cardId, sequence: 0 });
  // 诊断（file-only）：卡片消息与卡片实体的对应关系，排查「更新了却看不到变化」时用。
  log.debug('card', 'managed-registered', { messageId, cardId });
  if (opts.track) {
    tracked.add(messageId);
    void upsertRunningCard({ messageId, cardId, chatId, kind: opts.kind ?? 'form', card });
  }
  // ponytail: cap at 200; streaming run cards don't use this map. Forms
  // forget on settle; leftovers are abandoned clicks / agent cards.
  if (byMessageId.size > 200) {
    const oldest = byMessageId.keys().next().value;
    if (oldest) byMessageId.delete(oldest);
  }
  return { messageId, cardId };
}

/**
 * Update a managed card identified by the messageId of the message that
 * carries it. Auto-increments and tracks the per-card sequence so updates
 * can't be reordered or rejected by the cardkit server.
 */
export async function updateManagedCard(
  channel: LarkChannel,
  messageId: string,
  card: object,
): Promise<void> {
  const entry = byMessageId.get(messageId);
  if (!entry) {
    throw new Error(`no managed card registered for message ${messageId}`);
  }
  entry.sequence = freshSequence(Math.max(entry.sequence, sequenceWatermark(entry.cardId)));
  const payload = JSON.stringify(card);
  // 诊断：卡片自报的页标记（/history 这类分页卡的「第 N-M 个」），一眼看出发的是哪一页。
  const marker = /第 \d+-\d+ 个/.exec(payload)?.[0];
  log.debug('card', 'managed-update-sent', {
    messageId,
    cardId: entry.cardId,
    sequence: entry.sequence,
    chars: payload.length,
    ...(marker ? { marker } : {}),
  });
  try {
    const res = await channel.rawClient.cardkit.v1.card.update({
      path: { card_id: entry.cardId },
      data: { card: { type: 'card_json', data: payload }, sequence: entry.sequence },
    });
    assertApiOk(res, 'managed-update', { cardId: entry.cardId, seq: entry.sequence });
    // 有些失败是「HTTP 200 + code 0，但 data 里带一段说明」——原样留证。
    log.debug('card', 'managed-update-result', {
      messageId,
      sequence: entry.sequence,
      res: JSON.stringify(res).slice(0, 200),
    });
  } catch (err) {
    log.fail('card', err, { step: 'managed-update', cardId: entry.cardId, seq: entry.sequence });
    throw err;
  }
  rememberSequence(entry.cardId, entry.sequence);
  log.debug('card', 'managed-updated', {
    messageId,
    cardId: entry.cardId,
    sequence: entry.sequence,
    chars: payload.length,
    ...(marker ? { marker } : {}),
  });
  if (tracked.has(messageId)) void snapshotThrottled(messageId, card);
}

/** Drop the mapping; call after the card is recalled or the flow ends. */
/** 把一张**已存在**的卡片消息认领进托管表（消息内容已指向 cardId 的卡片实体）。
 *  用于「卡片不在托管表里」时的补救路径：新建实体 → 改写消息引用 → 认领登记，
 *  这样后续点击继续走 CardKit 原地更新，而不是每次都重发。 */
export function adoptManagedCard(messageId: string, cardId: string): void {
  byMessageId.set(messageId, { cardId, sequence: 0 });
}

export function forgetManagedCard(messageId: string): void {
  byMessageId.delete(messageId);
  tracked.delete(messageId);
  lastSnapshotAt.delete(messageId);
  void removeFromRunningCards(messageId);
}

/**
 * Cap on tracked in-flight cards. Must cover peak concurrency: every
 * concurrent run (maxConcurrentRuns, default 10) can hold one streaming card,
 * plus release/restart/OMP-form cards. 50 was pure headroom — 15 covers the
 * default with margin while keeping the file tiny (entries are ~2KB typical,
 * ≤26KB by the pagination budget).
 */
const RUNNING_CARDS_MAX = 15;

/** Minimum gap between snapshot writes for one card (ms). */
const SNAPSHOT_MIN_INTERVAL_MS = 2000;

/** Per-card write throttle: a burst of updates must not rewrite the whole
 * file each time. */
const lastSnapshotAt = new Map<string, number>();

function snapshotThrottled(messageId: string, card: object): Promise<void> | false {
  const now = Date.now();
  if (now - (lastSnapshotAt.get(messageId) ?? 0) < SNAPSHOT_MIN_INTERVAL_MS) return false;
  lastSnapshotAt.set(messageId, now);
  return updateRunningCardSnapshot(messageId, card);
}

async function readRunningCards(): Promise<PersistedRunningCard[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(paths.runningCardsFile, 'utf8'));
    return Array.isArray(parsed) ? (parsed as PersistedRunningCard[]) : [];
  } catch {
    return [];
  }
}

/**
 * 串行化「读—改—写」整段：只串行 write 不够 —— 两个读改写交错时，后写的会覆盖前写
 * 的结果。实测过的坑：`rememberStreamingCard` 紧跟 `forgetStreamingCard`（一次**成功**
 * 回合的正常收尾）时，forget 的 read 赶在 remember 的 write 之前 → 读到空文件 → 跳过
 * 写 → remember 的记录残留下来，下次启动的兜底会给这张**已完成**的卡片补上「进程中断，
 * 以上为已输出的部分内容」。
 */
let cardsChain: Promise<void> = Promise.resolve();

function mutateRunningCards<T>(fn: () => Promise<T>): Promise<T> {
  const run = (): Promise<T> => fn();
  const result = cardsChain.then(run, run);
  cardsChain = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function writeRunningCards(list: PersistedRunningCard[]): Promise<void> {
  // 调用方必须在 mutateRunningCards(cardsChain) 内；这里只负责落盘。
  // tmp + rename 原子替换：链外的读者（测试断言、崩溃恢复扫描）直接
  // readFile，非原子写会让它们看到 truncate 后的空文件。
  const tmp = `${paths.runningCardsFile}.${process.pid}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(list.slice(-RUNNING_CARDS_MAX)), 'utf8');
    await rename(tmp, paths.runningCardsFile);
  } catch (err) {
    log.warn('card', 'running-cards-persist-failed', { err: String(err) });
  }
}

/** Insert or replace the entry for a card still in flight. */
function upsertRunningCard(entry: PersistedRunningCard): Promise<void> {
  return mutateRunningCards(async () => {
    const list = await readRunningCards();
    const next = [...list.filter((c) => c.messageId !== entry.messageId), entry];
    await writeRunningCards(next);
  });
}

/** Refresh the persisted snapshot for one card (called on every render). */
function updateRunningCardSnapshot(messageId: string, card: object): Promise<void> {
  return mutateRunningCards(async () => {
    const list = await readRunningCards();
    const entry = list.find((c) => c.messageId === messageId);
    if (!entry) return;
    entry.card = card;
    await writeRunningCards(list);
  });
}

function removeFromRunningCards(messageId: string): Promise<void> {
  return mutateRunningCards(async () => {
    const list = await readRunningCards();
    const next = list.filter((c) => c.messageId !== messageId);
    if (next.length !== list.length) await writeRunningCards(next);
  });
}

/**
 * Called once at boot: cards still in-flight from the previous process are
 * finalized according to their KIND —
 *   restart → 「🚀 重启完成」(the restart we were asked to perform finished)
 *   stream  → replay the last snapshot minus running chrome + interruption note
 *   release → 「⚠️ 发布被中断」
 *   compact → 「❌ 压缩失败」(the oneshot compactor died with the process)
 *   form    → 「此卡片已过期」
 * Returns true when a `/restart` card was finalized (the caller then skips the
 * separate「已上线」text notice).
 */
export async function finalizeInterruptedCards(
  channel: LarkChannel,
  excludeMessageId?: string,
): Promise<boolean> {
  const leftovers = await readRunningCards();
  const retry: PersistedRunningCard[] = [];
  let finalizedRestart = false;
  for (const entry of leftovers) {
    const { messageId, kind, card } = entry;
    // Cards claimed by the boot-notice marker are finished by the caller
    // instead (the new process confirms /release and /restart themselves).
    if (messageId === excludeMessageId) continue;
    if (!messageId || messageId === 'om_sent' || !messageId.startsWith('om_')) continue;
    // 退避未到期：保留记录但不外呼（崩溃循环里每 10s 一次 patch 会拖垮机器）。
    if (entry.nextAttemptAt && Date.parse(entry.nextAttemptAt) > Date.now()) {
      retry.push(entry);
      continue;
    }
    if (await deliverInterruptCard(channel, messageId, kind, card)) {
      if (kind === 'restart') finalizedRestart = true;
      continue;
    }
    // 补不上就**留着**：这张卡还停在运行态（带 ⏹ 终止按钮），记录的寿命必须跟着
    // 它 —— 从前这里无论成败都清空记录，于是补卡被飞书拒一次，那个终止按钮就永
    // 远挂在那里了。但也**不能无限外呼**：launchd 每 10s 拉起一次，若补卡永远被拒
    // （消息被撤回/删除、token 失效），每 10s 一次 patch 会把机器拖垮。所以失败
    // 累加 attempts，超过上限后转入**一小时退避**：记录保留（⏹ 仍有救回的希望），
    // 但期间不再外呼。真正不可救（消息已删）时这一步不会更差。
    retry.push(noteFinalizeFailure(entry));
  }
  await mutateRunningCards(() => writeRunningCards(retry));
  return finalizedRestart;
}

/** 补卡失败一次：attempts 累加；超过上限后转一小时退避（记录保留、停止外呼）。 */
function noteFinalizeFailure(entry: PersistedRunningCard): PersistedRunningCard {
  const attempts = (entry.attempts ?? 0) + 1;
  if (attempts > INTERRUPT_FINALIZE_MAX_ATTEMPTS) {
    const nextAttemptAt = new Date(Date.now() + INTERRUPT_FINALIZE_BACKOFF_MS).toISOString();
    log.warn('card', 'interrupted-finalize-backoff', {
      messageId: entry.messageId,
      kind: entry.kind,
      attempts,
      nextAttemptAt,
    });
    return { ...entry, attempts, nextAttemptAt };
  }
  return { ...entry, attempts };
}

/** Boots that may try to patch one leftover card before we give up on it.
 *  Bounds外呼: a card we can never patch (recalled message, dead token) must
 *  not trigger one failed patch per launchd retry forever. */
const INTERRUPT_FINALIZE_MAX_ATTEMPTS = 3;
/** 超过补卡重试上限后的退避时长：保留记录但停止频繁外呼。 */
const INTERRUPT_FINALIZE_BACKOFF_MS = 60 * 60 * 1000;

/** Feishu rejects a card patch past ~30KB (ErrCode 200800 / HTTP 400). */
const CARD_PATCH_MAX_BYTES = 28 * 1024;

/**
 * 把一张遗留的运行态卡片补成终态。优先保留已输出的内容（`finalizeByKind`），
 * 但**超长卡片必被飞书拒**（正是 400 的常见来源），所以放不下 / 被拒时退回一张
 * 极小终态卡：此处唯一重要的是让用户看不到一个永远不消失的 ⏹。
 */
async function deliverInterruptCard(
  channel: LarkChannel,
  messageId: string,
  kind: RunningCardKind,
  card: object | undefined,
): Promise<boolean> {
  const pretty = finalizeByKind(kind, card);
  const fits = Buffer.byteLength(JSON.stringify(pretty), 'utf8') <= CARD_PATCH_MAX_BYTES;
  if (fits && (await patchCardWithRetry(channel, messageId, pretty))) {
    log.info('card', 'interrupted-finalized', { messageId, kind, hadSnapshot: Boolean(card) });
    return true;
  }
  if (await patchCardWithRetry(channel, messageId, finalizeByKind(kind, undefined))) {
    log.info('card', 'interrupted-finalized-short', { messageId, kind, fits });
    return true;
  }
  return false;
}

// 更新失败只做**两次** 1s 重试（用户定的策略）：限频/5xx 往往是瞬时抖动，等太久
// 反而让用户看着卡住。三次尝试仍失败就落到「降级收尾/巡检」那条路，绝不无限重试。
const PATCH_RETRY_DELAYS_MS = [1000, 1000] as const;
const PATCH_RETRY_MAX = PATCH_RETRY_DELAYS_MS.length;

function patchErrorCode(err: unknown): string {
  if (!err || typeof err !== 'object') return String(err);
  const response = 'response' in err ? err.response : undefined;
  const data = response && typeof response === 'object' && 'data' in response ? response.data : undefined;
  return `${JSON.stringify(data ?? err)} ${String(err)}`;
}

function retryablePatchError(err: unknown): boolean {
  const response = err && typeof err === 'object' && 'response' in err ? err.response : undefined;
  const status =
    response && typeof response === 'object' && 'status' in response
      ? Number((response as { status?: unknown }).status)
      : undefined;
  const data = response && typeof response === 'object' && 'data' in response ? response.data : undefined;
  const code =
    data && typeof data === 'object' && 'code' in data ? Number((data as { code?: unknown }).code) : undefined;
  // 结构化优先：限频（230020）与网关/服务端 5xx 才值得等；4xx 里除限频外都是
  // 「内容被拒」（11310/200800…），重试同内容只会白等 31 秒。
  if (code === 230020 || code === 500 || code === 502 || code === 503 || code === 504) return true;
  if (status !== undefined && (status === 500 || status === 502 || status === 503 || status === 504)) return true;
  const text = patchErrorCode(err);
  // 字符串兜底必须锚定形状：早先用裸 `includes('500')` 会把错误体里随便出现的
  // 数字（token 计数等）当成可重试。
  return (
    /"code"\s*:\s*(230020|500|502|503|504)\b/.test(text) ||
    /status code (500|502|503|504)\b/.test(text) ||
    /ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up|timed? ?out/i.test(text)
  );
}

export async function patchCardWithRetry(channel: LarkChannel, messageId: string, card: object): Promise<boolean> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await channel.rawClient.im.v1.message.patch({
        path: { message_id: messageId },
        data: { content: JSON.stringify(card) },
      });
      assertApiOk(res, 'patch', { messageId });
      return true;
    } catch (err) {
      if (!retryablePatchError(err) || attempt >= PATCH_RETRY_MAX) {
        log.warn('card', 'interrupted-finalize-failed', { messageId, err: String(err) });
        return false;
      }
      const delay = PATCH_RETRY_DELAYS_MS[attempt]!;
      log.debug('card', 'terminal-patch-retry', { messageId, attempt: attempt + 1, delayMs: delay });
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
  }
}

/** Terminal card for a leftover entry, by kind. */
export function finalizeByKind(kind: RunningCardKind, card: object | undefined): object {
  if (kind === 'restart') return restartCard('done');
  if (kind === 'release') return noteCard('⚠️ **发布被中断，进程在构建/重启期间退出。**');
  if (kind === 'compact') {
    return compactCard({ phase: 'failed', error: '进程在压缩期间退出，压缩未完成。' });
  }
  if (kind === 'form') return noteCard('_⚠️ 此卡片已过期，请使用最新发出的卡片。_');
  return card
    ? stripRunningState(card)
    : noteCard('⚠️ **进程中断，本条回复未完成**');
}

function noteCard(content: string): object {
  return {
    schema: '2.0',
    config: { update_multi: true },
    body: { elements: [{ tag: 'markdown', content }] },
  };
}

/**
 * Replay a persisted card with running-state chrome removed: stop buttons and
 * the status footer row go away, and an interruption note is appended. All
 * content the user already saw is kept.
 */
export function stripRunningState(card: object): object {
  const elements = (card as { body?: { elements?: unknown[] } }).body?.elements;
  const list = Array.isArray(elements) ? elements : [];
  const dropped = new Set<number>();
  list.forEach((el, i) => {
    if (!isRunningStateElement(el)) return;
    dropped.add(i);
    // 控制区（状态 + ⏹）上方那条 `hr` 是**它自己的**分隔线（见 run-renderer 的
    // 运行态拼装）。控制行被剥掉后它就成了悬空线，和下面补的中断注记 `---` 叠成
    // 双线 —— 一并去掉。只认紧邻上方那一条：正文自己的 hr 不动。
    const above = i > 0 ? list[i - 1] : undefined;
    if (typeof above === 'object' && above !== null && 'tag' in above && above.tag === 'hr') {
      dropped.add(i - 1);
    }
  });
  const kept = list.filter((_el, i) => !dropped.has(i));
  // 卡片已经处于**终态**（有内容，且没有任何运行态元素被剥掉）时不要再贴
  // 「进程中断」：run 已经跑完、只是崩溃恢复记录没来得及删的卡片，贴上去就是
  // 误报（用户看到一条完整的回复被标成"中断"）。
  const finished = list.length > 0 && dropped.size === 0;
  if (finished) {
    return { schema: '2.0', config: { update_multi: true }, body: { elements: kept } };
  }
  kept.push({ tag: 'markdown', content: '---', text_size: 'notation' });
  kept.push({
    tag: 'markdown',
    content: '⚠️ **进程中断，以上为已输出的部分内容**',
    text_size: 'notation',
  });
  return { schema: '2.0', config: { update_multi: true }, body: { elements: kept } };
}

/** Stop buttons, their action rows, and the「正在…」footer row. */
function isRunningStateElement(el: unknown): boolean {
  if (typeof el !== 'object' || el === null || !('tag' in el)) return false;
  const tag = String(el.tag);
  if (tag === 'button' || tag === 'action') return true;
  if (tag !== 'column_set') return false;
  const json = JSON.stringify(el);
  return json.includes('"cmd":"stop"') || json.includes('⏹') || /正在(思考|调用工具|输出)/.test(json);
}

/**
 * Register a streaming reply card (created via channel.stream) for crash
 * recovery. Streaming cards patch via the message API, so cardId stays empty.
 */
export function rememberStreamingCard(messageId: string, chatId: string, card?: object): void {
  if (!messageId) return;
  void upsertRunningCard({ messageId, cardId: '', chatId, kind: 'stream', ...(card ? { card } : {}) });
}

/** Refresh a streaming card's persisted snapshot (called on every render). */
export function snapshotStreamingCard(messageId: string, card: object): void {
  void updateRunningCardSnapshot(messageId, card);
}

/** 等所有在途的 running-cards 读改写排空（测试与优雅关停用）。 */
export function runningCardsSettled(): Promise<void> {
  return cardsChain;
}

/** Remove a streaming card from the crash-recovery persistence. */
export function forgetStreamingCard(messageId: string): void {
  void removeFromRunningCards(messageId);
}
