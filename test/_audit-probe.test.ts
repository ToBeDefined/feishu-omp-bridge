import { writeFileSync } from 'node:fs';
import { it } from 'vitest';
import * as T from '../src/card/templates';
import * as M from '../src/card/model-card';
import * as A from '../src/card/account-cards';
import * as C from '../src/card/config-card';

type Any = any;

function walk(e: Any, out: string[]) {
  const tag = e?.tag;
  if (tag === 'markdown') {
    out.push(e.text_size === 'heading' ? 'heading' : e.text_size === 'notation' ? 'notation' : 'md');
    return;
  }
  if (tag === 'hr') return out.push('hr');
  if (tag === 'column_set') {
    const cols: Any[] = e.columns ?? [];
    const inner: string[] = [];
    for (const c of cols) for (const x of c.elements ?? []) walk(x, inner);
    const grey = cols.some((c) => c.background_style === 'grey');
    out.push(`${grey ? 'greyPanel' : 'row'}[${inner.join('|')}]`);
    return;
  }
  if (tag === 'collapsible_panel') {
    const inner: string[] = [];
    for (const x of e.elements ?? []) walk(x, inner);
    out.push(`collapsible(exp=${e.expanded})[${inner.join('|')}]`);
    return;
  }
  if (tag === 'form') {
    const inner: string[] = [];
    for (const x of e.elements ?? []) walk(x, inner);
    out.push(`form[${inner.join('|')}]`);
    return;
  }
  if (tag === 'button') {
    out.push(`btn(${e.type ?? 'default'}:${e.text?.content ?? e.name})`);
    return;
  }
  if (tag === 'input') return out.push(`input(${e.name})`);
  if (tag === 'select_static') return out.push(`select(${e.name})`);
  out.push(String(tag));
}

function mdLines(elements: Any[], out: Array<[string, string]> = []) {
  for (const e of elements ?? []) {
    if (e?.tag === 'markdown') out.push([e.text_size ?? 'normal', e.content]);
    if (e?.tag === 'column') mdLines(e.elements, out);
    if (e?.tag === 'column_set') for (const c of e.columns ?? []) mdLines(c.elements, out);
    if (e?.tag === 'collapsible_panel' || e?.tag === 'form') mdLines(e.elements, out);
  }
  return out;
}

function capture(pair: [string, Any]) {
  const [name, card] = pair;
  const sig: string[] = [];
  for (const e of card?.body?.elements ?? []) walk(e, sig);
  return {
    name,
    summary: card?.config?.summary?.content,
    updateMulti: card?.config?.update_multi ?? undefined,
    sig,
    mds: mdLines(card?.body?.elements ?? []),
  };
}

const now = Date.now();
const info = {
  scope: 'oc_abc123def456',
  chatMode: 'group',
  cwd: '/Users/tbd/Git/Other/feishu-omp-bridge',
  sessionId: 'sess-12345678-abcd',
  sessionName: 'demo',
  createdAt: now - 3600e3,
  updatedAt: now - 60e3,
  running: false,
  agentName: 'OMP',
  model: 'futu/deepseek-v4.1-flash',
  thinking: 'high',
  idleLine: '15 分钟无输出将中止',
  wsNames: ['bridge'],
  summary: { lastMessage: 'fix the card', lastReply: 'done' },
} as Any;
const bare = {
  scope: 'oc_x',
  chatMode: 'p2p',
  cwd: '/Users/tbd',
  running: true,
  agentName: 'OMP',
  idleLine: '关闭',
  wsNames: [],
  summary: {},
} as Any;

