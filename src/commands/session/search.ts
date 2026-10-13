import { homedir } from 'node:os';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getOmpSessionDir } from '../../config/schema';
import { sendManagedCard } from '../../card/managed';
import type { CommandContext, Handler } from '../index';
import { reply, updateOrFallback } from '../shared';
import { extractUserInput, scanSessionFile } from './context';
import { applyResume, listResumableSessions } from './resume';
import {
  searchDetailCard,
  searchDetailText,
  searchEmptyCard,
  searchResultsCard,
  type SearchContext,
  type SearchDetailInfo,
  type SearchHit,
  type SearchHitGroup,
} from '../../card/search-card';

/** Named-workspace label for a cwd, falling back to the path itself. */
export function workspaceLabel(ctx: CommandContext, cwd: string): string {
  for (const [name, path] of Object.entries(ctx.workspaces.listNamed())) {
    if (path === cwd) return name;
  }
  return cwd;
}

/** The scope's current OMP session id, or undefined when the next message
 * would start a fresh conversation. Passed to the cards so the row of the
 * conversation the user is already in gets marked (and stops offering a
 * resume that would be a no-op). */
function currentSessionId(ctx: CommandContext): string | undefined {
  return ctx.sessions.sessionFor(ctx.scope)?.sessionId;
}

/** Card/text payload for one conversation's detail view: the card layer owns
 * the layout, the command only resolves identity + workspace labels. */
export function detailInfoFor(
  context: SearchContext,
  queryId: string,
  index: number,
  opts: { keyword?: string; currentSessionId?: string; offset?: number } = {},
): SearchDetailInfo {
  return {
    sessionId: context.sessionId,
    ...(context.workspace !== undefined ? { workspace: context.workspace } : {}),
    index,
    matchCount: context.matchCount,
    groups: context.groups,
    ...(opts.keyword ? { keyword: opts.keyword } : {}),
    queryRef: `${queryId} ${index}`,
    // 详情卡带回去原结果页的坐标：queryId + 进入时的 offset，返回时复用分页缓存。
    queryId,
    ...(opts.offset !== undefined ? { offset: opts.offset } : {}),
    ...(opts.currentSessionId !== undefined && opts.currentSessionId === context.sessionId
      ? { current: true }
      : {}),
  };
}

export const searchHandlers: Record<string, Handler> = {
  '/search': handleSearch,
  '/s': handleSearch,
};

/** In-memory cache of recent search results, keyed by a short query id. */
const searchCache = new Map<string, SearchContext[]>();
/** Keyword per cached query id, for re-rendering pages of the same search. */
const searchKeywords = new Map<string, string>();
const SEARCH_CACHE_MAX = 20;

/** Extract the real conversational text for a message frame. */
function messageText(msg: {
  role?: string;
  content?: Array<{ type?: string; text?: string }>;
}): SearchHit | null {
  if (!msg?.role) return null;
  const textPart = (msg.content ?? [])
    .filter((c) => c.type === 'text' && c.text)
    .map((c) => c.text ?? '')
    .join('');
  if (!textPart) return null;
  if (msg.role === 'assistant') {
    return { role: 'assistant', content: textPart.trim() };
  }
  if (msg.role === 'user') {
    const real = extractUserInput(textPart);
    return real ? { role: 'user', content: real } : null;
  }
  return null;
}

/** Resolved display + identity of the OMP session a hit belongs to. */
interface SessionIdentity {
  /** OMP session id; a headerless file falls back to its own file name. */
  sessionId: string;
  title?: string;
  topic?: string;
}

/** One session file's matched pairs, before its identity is resolved. */
interface RawHit {
  /** File header's OMP session id, when it had one. */
  sessionId?: string;
  /** JSONL file name — the identity fallback for a headerless file. */
  fileName: string;
  workspace: string;
  /** Newest matching pair in the file — the representative snippet. */
  messages: SearchHit[];
  hitIndex: number;
  /** Matched Q&A pairs in this file. */
  matchCount: number;
}

/** One session file's matched pairs, annotated with its resolved identity. */
interface SessionHit extends SessionIdentity {
  workspace: string;
  /** Newest matching pair in the file — the representative snippet. */
  messages: SearchHit[];
  hitIndex: number;
  /** Matched Q&A pairs in this file. */
  matchCount: number;
}

/**
 * Resolve a session's identity + display name, memoised by session id so a hit
 * is resolved once.
 *
 * Unlike the /status-style helper, this never calls `loadSessionSummary`: both
 * the name (title, zero IO) and the unnamed topic fallback come from the
 * search's OWN scan — `lastUserBySession` supplies the session's last user
 * message. That avoids one full-directory scan per unnamed session. A headerless
 * file is its own conversation (identity = its file name), never named.
 */
