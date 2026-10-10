import { describe, expect, it } from 'vitest';
import {
  backfillWorkSessions, parseLogLine,
  type LogEvent, type SegmentMeta,
} from './backfill';
import type { SessionsFileV2 } from './work-store';

const seg = (sessionId: string, cwd: string, startedAtMs: number, lastActiveAtMs: number): SegmentMeta =>
  ({ sessionId, cwd, startedAtMs, lastActiveAtMs });

const empty = (): SessionsFileV2 => ({ v: 2, scopes: {}, workSessions: {} });

const bind = (ts: number, scope: string, sessionId: string): LogEvent =>
  ({ ts, kind: 'bind', scope, sessionId });
const boundary = (ts: number, scope: string, cmd: string): LogEvent =>
  ({ ts, kind: 'boundary', scope, cmd });

describe('backfillWorkSessions', () => {
  it('merges segments bound in the same interval into one work session', () => {
    const out = backfillWorkSessions(
      empty(),
      [bind(1, 'oc_1', 'A'), bind(2, 'oc_1', 'B')],
      [seg('A', '/repo', 1, 10), seg('B', '/repo', 2, 20)],
    );
    expect(Object.keys(out.workSessions)).toEqual(['A']);
    expect(out.workSessions['A']?.scope).toBe('oc_1');
    expect(out.workSessions['A']?.segments.map((s) => s.sessionId)).toEqual(['A', 'B']);
  });

  it('splits on a /new boundary into distinct work sessions', () => {
    const out = backfillWorkSessions(
      empty(),
      [bind(1, 'oc_1', 'A'), boundary(2, 'oc_1', '/new'), bind(3, 'oc_1', 'C')],
      [seg('A', '/repo', 1, 10), seg('C', '/repo', 3, 30)],
    );
    expect(Object.keys(out.workSessions).sort()).toEqual(['A', 'C']);
    expect(out.workSessions['A']?.segments.map((s) => s.sessionId)).toEqual(['A']);
    expect(out.workSessions['C']?.segments.map((s) => s.sessionId)).toEqual(['C']);
  });

  it('groups by the FIRST binding: a /resume re-bind does not migrate or merge', () => {
    const out = backfillWorkSessions(
      empty(),
      [
        bind(1, 'oc_1', 'A'),
        boundary(2, 'oc_1', '/new'),
        bind(3, 'oc_1', 'B'),
        bind(4, 'oc_1', 'A'), // /resume 回 A
      ],
      [seg('A', '/repo', 1, 10), seg('B', '/repo', 3, 30)],
    );
    expect(Object.keys(out.workSessions).sort()).toEqual(['A', 'B']);
    expect(out.workSessions['A']?.segments.map((s) => s.sessionId)).toEqual(['A']);
    expect(out.workSessions['B']?.segments.map((s) => s.sessionId)).toEqual(['B']);
  });

  it('keeps segments with no log coverage as their own scope:null work session', () => {
    const out = backfillWorkSessions(
      empty(),
      [bind(1, 'oc_1', 'A')],
      [seg('A', '/repo', 1, 10), seg('Z', '/tmp', 0, 5)],
    );
    expect(out.workSessions['Z']).toMatchObject({ scope: null, cwd: '/tmp' });
    expect(out.workSessions['Z']?.segments.map((s) => s.sessionId)).toEqual(['Z']);
  });

  it('is idempotent and never rewrites existing work sessions', () => {
    const existingA = {
      id: 'A', scope: 'oc_1', cwd: '/old', createdAtMs: 1, lastActiveAtMs: 99,
      currentSegmentId: 'A',
      segments: [{ sessionId: 'A', cwd: '/old', startedAtMs: 1, lastActiveAtMs: 99 }],
    };
    const base: SessionsFileV2 = { v: 2, scopes: {}, workSessions: { A: existingA } };
    const log = [bind(1, 'oc_1', 'A'), bind(2, 'oc_1', 'B')];
    const segs = [seg('A', '/repo', 1, 10), seg('B', '/repo', 2, 20)];

    const once = backfillWorkSessions(base, log, segs);
    expect(once.workSessions['A']).toEqual(existingA);
    const twice = backfillWorkSessions(once, log, segs);
    expect(twice).toEqual(once);
    expect(twice.workSessions['A']).toEqual(existingA);
  });

  it('orders segments by startedAtMs and keeps each segment own lastActiveAtMs', () => {
    const out = backfillWorkSessions(
      empty(),
      [bind(3, 'oc_1', 'B'), bind(1, 'oc_1', 'A')],
      [seg('B', '/repo', 3, 300), seg('A', '/repo', 1, 100)],
    );
    expect(Object.keys(out.workSessions)).toEqual(['A']);
    expect(out.workSessions['A']?.segments.map((s) => s.sessionId)).toEqual(['A', 'B']);
    expect(out.workSessions['A']?.segments.map((s) => s.lastActiveAtMs)).toEqual([100, 300]);
  });

  it('points the scope at the tail-bound work session without clobbering a live pointer', () => {
    const out = backfillWorkSessions(
      empty(),
      [bind(1, 'oc_1', 'A'), boundary(2, 'oc_1', '/new'), bind(3, 'oc_1', 'B')],
      [seg('A', '/repo', 1, 10), seg('B', '/repo', 3, 30)],
    );
    expect(out.scopes['oc_1']?.activeWorkSession).toBe('B');

    const live: SessionsFileV2 = {
      v: 2,
      scopes: { oc_1: { activeWorkSession: 'A' } },
      workSessions: {
        A: { id: 'A', scope: 'oc_1', cwd: '/repo', createdAtMs: 1, lastActiveAtMs: 10, segments: [{ sessionId: 'A', cwd: '/repo', startedAtMs: 1, lastActiveAtMs: 10 }] },
        B: { id: 'B', scope: 'oc_1', cwd: '/repo', createdAtMs: 3, lastActiveAtMs: 30, segments: [{ sessionId: 'B', cwd: '/repo', startedAtMs: 3, lastActiveAtMs: 30 }] },
      },
    };
    const kept = backfillWorkSessions(live, [bind(3, 'oc_1', 'B')], []);
    expect(kept.scopes['oc_1']?.activeWorkSession).toBe('A');
  });
});

