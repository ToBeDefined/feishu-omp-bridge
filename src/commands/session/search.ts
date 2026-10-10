import { homedir } from 'node:os';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getOmpSessionDir } from '../../config/schema';
import { forgetManagedCard, sendManagedCard, updateManagedCard } from '../../card/managed';
import type { CommandContext, Handler } from '../index';
import { FORM_SETTLE_MS, recallMessage, reply } from '../shared';
import { codeSpan } from '../../utils/text';
import { extractUserInput, scanSessionFile } from './context';
import { applyResume, listResumableSessions } from './resume';
import { resolveWorkSessionDisplay } from './display';
import {
  renderSearchContext,
  searchDetailCard,
  searchEmptyCard,
  searchResultsCard,
  type SearchContext,
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

/** Resolved display + identity of the work session a segment belongs to. */
interface WorkSessionIdentity {
  /** Work session id; an unclaimed segment falls back to its own id/file. */
  workSessionId: string;
  title?: string;
  topic?: string;
  /** Declared work-session segment count (1 for an unclaimed segment). */
  segmentCount: number;
}

/** One session file's matched pairs, annotated with its work-session identity. */
interface SegmentHit extends WorkSessionIdentity {
  /** OMP segment id (the file's header id), when it had one. */
  segmentId?: string;
  workspace: string;
  /** Newest matching pair in the segment — the representative snippet. */
  messages: SearchHit[];
  hitIndex: number;
  /** Matched Q&A pairs within this segment. */
  matchCount: number;
}

/**
 * Resolve a segment's work-session identity + display name, memoised by work
 * session id so a multi-segment work session pays `loadSessionSummary`'s
 * session-directory scan at most once. A segment no work session claims is its
 * own single-segment work session (identity = the segment), never named.
 */
async function resolveSegmentIdentity(
  ctx: CommandContext,
  sessionId: string | undefined,
  fileName: string,
  cache: Map<string, WorkSessionIdentity>,
): Promise<WorkSessionIdentity> {
  const ws = sessionId !== undefined ? ctx.workSessions.workSessionForSegment(sessionId) : undefined;
  const workSessionId = ws?.id ?? sessionId ?? fileName;
  const cached = cache.get(workSessionId);
  if (cached) return cached;
  // Name = /rename title; unnamed falls back to the current/latest segment's
  // last user message (the shared display helper, same口径 as /history).
  const display = await resolveWorkSessionDisplay(ctx, ws);
  const resolved: WorkSessionIdentity = {
    workSessionId,
    ...(display.name !== undefined ? { title: display.name } : {}),
    ...(display.topic !== undefined ? { topic: display.topic } : {}),
    segmentCount: ws?.segments.length ?? 1,
  };
  cache.set(workSessionId, resolved);
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
 * WORK session: every matched segment collapses under a single heading (the
 * newest pair is the representative snippet, `matchCount` the total across the
 * work session's segments). Newest first, capped at `limit` work sessions. */
export async function searchSession(
  keyword: string,
  ctx: CommandContext,
  limit = 6,
): Promise<SearchContext[]> {
  const needle = keyword.toLowerCase();
  let names: string[] = [];
  try {
    names = (await readdir(getOmpSessionDir(ctx.controls.cfg))).filter((n) => n.endsWith('.jsonl'));
  } catch {
    return [];
  }
  const identityCache = new Map<string, WorkSessionIdentity>();
  const results: SegmentHit[] = [];
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
        const found = await scanSessionHits(name, needle, ctx, identityCache);
        if (found) results.push(found);
      }
    }),
  );
  // Newest hit first, so both the segment groups inside a work session and the
  // work-session rows themselves come out newest-first.
  results.sort((a, b) => newestHitMs(b) - newestHitMs(a));
  // Collapse each work session's segments under one row; the first (newest)
  // segment stays the representative snippet for the detail view.
  const grouped = new Map<string, SearchContext>();
  for (const r of results) {
    const group: SearchHitGroup = {
      ...(r.segmentId !== undefined ? { segmentId: r.segmentId } : {}),
      messages: r.messages,
      hitIndex: r.hitIndex,
      matchCount: r.matchCount,
    };
    const existing = grouped.get(r.workSessionId);
    if (existing) {
      existing.groups.push(group);
      existing.matchCount += r.matchCount;
      continue;
    }
    grouped.set(r.workSessionId, {
      workSessionId: r.workSessionId,
      ...(r.title !== undefined ? { title: r.title } : {}),
      ...(r.topic !== undefined ? { topic: r.topic } : {}),
      workspace: r.workspace,
      segmentCount: r.segmentCount,
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
  identityCache: Map<string, WorkSessionIdentity>,
): Promise<SegmentHit | undefined> {
  let text: string;
  try {
    text = await readFile(join(getOmpSessionDir(ctx.controls.cfg), name), 'utf8');
  } catch {
    return undefined;
  }
  // Cheap prefilter: skip files that can't contain the keyword at all.
  if (!text.toLowerCase().includes(needle)) return undefined;

  const { meta } = scanSessionFile(text);
  const sessionId = meta?.id;
  const identity = await resolveSegmentIdentity(ctx, sessionId, name, identityCache);
  const workspace = workspaceLabel(ctx, meta?.cwd || homedir());

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
    ...identity,
    ...(sessionId !== undefined ? { segmentId: sessionId } : {}),
    workspace,
    messages: newest.messages,
    hitIndex: newest.hitIndex,
    matchCount,
  };
}

async function handleSearch(args: string, ctx: CommandContext): Promise<void> {
  const [sub, ...rest] = args.trim().split(/\s+/);

  if (sub === 'page') {
    // 卡片翻页：args = page <queryId> <offset>。cache 未命中则回退为
    // 关键词检索（queryId 是内部格式，正常不会撞词）。
    const queryId = rest[0] ?? '';
    const offset = Number.parseInt(rest[1] ?? '', 10);
    const cached = searchCache.get(queryId);
    const keyword = searchKeywords.get(queryId) ?? '';
    if (cached && Number.isFinite(offset) && offset >= 0) {
      if (ctx.fromCardAction) await recallMessage(ctx, ctx.msg.messageId);
      await sendManagedCard(
        ctx.channel,
        ctx.msg.chatId,
        searchResultsCard(keyword, cached, queryId, true, offset),
      );
      return;
    }
  }

  if (sub === 'resume') {
    // 卡片按钮带目标 sessionId（命中会话）。没有 arg 时保持旧语义：
    // 提示当前会话状态（直接发 `/s resume` 的场景）。
    const targetId = rest.join('').trim();
    if (targetId) {
      const sessions = await listResumableSessions(ctx);
      // The button carries a WORK session id; legacy options only expose the
      // segment id, so fall back to that for pre-Task-9 listers.
      const match = sessions.find(
        (s) => s.sessionId === targetId || ('workSessionId' in s && s.workSessionId === targetId),
      );
      if (!match) {
        await reply(ctx, `❌ 该会话已不存在或无法恢复：\`${targetId}\``);
        return;
      }
      await applyResume(ctx, match);
      return;
    }
    const active = ctx.workSessions.activeWorkSession(ctx.scope);
    if (!active?.currentSegmentId) {
      await reply(ctx, '当前没有可继续的会话。');
      return;
    }
    await applyResume(ctx, {
      sessionId: active.currentSegmentId,
      cwd: active.cwd || homedir(),
      timestamp: '',
    });
    return;
  }

  if (sub === 'done') {
    const queryRef = rest.join(' ').trim();
    const [queryId, idxStr] = queryRef.split(/\s+/);
    const contexts = searchCache.get(queryId ?? '');
    if (ctx.fromCardAction) {
      const msgId = ctx.msg.messageId;
      void (async () => {
        await new Promise((r) => setTimeout(r, FORM_SETTLE_MS));
        try {
          if (idxStr) {
            const idx = Number.parseInt(idxStr, 10);
            const context = contexts?.[idx - 1];
            const workSessionId = context?.workSessionId;
            const wsLabel = context?.workspace ?? '';
            const full = context ? renderSearchContext(context, 'detail') : '';
            await updateManagedCard(
              ctx.channel,
              msgId,
              searchDetailCard(workSessionId, full, undefined, idx, true, wsLabel),
            );
          } else {
            // Results list card: strip buttons, keep the list with the
            // workspace / work-session context intact.
            await updateManagedCard(
              ctx.channel,
              msgId,
              searchResultsCard('', contexts ?? [], queryId ?? '', false),
            );
          }
        } catch {
          /* ignore */
        }
        forgetManagedCard(msgId);
      })();
    }
    return;
  }

  if (sub === 'show') {
    const queryId = rest[0] ?? '';
    const idx = Number.parseInt(rest[1] ?? '', 10);
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
    const full = renderSearchContext(context, 'detail');
    const workSessionId = context.workSessionId;
    const wsLabel = context.workspace ?? '';
    if (ctx.fromCardAction) {
      await sendManagedCard(
        ctx.channel,
        ctx.msg.chatId,
        searchDetailCard(workSessionId, full, `${queryId} ${idx}`, idx, false, wsLabel),
      ).catch(() => {});
    } else {
      await reply(ctx, `🆔 工作会话: \`${workSessionId}\`\n\n${full}`);
    }
    return;
  }

  const keyword = args.trim();
  if (!keyword) {
    await reply(ctx, '用法：`/search <关键词>` — 在所有会话历史中检索（跨工作区）。');
    return;
  }
  const contexts = await searchSession(keyword, ctx);
  if (contexts.length === 0) {
    if (ctx.fromCardAction) await recallMessage(ctx, ctx.msg.messageId);
    await sendManagedCard(ctx.channel, ctx.msg.chatId, searchEmptyCard(keyword));
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
  if (ctx.fromCardAction) await recallMessage(ctx, ctx.msg.messageId);
  await sendManagedCard(
    ctx.channel,
    ctx.msg.chatId,
    searchResultsCard(keyword, contexts, queryId, true),
  );
}