it('probe', () => {
  const rows: Any = [
    { id: 'p1', appId: 'cli_aaa', botName: 'bridge', startedAgo: '3 分钟前', isCurrent: true },
    { id: 'p2', appId: 'cli_bbb', startedAgo: '1 小时前', isCurrent: false },
  ];
  const steps: Any = [
    { name: 'typecheck', status: 'ok' },
    { name: 'test', status: 'running' },
    { name: 'build', status: 'pending' },
  ];
  const cfg: Any = {
    messageReply: 'markdown',
    showToolCalls: true,
    maxConcurrentRuns: 10,
    runIdleTimeoutMinutes: 0,
    requireMentionInGroup: true,
    allowedUsers: '',
    allowedChats: '',
    admins: 'ou_a',
    owner: 'ou_a',
  };

  const entries: Array<[string, Any]> = [
    // ---- templates.ts
    ['/status (full)', T.statusCard(info)],
    ['/status (bare/topic)', T.statusCard({ ...bare, chatMode: 'topic' } as Any)],
    ['/status (stale)', T.statusCard({ ...info, sessionStale: true } as Any)],
    ['contextPanels (standalone)', { body: { elements: T.contextPanels(info) }, config: {} }],
    ['/new', T.newSessionCard({ cwd: info.cwd, model: info.model, thinking: 'high', idleLine: '15 分钟', wasRunning: false })],
    ['/new (wasRunning+scopeNote)', T.newSessionCard({ cwd: info.cwd, idleLine: '关闭', wasRunning: true, scopeNote: '话题独立会话' })],
    ['/cd', T.cwdChangedCard(info.cwd)],
    ['/cd (note)', T.cwdChangedCard(info.cwd, '话题内切换只影响本话题')],
    ['/ws (empty)', T.workspacesCard(undefined, {}, undefined, 'feishu-omp-bridge')],
    ['/ws (empty,no suggestion)', T.workspacesCard('/Users/tbd', {})],
    ['/ws (list)', T.workspacesCard('/Users/tbd/Git', { Git: '/Users/tbd/Git', tmp: '/tmp' })],
    ['/ws (confirm)', T.workspacesCard('/Users/tbd/Git', { Git: '/Users/tbd/Git', tmp: '/tmp' }, 'tmp')],
    ['/help', T.helpCard()],
    ['/diff', T.diffCard(info.cwd, ' src/a.ts | 2 +-', 'diff --git a/src/a.ts b/src/a.ts\n+hello')],
    ['/diff (truncated,no stat)', T.diffCard(info.cwd, '', 'x'.repeat(4100))],
    ['/exec ok', T.execResultCard({ cmd: 'ls -la', cwd: info.cwd, exitCode: 0, output: 'a\nb', timedOut: false, timeoutSeconds: 30 } as Any)],
    ['/exec fail', T.execResultCard({ cmd: 'false', cwd: info.cwd, exitCode: 1, output: 'boom', timedOut: false, timeoutSeconds: 30 } as Any)],
    ['/exec timeout', T.execResultCard({ cmd: 'sleep', cwd: info.cwd, exitCode: null, output: '', timedOut: true, timeoutSeconds: 30 } as Any)],
    ['/exec spawn fail', T.execResultCard({ cmd: 'nope', cwd: info.cwd, exitCode: null, output: '', timedOut: false, timeoutSeconds: 30, reason: '目录不存在' } as Any)],
    ['/ps', T.psCard(rows)],
    ['/ps (confirm)', T.psCard(rows, { confirmId: 'p1' })],
    ['/ps (self)', T.psCard(rows, { exitingSelf: true })],
    ['/ps (empty)', T.psCard([])],
    ['/every', T.everyCard([{ id: '1', interval: '30m', nextRun: '10:00', prompt: 'run tests' }] as Any)],
    ['/every (empty)', T.everyCard([])],
    ['/every (2,long)', T.everyCard([
      { id: '1', interval: '30m', nextRun: '10:00', prompt: 'a'.repeat(60) },
      { id: '2', interval: '2h', nextRun: '12:00', prompt: 'short' },
    ] as Any)],
    ['/compact started(est)', T.compactCard({ phase: 'started', tokensK: '120', mb: '3.4', eta: '20s', cap: '1M' } as Any)],
    ['/compact started(no est)', T.compactCard({ phase: 'started' } as Any)],
    ['/compact failed', T.compactCard({ phase: 'failed', error: 'E: bad' } as Any)],
    ['/compact done', T.compactCard({ phase: 'done' } as Any)],
    ['/release running', T.releaseCard({ steps, phase: 'running' } as Any)],
    ['/release running+drain', T.releaseCard({ steps, phase: 'running', drain: { runningCount: 2, timeoutMs: 300000 } } as Any)],
    ['/release drain timeout', T.releaseCard({ steps, phase: 'running', drain: { runningCount: 2, timeoutMs: 300000, timedOut: true } } as Any)],
    ['/release restarting', T.releaseCard({ steps, phase: 'restarting' } as Any)],
    ['/release restarting forced', T.releaseCard({ steps, phase: 'restarting', forced: true, interruptedCount: 3 } as Any)],
    ['/release success', T.releaseCard({ steps, phase: 'success' } as Any)],
    ['/release failed', T.releaseCard({ steps: [{ name: 'test', status: 'failed' }], phase: 'failed', failStep: 'test', failNote: 'boom', output: 'log' } as Any)],
    ['/release empty steps', T.releaseCard({ steps: [], phase: 'running' } as Any)],
    ['staleNotice', T.staleNoticeCard()],
    ['/restart draining', T.restartCard('draining', undefined, { runningCount: 2, timeoutMs: 300000 })],
    ['/restart draining timeout', T.restartCard('draining', undefined, { runningCount: 2, timedOut: true })],
    ['/restart starting', T.restartCard('starting')],
    ['/restart starting forced', T.restartCard('starting', undefined, { forced: true, runningCount: 1 })],
    ['/restart done', T.restartCard('done')],
    ['/restart failed', T.restartCard('failed', 'err')],
    ['agentSelected', T.agentSelectedCard('Option A')],
    ['online', T.onlineCard('crash recovery')],
    ['online (no note)', T.onlineCard()],
    ['/timeout', T.timeoutCard({ current: '当前 session 探活：15 分钟', global: '全局默认：关闭' } as Any)],
    ['/timeout notice', T.timeoutCard({ current: 'c', global: 'g', notice: '已设为 30 分钟' } as Any)],
    ['/timeout cancelled', T.timeoutCard({ current: 'c', global: 'g', cancelled: true } as Any)],
    // ---- model-card.ts
    ['resumeSaved', M.resumeSavedCard(info)],
    ['resumeSaved (bare)', M.resumeSavedCard(bare)],
    ['modelProvider', M.modelProviderCard('futu/deepseek-v4.1-flash', [{ provider: 'futu', count: 5 }, { provider: 'cursor', count: 2 }] as Any, [{ selector: 'futu/a', ago: '3 分钟前', count: 5 }] as Any, ['futu/b'] as Any, 'high')],
    ['modelSelect', M.modelSelectCard('futu', 'futu/a', [{ selector: 'futu/a', name: 'A' }, { selector: 'futu/b' }] as Any, 'high', [{ selector: 'futu/b', ago: '1 小时前', count: 2 }] as Any)],
    ['modelSelect (foreign)', M.modelSelectCard('cursor', 'futu/a', [{ selector: 'cursor/x' }] as Any)],
    ['modelSaved', M.modelSavedCard('futu/a', 'high')],
    ['modelSaved (no thinking)', M.modelSavedCard('futu/a')],
    ['thinking', M.thinkingCard('high', ['off', 'high'])],
    ['thinking (unsupported)', M.thinkingCard(undefined, [])],
    ['thinking (unknown)', M.thinkingCard()],
    ['thinkingSaved', M.thinkingSavedCard('high')],
    ['thinkingSaved (default)', M.thinkingSavedCard(M.THINKING_FOLLOW_DEFAULT)],
    ['thinkingCancelled', M.thinkingCancelledCard()],
    ['modelCancelled', M.modelCancelledCard()],
    // ---- account-cards.ts
    ['accountCurrent', A.accountCurrentCard({ appId: 'cli_1234567890abcdef', botName: 'bridge', tenant: 'feishu' } as Any)],
    ['accountCurrent (no bot)', A.accountCurrentCard({ appId: 'cli_1', tenant: 'lark' } as Any)],
    ['accountForm', A.accountFormCard()],
    ['accountForm (err)', A.accountFormCard({ errorMessage: 'App ID 无效', initialTenant: 'lark', prefillAppId: 'cli_x' })],
    ['accountValidating', A.accountValidatingCard()],
    ['accountSuccess', A.accountSuccessCard({ appId: 'cli_1234567890abcdef', botName: 'bridge', tenant: 'feishu' } as Any)],
    ['accountFailure', A.accountFailureCard('bad secret')],
    ['accountCancelled', A.accountCancelledCard()],
    // ---- config-card.ts
    ['configForm', C.configFormCard(cfg)],
    ['configSaved', C.configSavedCard(cfg)],
    ['configCancelled', C.configCancelledCard()],
    ['configInvalid', C.configInvalidCard(['并发上限必须是 1-50 的整数'])],
    ['configSaveFailed', C.configSaveFailedCard('EACCES')],
  ];

  writeFileSync('/tmp/card-audit.json', JSON.stringify(entries.map(capture), null, 1));
});
