import { describe, expect, it } from 'vitest';
import {
  THINKING_FOLLOW_DEFAULT,
  modelProviderCard,
  modelSelectCard,
  thinkingCard,
} from './model-card';
import { OMP_THINKING_LEVELS } from '../config/schema';

const MODELS = [
  { provider: 'zhipu-coding-plan', selector: 'zhipu-coding-plan/glm-5.2', name: 'GLM-5.2' },
  { provider: 'zhipu-coding-plan', selector: 'zhipu-coding-plan/glm-5.3', name: 'GLM-5.3' },
];

interface SelectStatic {
  name?: unknown;
  options?: unknown[];
  initial_option?: unknown;
  placeholder?: unknown;
}

function isSelectStatic(value: unknown): value is SelectStatic {
  return (
    typeof value === 'object' &&
    value !== null &&
    'tag' in value &&
    value.tag === 'select_static'
  );
}

function readElements(holder: object): unknown[] {
  if ('elements' in holder) {
    const maybe = holder.elements;
    if (Array.isArray(maybe)) return maybe;
  }
  return [];
}

function findSelects(card: object): SelectStatic[] {
  if (!('body' in card)) throw new Error('card has no body');
  const body = card.body;
  if (typeof body !== 'object' || body === null) throw new Error('card body is not an object');
  const found: SelectStatic[] = [];
  for (const el of readElements(body)) {
    if (typeof el !== 'object' || el === null || !('tag' in el)) continue;
    if (el.tag !== 'form') continue;
    for (const inner of readElements(el)) {
      if (isSelectStatic(inner)) found.push(inner);
    }
  }
  return found;
}

function findSelect(card: object, name: string): SelectStatic {
  const sel = findSelects(card).find((s) => s.name === name);
  if (!sel) throw new Error(`no select_static named ${name}`);
  return sel;
}

/** option 的 value（`unknown` → 收窄，不做 unchecked cast）。 */
function optionValue(option: unknown): unknown {
  return typeof option === 'object' && option !== null && 'value' in option ? option.value : undefined;
}

/** option 的文本 content。 */
function optionText(option: unknown): string {
  if (typeof option !== 'object' || option === null || !('text' in option)) return '';
  const { text } = option;
  if (typeof text !== 'object' || text === null || !('content' in text)) return '';
  return typeof text.content === 'string' ? text.content : '';
}

function cardMarkdown(card: object): string {
  if (!('body' in card)) return '';
  const body = card.body;
  if (typeof body !== 'object' || body === null) return '';
  return readElements(body)
    .filter((el): el is { tag: string; content?: string } =>
      typeof el === 'object' && el !== null && 'tag' in el && el.tag === 'markdown',
    )
    .map((el) => el.content ?? '')
    .join('\n');
}

/** 卡片里所有按钮的标签，按渲染顺序（快捷区、提供方、动作行都走 column_set）。 */
function buttonLabels(card: object): string[] {
  if (!('body' in card)) return [];
  const body = card.body;
  if (typeof body !== 'object' || body === null) return [];
  const labels: string[] = [];
  for (const row of readElements(body)) {
    if (typeof row !== 'object' || row === null || !('columns' in row)) continue;
    const { columns } = row as { columns?: unknown };
    if (!Array.isArray(columns)) continue;
    for (const column of columns) {
      if (typeof column !== 'object' || column === null || !('elements' in column)) continue;
      for (const el of readElements(column as object)) {
        if (typeof el !== 'object' || el === null || !('tag' in el) || el.tag !== 'button') continue;
        const { text } = el as { text?: unknown };
        if (typeof text !== 'object' || text === null) continue;
        const { content } = text as { content?: unknown };
        if (typeof content === 'string') labels.push(content);
      }
    }
  }
  return labels;
}