describe('parseLogLine', () => {
  it('parses a bind line (session/set|resume with chatId + sessionId)', () => {
    const iso = '2026-10-11T01:02:03.000Z';
    expect(parseLogLine(JSON.stringify({ ts: iso, phase: 'session', event: 'set', chatId: 'oc_1', sessionId: 'A' })))
      .toEqual({ ts: Date.parse(iso), kind: 'bind', scope: 'oc_1', sessionId: 'A' });
    expect(parseLogLine(JSON.stringify({ ts: iso, phase: 'session', event: 'resume', chatId: 'oc_1', sessionId: 'B' })))
      .toEqual({ ts: Date.parse(iso), kind: 'bind', scope: 'oc_1', sessionId: 'B' });
  });

  it('parses /new|/cd|/ws command-reset lines as boundaries', () => {
    for (const cmd of ['/new', '/cd', '/ws']) {
      for (const phase of ['intake', 'command', 'cardAction']) {
        expect(parseLogLine(JSON.stringify({ ts: 5, phase, event: 'command-reset', scope: 'oc_1', cmd })))
          .toEqual({ ts: 5, kind: 'boundary', scope: 'oc_1', cmd });
      }
    }
  });

  it('does NOT treat /resume, ws.cancel, resume.cancel as boundaries', () => {
    for (const cmd of ['/resume', 'ws.cancel', 'resume.cancel']) {
      expect(parseLogLine(JSON.stringify({ ts: 5, phase: 'intake', event: 'command-reset', scope: 'oc_1', cmd })))
        .toBeUndefined();
    }
  });

  it('returns undefined for unknown or garbage lines without throwing', () => {
    expect(parseLogLine('not json')).toBeUndefined();
    expect(parseLogLine('')).toBeUndefined();
    expect(parseLogLine('null')).toBeUndefined();
    expect(parseLogLine('123')).toBeUndefined();
    expect(parseLogLine('{"foo":1}')).toBeUndefined();
    // ts 无法解析 → 丢弃
    expect(parseLogLine('{"ts":"nope","phase":"session","event":"set","chatId":"oc_1","sessionId":"A"}')).toBeUndefined();
    // 缺 sessionId / chatId → 不是 bind
    expect(parseLogLine('{"ts":1,"phase":"session","event":"set","chatId":"oc_1"}')).toBeUndefined();
    expect(parseLogLine('{"ts":1,"phase":"session","event":"set","sessionId":"A"}')).toBeUndefined();
    // 其它 phase 的 command-reset 不是边界
    expect(parseLogLine('{"ts":1,"phase":"other","event":"command-reset","scope":"oc_1","cmd":"/new"}')).toBeUndefined();
  });
});
