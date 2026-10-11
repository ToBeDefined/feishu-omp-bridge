import type { CommentEvent } from '@larksuiteoapi/node-sdk';

const TTL_MS = 10 * 60 * 1000;
const CAP = 2000;
const seen = new Map<string, number>();

function eventKey(evt: CommentEvent): string {
  const payload = evt as unknown as Record<string, unknown>;
  const raw = evt.raw as Record<string, unknown> | undefined;
  const eventId = typeof payload.event_id === 'string' ? payload.event_id :
    typeof payload.eventId === 'string' ? payload.eventId :
    typeof raw?.event_id === 'string' ? raw.event_id :
    typeof raw?.eventId === 'string' ? raw.eventId : undefined;
  if (eventId) return `event:${eventId}`;
  const rawTime = raw?.create_time;
  const createTime = typeof rawTime === 'string' || typeof rawTime === 'number'
    ? String(rawTime)
    : String(evt.timestamp ?? '');
  return `${evt.fileToken}:${evt.commentId}:${evt.replyId ?? ''}:${createTime}`;
}

/** Returns false when this event was received within the deduplication window. */
export function rememberCommentEvent(evt: CommentEvent, now = Date.now()): boolean {
  for (const [key, at] of seen) {
    if (now - at >= TTL_MS) seen.delete(key);
    else break;
  }
  const key = eventKey(evt);
  const previous = seen.get(key);
  if (previous !== undefined && now - previous < TTL_MS) return false;
  if (seen.size >= CAP) {
    const oldest = seen.keys().next().value;
    if (oldest !== undefined) seen.delete(oldest);
  }
  seen.set(key, now);
  return true;
}

/** Test-only reset; production callers should never need this. */
export function resetCommentDedup(): void {
  seen.clear();
}