describe('modelSelectCard', () => {
  it('keeps the options array on select_static (regression: a fix once dropped it and /model became an empty dropdown)', () => {
    const sel = findSelect(modelSelectCard('zhipu-coding-plan', undefined, MODELS), 'model_selector');
    expect(Array.isArray(sel.options)).toBe(true);
    expect(sel.options).toHaveLength(2);
  });

  it('preselects the current model by its full selector, not a half id', () => {
    const sel = findSelect(
      modelSelectCard('zhipu-coding-plan', 'zhipu-coding-plan/glm-5.3', MODELS),
      'model_selector',
    );
    expect(sel.initial_option).toBe('zhipu-coding-plan/glm-5.3');
  });

  it('does NOT preselect the first option when current is not in this provider list', () => {
    // 回归：provider=cursor 而 current=futu/… 时曾预选 cursor/claude-4-sonnet，
    // 用户「看一眼就点切换」就把模型换了。
    const card = modelSelectCard('zhipu-coding-plan', 'other/provider-model', MODELS);
    const sel = findSelect(card, 'model_selector');
    expect(sel.initial_option).toBeUndefined();
    expect(sel.placeholder).toEqual({ tag: 'plain_text', content: '选择一个模型' });
    expect(sel.options).toHaveLength(2);
    // meta 行点出「当前模型不属于该提供方」。
    expect(cardMarkdown(card)).toContain('当前模型不属于该提供方');
  });

  it('does not preselect either when no model is set at all', () => {
    const sel = findSelect(modelSelectCard('zhipu-coding-plan', undefined, MODELS), 'model_selector');
    expect(sel.initial_option).toBeUndefined();
  });

  it('shows the recents hint only when THIS provider actually has recent models', () => {
    const cursor = [
      { provider: 'cursor', selector: 'cursor/claude-4-sonnet' },
      { provider: 'cursor', selector: 'cursor/gpt-5' },
    ];
    // 全局 recents 非空但本提供方一个都没命中 → 不提「最近用过的排在前面」。
    const noHit = cardMarkdown(
      modelSelectCard('cursor', 'futu/x', cursor, undefined, [
        { selector: 'futu/deepseek-v4.1-flash' },
      ]),
    );
    expect(noHit).not.toContain('下拉里最近用过的排在前面');
    // 命中一个 → 提，并且把它排到下拉最前面。
    const card = modelSelectCard('cursor', undefined, cursor, undefined, [
      { selector: 'cursor/gpt-5' },
    ]);
    expect(cardMarkdown(card)).toContain('下拉里最近用过的排在前面');
    const json = JSON.stringify(findSelect(card, 'model_selector'));
    expect(json.indexOf('cursor/gpt-5')).toBeLessThan(json.indexOf('cursor/claude-4-sonnet'));
  });

  it('annotates the recent options with recency / use count (strings come from the command layer)', () => {
    // 「🕘 最近使用」在选卡上就是下拉最前面那几条 —— 名字后缀上命令层算好的时间、
    // 次数。卡片层不读时钟：这里传入的就是唯一的时间来源。
    const cursor = [
      { provider: 'cursor', selector: 'cursor/claude-4-sonnet' },
      { provider: 'cursor', selector: 'cursor/gpt-5' },
    ];
    const sel = findSelect(
      modelSelectCard('cursor', undefined, cursor, undefined, [
        { selector: 'cursor/gpt-5', ago: '3 分钟前', count: 5 },
      ]),
      'model_selector',
    );
    expect((sel.options ?? []).map(optionText)).toEqual([
      'gpt-5 · 3 分钟前 · 5 次',
      'claude-4-sonnet',
    ]);
  });

  it('includes a thinking-level select next to the model picker', () => {
    const card = modelSelectCard('zhipu-coding-plan', undefined, MODELS, 'high');
    const names = findSelects(card).map((s) => s.name);
    expect(names).toEqual(['model_selector', 'thinking_level']);
    const thinking = findSelect(card, 'thinking_level');
    expect(thinking.initial_option).toBe('high');
    expect(thinking.options).toHaveLength(1 + OMP_THINKING_LEVELS.length);
    expect(thinking.options?.[0]).toEqual({
      text: { tag: 'plain_text', content: '跟随 OMP 默认' },
      value: THINKING_FOLLOW_DEFAULT,
    });
  });

  it('preselects follow-default when thinking is unset', () => {
    const thinking = findSelect(
      modelSelectCard('zhipu-coding-plan', undefined, MODELS),
      'thinking_level',
    );
    expect(thinking.initial_option).toBe(THINKING_FOLLOW_DEFAULT);
  });
});

