import { describe, expect, it } from 'vitest';
import {
  beginWorkSession, displayName, latestSegment, touchSegment, type WorkSession,
} from './work-session';

const seg = (id: string, cwd = '/repo', startedAtMs = 1_000) => ({
  sessionId: id, cwd, startedAtMs, lastActiveAtMs: startedAtMs,
});

describe('beginWorkSession', () => {
  it('takes its id and cwd from the first segment', () => {
    const ws = beginWorkSession('oc_1', seg('01aA', '/repo', 5));
    expect(ws).toMatchObject({
      id: '01aA', scope: 'oc_1', cwd: '/repo', createdAtMs: 5, lastActiveAtMs: 5,
      currentSegmentId: '01aA',
    });
    expect(ws.segments).toHaveLength(1);
  });
});

describe('touchSegment', () => {
  it('appends a new segment (OMP 换了会话 ⇔ 多一段)', () => {
    const ws = touchSegment(beginWorkSession('oc_1', seg('01aA')), seg('01aB', '/repo', 2_000), 2_000);
    expect(ws.segments.map((s) => s.sessionId)).toEqual(['01aA', '01aB']);
    expect(ws.currentSegmentId).toBe('01aB');
    expect(ws.lastActiveAtMs).toBe(2_000);
    // 第一段身份不变：工作会话不因为 OMP 漂移换 id
    expect(ws.id).toBe('01aA');
  });

  it('updates the same segment on a re-run instead of duplicating it', () => {
    const once = touchSegment(beginWorkSession('oc_1', seg('01aA')), seg('01aA', '/repo', 9_000), 9_000);
    expect(once.segments).toHaveLength(1);
    expect(once.segments[0]?.lastActiveAtMs).toBe(9_000);
  });

  it('follows the touched segment cwd when it is not the last one', () => {
    // /cd 之后同一工作会话里会有不同 cwd 的段；回到较早段（如 /resume）时
    // currentSegmentId 与 cwd 必须一致指向那段，而不是数组末段。
    const two = touchSegment(beginWorkSession('oc_1', seg('01aA', '/repo')), seg('01aB', '/other', 2_000), 2_000);
    const ws = touchSegment(two, seg('01aA', '/repo'), 3_000);
    expect(ws.currentSegmentId).toBe('01aA');
    expect(ws.cwd).toBe('/repo');
    expect(ws.segments.map((s) => s.sessionId)).toEqual(['01aA', '01aB']);   // 数组顺序不变
    expect(ws.segments[1]).toMatchObject({ sessionId: '01aB', cwd: '/other' });
    expect(ws.lastActiveAtMs).toBe(3_000);
  });
});

describe('displayName', () => {
  const ws: WorkSession = { ...beginWorkSession('oc_1', seg('01aA')), title: '  ' };
  it('falls back to the last user message when unnamed', () => {
    expect(displayName(ws, { '01aA': '看一下 KMP 的导出' })).toBe('看一下 KMP 的导出');
  });
  it('prefers the name over the topic', () => {
    expect(displayName({ ...ws, title: 'bridge UI 调整' }, { '01aA': 'x' })).toBe('bridge UI 调整');
  });
  it('returns undefined when neither exists', () => {
    expect(displayName(ws, {})).toBeUndefined();
  });
  it('falls back to an earlier segment when the last one has no user message', () => {
    const two = touchSegment(beginWorkSession('oc_1', seg('01aA')), seg('01aB', '/repo', 2_000), 2_000);
    expect(displayName(two, { '01aA': '先聊的话题', '01aB': '   ' })).toBe('先聊的话题');
    // 末段有消息时仍优先用末段
    expect(displayName(two, { '01aA': '先聊的话题', '01aB': '后来聊的' })).toBe('后来聊的');
  });
});

describe('latestSegment', () => {
  it('returns the last appended segment', () => {
    const ws = touchSegment(beginWorkSession('oc_1', seg('01aA')), seg('01aB', '/repo', 2_000), 2_000);
    expect(latestSegment(ws)?.sessionId).toBe('01aB');
  });
});