async function resolveSessionIdentity(
  ctx: CommandContext,
  sessionId: string | undefined,
  fileName: string,
  cache: Map<string, SessionIdentity>,
  lastUserBySession: ReadonlyMap<string, string>,
): Promise<SessionIdentity> {
  // 一个 OMP 会话 = 一个对话：身份就是会话 id，名字按会话 id 查（/rename）。
  const id = sessionId ?? fileName;
  const cached = cache.get(id);
  if (cached) return cached;
  const title = ctx.sessions.titleFor(id);
  let topic: string | undefined;
  if (title === undefined) {
    topic = lastUserBySession.get(id)?.trim() || undefined;
  }
  const resolved: SessionIdentity = {
    sessionId: id,
    ...(title !== undefined ? { title } : {}),
    ...(topic !== undefined ? { topic } : {}),
  };
  cache.set(id, resolved);
  return resolved;
}

/** Newest message timestamp of a hit, for the newest-first sort. */
function newestHitMs(hit: { messages: SearchHit[] }): number {
  let max = Number.NEGATIVE_INFINITY;
  for (const m of hit.messages) {
    const t = m.timestamp ? Date.parse(m.timestamp) : Number.NaN;
    if (Number.isFinite(t) && t > max) max = t;
  }
  return max;
}

/** Search every session file (across workspaces), returning one context per
 * OMP session (= one conversation): every matched pair in that session collapses
 * under a single heading (the newest pair is the representative snippet,
 * `matchCount` the total across the session). Newest first, capped at `limit`
 * sessions. */
/** 结果上限（按对话数，最新的在前）。**必须大于卡片每页条数**（`SEARCH_PAGE_SIZE`），
 * 否则「下一页」永远取不到东西 —— 上限 6 + 每页 6 时整块分页都渲染不出来。
 * 扫描成本与上限无关（所有 session 文件本来都要读一遍），这里只决定列表长度。 */
export const SEARCH_SESSION_LIMIT = 30;

export async function searchSession(
  keyword: string,
  ctx: CommandContext,
  limit = SEARCH_SESSION_LIMIT,
): Promise<SearchContext[]> {
  const needle = keyword.toLowerCase();
  const identityCache = new Map<string, SessionIdentity>();
  // `lastUserBySession` is built from search's OWN reads, so no per-session
  // `loadSessionSummary` directory scan is needed: each session's last user
  // message is the unnamed row's identity fallback.
  const lastUserBySession = new Map<string, string>();
  let names: string[] = [];
  try {
    names = (await readdir(getOmpSessionDir(ctx.controls.cfg))).filter((n) => n.endsWith('.jsonl'));
  } catch {
    return [];
  }
  const rawHits: RawHit[] = [];
  // Bound parallelism: session dirs can have hundreds of jsonl files;
  // unbounded Promise.all would spike RSS on a big history.
  const SCAN_CONCURRENCY = 8;
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(SCAN_CONCURRENCY, names.length) }, async () => {
      while (true) {
        const idx = cursor++;
        if (idx >= names.length) break;
        const name = names[idx]!;
        const found = await scanSessionHits(name, needle, ctx, lastUserBySession);
        if (found) rawHits.push(found);
      }
    }),
  );
  // Resolve identity only AFTER the scan, once `lastUserBySession` is complete —
  // otherwise a concurrent worker could resolve a topic before another worker
  // has registered its file.
  const results: SessionHit[] = [];
  for (const raw of rawHits) {
    const identity = await resolveSessionIdentity(
      ctx,
      raw.sessionId,
      raw.fileName,
      identityCache,
      lastUserBySession,
    );
    results.push({
      ...identity,
      workspace: raw.workspace,
      messages: raw.messages,
      hitIndex: raw.hitIndex,
      matchCount: raw.matchCount,
    });
  }
  // Newest hit first, so both the hit groups inside a conversation and the
  // conversation rows themselves come out newest-first.
  results.sort((a, b) => newestHitMs(b) - newestHitMs(a));
  // One OMP session = one conversation: collapse a session's hit groups under a
  // single row; the first (newest) group stays the representative snippet for
  // the detail view.
  const grouped = new Map<string, SearchContext>();
  for (const r of results) {
    const group: SearchHitGroup = {
      messages: r.messages,
      hitIndex: r.hitIndex,
      matchCount: r.matchCount,
    };
    const existing = grouped.get(r.sessionId);
    if (existing) {
      existing.groups.push(group);
      existing.matchCount += r.matchCount;
      continue;
    }
    grouped.set(r.sessionId, {
      // The card's row-identity field still carries the legacy name
      // `sessionId`; its value is the OMP session id (one session = one
      // conversation).
      sessionId: r.sessionId,
      ...(r.title !== undefined ? { title: r.title } : {}),
      ...(r.topic !== undefined ? { topic: r.topic } : {}),
      workspace: r.workspace,
      matchCount: r.matchCount,
      groups: [group],
      messages: r.messages,
      hitIndex: r.hitIndex,
    });
  }
  return [...grouped.values()].slice(0, limit);
}