describe('modelProviderCard', () => {
  const providers = [
    { provider: 'futu', count: 12 },
    { provider: 'openai', count: 30 },
  ];

  it('shows the current model and thinking on the provider chooser', () => {
    const md = cardMarkdown(modelProviderCard('p/a', providers, [], [], 'medium'));
    expect(md).toContain('当前 `p/a` · 思考 `medium`');
    expect(md).toContain('切换模型');
  });

  it('leads with 最近使用, then 常用, then 提供方', () => {
    const md = cardMarkdown(
      modelProviderCard(
        'p/cur',
        providers,
        [{ selector: 'p/one' }, { selector: 'p/two' }],
        ['p/three'],
        'medium',
      ),
    );
    const order = ['🕘 最近使用', '⭐ 常用', '📦 提供方'].map((t) => md.indexOf(t));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // 最近使用的两条按 recency 排（新在前），且当前模型不出现在快捷区。
    const json = JSON.stringify(
      modelProviderCard(
        'p/cur',
        providers,
        [{ selector: 'p/one' }, { selector: 'p/two' }],
        ['p/three'],
        'medium',
      ),
    );
    expect(json.indexOf('"arg":"p/one"')).toBeLessThan(json.indexOf('"arg":"p/two"'));
    expect(json).not.toContain('"arg":"p/cur"');
  });

  it('puts each recent model’s recency and use count on its button (precomputed strings)', () => {
    // 时间 / 次数是命令层算好传进来的字符串 —— 卡片层不读时钟，也不该有别的来源。
    const card = modelProviderCard(
      'p/cur',
      providers,
      [
        { selector: 'p/one', ago: '3 分钟前', count: 5 },
        { selector: 'p/two', ago: '2 小时前' }, // 只用过 1 次 → 不写次数
        { selector: 'p/three' }, // 旧记录没有时间戳 → 只有名字
      ],
      [],
      'medium',
    );
    expect(buttonLabels(card)).toEqual([
      'one · 3 分钟前 · 5 次',
      'two · 2 小时前',
      'three',
      'openai (30)',
      'futu (12)',
      '回退默认',
      '取消',
    ]);
    // 同一份输入渲染两次逐字相同（纯函数，没有藏起来的时钟）。
    expect(JSON.stringify(card)).toBe(
      JSON.stringify(
        modelProviderCard(
          'p/cur',
          providers,
          [
            { selector: 'p/one', ago: '3 分钟前', count: 5 },
            { selector: 'p/two', ago: '2 小时前' },
            { selector: 'p/three' },
          ],
          [],
          'medium',
        ),
      ),
    );
  });

  it('caps 最近使用 and 常用 at 4 buttons each', () => {
    const recents = Array.from({ length: 8 }, (_, i) => ({ selector: `p/r${i}` }));
    const commons = Array.from({ length: 6 }, (_, i) => `p/c${i}`);
    const json = JSON.stringify(modelProviderCard('p/cur', providers, recents, commons, 'high'));
    // 每区 4 个：r0-r3（r4+ 不出现）、c0-c3。
    for (const keep of ['"arg":"p/r3"', '"arg":"p/c3"']) expect(json).toContain(keep);
    for (const drop of ['"arg":"p/r4"', '"arg":"p/c4"']) expect(json).not.toContain(drop);

    // 当前模型先被剔掉再截断：可见按钮仍是 4 个（不是 3 个）。
    const withCurrentFirst = JSON.stringify(
      modelProviderCard('p/r0', providers, recents, [], 'high'),
    );
    expect(withCurrentFirst).not.toContain('"arg":"p/r0"');
    for (const keep of ['"arg":"p/r1"', '"arg":"p/r2"', '"arg":"p/r3"', '"arg":"p/r4"']) {
      expect(withCurrentFirst).toContain(keep);
    }
    expect(withCurrentFirst).not.toContain('"arg":"p/r5"');
  });

  it('lays quick-set buttons side by side instead of one full-width row each', () => {
    const card = modelProviderCard(
      'p/cur',
      providers,
      [{ selector: 'p/one' }, { selector: 'p/two' }, { selector: 'p/three' }],
      [],
      undefined,
    ) as {
      body: { elements: Array<Record<string, unknown>> };
    };
    const rows = card.body.elements.filter((e) => e.tag === 'column_set');
    // 3 个最近使用 → 2 行（每行 ≤2）；提供方 2 个 → 1 行；回退默认 + 取消各 1 行。
    expect(rows.map((r) => (r.columns as unknown[]).length)).toEqual([2, 1, 2, 1, 1]);
  });

  /** 提供方按钮的排列顺序（按 JSON 里出现的位置）。 */
  const providerOrder = (card: object): string[] =>
    [...JSON.stringify(card).matchAll(/"cmd":"model\.provider","arg":"([^"]+)"/g)].map((m) => m[1]!);

  // 本机实测的 Map 插入序（cursor 永远第一），计数取真实缓存里的量级。
  const realProviders = [
    { provider: 'cursor', count: 8 },
    { provider: 'futu', count: 132 },
    { provider: 'kimi-code', count: 12 },
    { provider: 'opencode-go', count: 12 },
    { provider: 'zhipu-coding-plan', count: 40 },
  ];

  it('puts the current provider first, then by model count desc, ties alphabetical', () => {
    expect(providerOrder(modelProviderCard('futu/deepseek-v4.1-flash', realProviders))).toEqual([
      'futu',
      'zhipu-coding-plan',
      'kimi-code',
      'opencode-go',
      'cursor',
    ]);
    // 当前模型不属于任何提供方（或没设）→ 纯按计数降序、同数按字母。
    expect(providerOrder(modelProviderCard(undefined, realProviders))).toEqual([
      'futu',
      'zhipu-coding-plan',
      'kimi-code',
      'opencode-go',
      'cursor',
    ]);
    // 当前提供方拿 primary 样式（且只有一个）。
    const json = JSON.stringify(modelProviderCard('cursor/gpt-5', realProviders));
    expect(json).toContain('"text":{"tag":"plain_text","content":"cursor (8)"},"type":"primary"');
  });
});

describe('thinkingCard', () => {
  const optionValues = (card: object): unknown[] =>
    (findSelect(card, 'thinking_level').options ?? []).map(optionValue);

  it('offers 跟随默认 (__default) so the card path can go back to the OMP default', () => {
    const sel = findSelect(thinkingCard('high'), 'thinking_level');
    expect(sel.options?.[0]).toEqual({
      text: { tag: 'plain_text', content: '跟随 OMP 默认' },
      value: THINKING_FOLLOW_DEFAULT,
    });
    expect(sel.initial_option).toBe('high');
  });

  it('preselects 跟随默认 when no level is set — title and preselect agree', () => {
    const card = thinkingCard(undefined);
    const sel = findSelect(card, 'thinking_level');
    expect(sel.initial_option).toBe(THINKING_FOLLOW_DEFAULT);
    expect(cardMarkdown(card)).toContain('当前：_跟随 OMP 默认_');
    // 旧行为：标题写「跟随 OMP 默认」，下拉却预选 `auto`。
    expect(cardMarkdown(card)).not.toContain('当前：`auto`');
  });

  it('filters the levels by the model capability (futu/deepseek-v4.1-flash: low|high|max)', () => {
    const sel = findSelect(thinkingCard('high', ['low', 'high', 'max']), 'thinking_level');
    expect(optionValues(thinkingCard('high', ['low', 'high', 'max']))).toEqual([
      THINKING_FOLLOW_DEFAULT,
      'low',
      'high',
      'max',
    ]);
    expect(sel.initial_option).toBe('high');
  });

  it('keeps only 跟随默认 and says so when the model does not support thinking', () => {
    // 328 个模型里 110 个 `thinking` 为空 —— 旧卡片照样列 8 档。
    const card = thinkingCard(undefined, []);
    expect(optionValues(card)).toEqual([THINKING_FOLLOW_DEFAULT]);
    expect(findSelect(card, 'thinking_level').initial_option).toBe(THINKING_FOLLOW_DEFAULT);
    expect(cardMarkdown(card)).toContain('该模型不支持思考强度');
  });

  it('does not restrict the levels when the capability is unknown', () => {
    expect(findSelect(thinkingCard(undefined, undefined), 'thinking_level').options).toHaveLength(
      1 + OMP_THINKING_LEVELS.length,
    );
  });

  it('keeps a current level the model no longer supports, so title and preselect agree', () => {
    // 换过模型：ompThinking 还是 medium，新模型只支持 low|high|max。
    const card = thinkingCard('medium', ['low', 'high', 'max']);
    expect(optionValues(card)).toEqual([THINKING_FOLLOW_DEFAULT, 'medium', 'low', 'high', 'max']);
    expect(findSelect(card, 'thinking_level').initial_option).toBe('medium');
    expect(cardMarkdown(card)).toContain('当前：`medium`');
  });

  it('describes every level in the option text', () => {
    const texts = (findSelect(thinkingCard('high', ['low', 'high', 'max']), 'thinking_level').options ?? [])
      .map(optionText);
    expect(texts).toEqual(['跟随 OMP 默认', 'low（低）', 'high（高）', 'max（最高）']);
  });
});