async function scanSessionHits(
  name: string,
  needle: string,
  ctx: CommandContext,
  lastUserBySession: Map<string, string>,
): Promise<RawHit | undefined> {
  let text: string;
  try {
    text = await readFile(join(getOmpSessionDir(ctx.controls.cfg), name), 'utf8');
  } catch {
    return undefined;
  }
  // Index the file's last user message under its identity (the header session
  // id, or the file name for a headerless file): identity resolution uses it as
  // the unnamed row's topic fallback, sourced here so /search never re-scans the
  // directory via loadSessionSummary.
  const fileScan = scanSessionFile(text);
  const sessionId = fileScan.meta?.id;
  lastUserBySession.set(sessionId ?? name, fileScan.lastUserMessage);
  // Cheap prefilter: skip building hit pairs for files with no keyword.
  if (!text.toLowerCase().includes(needle)) return undefined;

  const workspace = workspaceLabel(ctx, fileScan.meta?.cwd || homedir());

  const stream: SearchHit[] = [];
  for (const line of text.split('\n')) {
    if (!line.includes('"type":"message"')) continue;
    try {
      const frame = JSON.parse(line) as {
        timestamp?: string;
        message?: { role?: string; content?: Array<{ type?: string; text?: string }> };
      };
      const hit = messageText(frame.message as { role?: string; content?: Array<{ type?: string; text?: string }> });
      if (hit) {
        hit.timestamp = frame.timestamp;
        stream.push(hit);
      }
    } catch {
      /* skip malformed */
    }
  }

  let newest: { messages: SearchHit[]; hitIndex: number } | undefined;
  let matchCount = 0;
  const seenPairs = new Set<string>();
  for (let i = 0; i < stream.length; i++) {
    if (!stream[i]!.content.toLowerCase().includes(needle)) continue;
    let pair: SearchHit[];
    let hitIndex: number;
    if (
      stream[i]!.role === 'user' &&
      i + 1 < stream.length &&
      stream[i + 1]!.role === 'assistant'
    ) {
      pair = [stream[i]!, stream[i + 1]!];
      hitIndex = 0;
    } else if (
      stream[i]!.role === 'assistant' &&
      i - 1 >= 0 &&
      stream[i - 1]!.role === 'user'
    ) {
      pair = [stream[i - 1]!, stream[i]!];
      hitIndex = 1;
    } else {
      pair = [stream[i]!];
      hitIndex = 0;
    }
    const key = pair.map((m) => m.timestamp ?? m.content).join('|');
    if (seenPairs.has(key)) continue;
    seenPairs.add(key);
    matchCount += 1;
    // The stream is chronological, so the last matching pair is the newest one.
    newest = { messages: pair.map((m) => ({ ...m, timestamp: m.timestamp })), hitIndex };
  }
  if (!newest) return undefined;
  return {
    ...(sessionId !== undefined ? { sessionId } : {}),
    fileName: name,
    workspace,
    messages: newest.messages,
    hitIndex: newest.hitIndex,
    matchCount,
  };
}

async function handleSearch(args: string, ctx: CommandContext): Promise<void> {
  const [sub, ...rest] = args.trim().split(/\s+/);

  if (sub === 'page' && rest[0]) {
    // 卡片翻页 / 详情卡的「返回结果」：args = page <queryId> <offset>，复用缓存里
    // 的结果集。缓存过期（被挤出或进程重启）就不再拿 `page …` 当关键词乱搜，
    // 明确告诉用户重新检索 —— 这是「返回」唯一的失败路径。
    const queryId = rest[0];
    const offset = Number.parseInt(rest[1] ?? '', 10);
    const cached = searchCache.get(queryId);
    if (!cached) {
      await reply(ctx, '搜索结果已过期，请重新 `/search`。');
      return;
    }
    const keyword = searchKeywords.get(queryId) ?? '';
    // 页码越界（陈旧按钮）夹回第一页，不渲染空页。
    const page = Number.isFinite(offset) && offset >= 0 && offset < cached.length ? offset : 0;
    const card = searchResultsCard(keyword, cached, queryId, page, {
      currentSessionId: currentSessionId(ctx),
    });
    // 翻页来自卡片：原地更新（结果卡会被反复翻页 → 保留托管登记）。
    if (ctx.fromCardAction) {
      await updateOrFallback(ctx, card, '请重新 `/search <关键词>`。', { keepManaged: true });
    } else {
      await sendManagedCard(ctx.channel, ctx.msg.chatId, card);
    }
    return;
  }

  if (sub === 'resume') {
    // 卡片按钮带目标 sessionId（命中会话）。没有 arg 时保持旧语义：
    // 提示当前会话状态（直接发 `/s resume` 的场景）。
    const targetId = rest.join('').trim();
    if (targetId) {
      const sessions = await listResumableSessions(ctx);
      // The card button carries the target session id.
      const match = sessions.find((s) => s.sessionId === targetId);
      if (!match) {
        await reply(ctx, `❌ 该会话已不存在或无法恢复：\`${targetId}\``);
        return;
      }
      await applyResume(ctx, match);
      return;
    }
    const current = ctx.sessions.sessionFor(ctx.scope);
    if (current === undefined) {
      await reply(ctx, '当前没有可继续的会话。');
      return;
    }
    await applyResume(ctx, { sessionId: current.sessionId, cwd: current.cwd, timestamp: '' });
    return;
  }

  if (sub === 'show') {
    const queryId = rest[0] ?? '';
    const idx = Number.parseInt(rest[1] ?? '', 10);
    // 详情按钮把进入时的结果页 offset 一并带来（`show <queryId> <index> <offset>`），
    // 返回时回到同一页；旧格式缺 offset 时由卡片按 index 推算。
    const offset = Number.parseInt(rest[2] ?? '', 10);
    const contexts = searchCache.get(queryId);
    if (!contexts) {
      await reply(ctx, '搜索结果已过期，请重新 `/search`。');
      return;
    }
    const context = contexts[idx - 1];
    if (!context) {
      await reply(ctx, `无效的序号 \`${idx}\`。`);
      return;
    }
    const keyword = searchKeywords.get(queryId) ?? '';
    const info = detailInfoFor(context, queryId, idx, {
      keyword,
      currentSessionId: currentSessionId(ctx),
      ...(Number.isFinite(offset) ? { offset } : {}),
    });
    if (ctx.fromCardAction) {
      await sendManagedCard(ctx.channel, ctx.msg.chatId, searchDetailCard(info)).catch(() => {});
    } else {
      await reply(ctx, searchDetailText(info));
    }
    return;
  }

  // 空态卡的「🔄 重新搜索」：cmd `search.do` → `do <keyword>`，与直接输入关键词
  // 同义（重跑一次检索）。只有带了关键词才当作子命令，否则 `/search do` 就是搜 do。
  if (sub === 'do' && rest.length > 0) {
    args = rest.join(' ');
  }

  const keyword = args.trim();
  if (!keyword) {
    await reply(ctx, '用法：`/search <关键词>` — 在所有会话历史中检索（跨工作区）。');
    return;
  }
  const contexts = await searchSession(keyword, ctx);
  if (contexts.length === 0) {
    const card = searchEmptyCard(keyword);
    // 「重新搜索」来自卡片：原地更新（空态卡的按钮仍会被反复点 → 保留托管登记）。
    if (ctx.fromCardAction) {
      await updateOrFallback(ctx, card, '请重新 `/search <关键词>`。', { keepManaged: true });
    } else {
      await sendManagedCard(ctx.channel, ctx.msg.chatId, card);
    }
    return;
  }
  const queryId = `s${Date.now().toString(36)}`;
  searchCache.set(queryId, contexts);
  searchKeywords.set(queryId, keyword);
  if (searchCache.size > SEARCH_CACHE_MAX) {
    const oldest = searchCache.keys().next().value;
    if (oldest) {
      searchCache.delete(oldest);
      searchKeywords.delete(oldest);
    }
  }
  const card = searchResultsCard(keyword, contexts, queryId, 0, {
    currentSessionId: currentSessionId(ctx),
  });
  // `search.do`（空态卡按钮）/ `/search` 来自卡片时：原地更新（结果卡可翻页 → 保留托管登记）。
  if (ctx.fromCardAction) {
    await updateOrFallback(ctx, card, '请重新 `/search <关键词>`。', { keepManaged: true });
  } else {
    await sendManagedCard(ctx.channel, ctx.msg.chatId, card);
  }
}
