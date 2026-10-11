import { isOmpThinkingLevel, OMP_THINKING_LEVELS } from '../config/schema';
import { inlineActions, inlineRow, shortPath } from './templates';
import { escapeCode } from '../utils/text';

/** Form value meaning "clear ompThinking / follow OMP default". */
export const THINKING_FOLLOW_DEFAULT = '__default';

export interface ModelInfo {
  selector: string;
  name?: string;
  contextWindow?: number;
  thinking?: string[];
  input?: string[];
}

export interface ModelProviderInfo {
  provider: string;
  count: number;
}

/**
 * Quick-set 按钮（最近使用 / 常用）：并排、每行最多 2 个（`inlineRow` 的规则），
 * 当前模型不出现（再点一次是无操作）。标签只留模型段 —— 卡片标题已给出提供方，
 * 每个按钮都重复 `provider/` 只是噪音。
 */
function quickSetButtons(current: string | undefined, models: string[]): object[] {
  const items = models.filter((m) => m !== current);
  return inlineActions(
    items.map((m) => ({
      text: modelShortLabel(m),
      value: { cmd: 'model.use', arg: m },
    })),
  );
}

/** `provider/model` → `model`（提供方已由卡片标题/分组说明给出）。 */
function modelShortLabel(selector: string): string {
  const slash = selector.indexOf('/');
  return slash >= 0 ? selector.slice(slash + 1) : selector;
}

function formatCurrent(value: string | undefined): string {
  return value ? `\`${value}\`` : '_跟随 OMP 默认_';
}

function thinkingSelect(current?: string): object {
  const initial = current && isOmpThinkingLevel(current) ? current : THINKING_FOLLOW_DEFAULT;
  return {
    tag: 'select_static',
    name: 'thinking_level',
    placeholder: { tag: 'plain_text', content: '思考强度' },
    initial_option: initial,
    options: [
      { text: { tag: 'plain_text', content: '跟随 OMP 默认' }, value: THINKING_FOLLOW_DEFAULT },
      ...OMP_THINKING_LEVELS.map((lv) => ({
        text: { tag: 'plain_text', content: lv },
        value: lv,
      })),
    ],
  };
}

/** Provider chooser card for `/model`. */
export function modelProviderCard(
  current: string | undefined,
  providers: ModelProviderInfo[],
  recents: string[] = [],
  commons: string[] = [],
  thinking?: string,
): object {
  /** 一段快捷选择（标题 + 并排按钮），空段整块不渲染。 */
  const section = (title: string, models: string[]): object[] => {
    const buttons = quickSetButtons(current, models);
    return buttons.length > 0 ? [{ tag: 'markdown', content: `**${title}**` }, ...buttons] : [];
  };
  // 顺序：最近使用 → 常用 → 提供方。最近使用是「我刚才在用的那个」，
  // 是这张卡最高频的动作，理应排在最前（此前常用在前，最近使用在中间）。
  const recentSection = section('🕘 最近使用', recents);
  const commonSection = section('⭐ 常用', commons);
  const providerButtons = inlineActions(
    providers.map((p) => ({
      text: `${p.provider} (${p.count})`,
      style: p.provider.toLowerCase() === (current?.split('/')[0] ?? '') ? ('primary' as const) : ('default' as const),
      value: { cmd: 'model.provider', arg: p.provider },
    })),
  );
  return {
    schema: '2.0',
    config: { summary: { content: '切换模型' } },
    body: {
      elements: [
        { tag: 'markdown', content: '🎛 **切换模型**', text_size: 'heading' },
        {
          tag: 'markdown',
          content: `当前 ${formatCurrent(current)} · 思考 ${formatCurrent(thinking)}`,
          text_size: 'notation',
        },
        ...(recentSection.length > 0 || commonSection.length > 0 ? [{ tag: 'hr' }] : []),
        ...recentSection,
        ...(recentSection.length > 0 && commonSection.length > 0 ? [{ tag: 'markdown', content: '\n' }] : []),
        ...commonSection,
        { tag: 'hr' },
        { tag: 'markdown', content: '**📦 提供方**' },
        ...providerButtons,
        // 全局动作各占一行铺满：回退默认（不是提供方，单列）与退路「取消」。
        ...inlineActions([{ text: '回退默认', value: { cmd: 'model.reset', arg: '' } }]),
        ...inlineActions([{ text: '取消', value: { cmd: 'model.cancel', arg: '' } }]),
      ],
    },
  };
}

/** Model picker form card for one provider. */
export function modelSelectCard(
  provider: string,
  current: string | undefined,
  models: ModelInfo[],
  thinking?: string,
  /** 全局最近使用的 selector，最新在前：本提供方命中的那些排到下拉最前面。 */
  recents: string[] = [],
): object {
  const alphabetical = [...models].sort((a, b) => a.selector.localeCompare(b.selector));
  // 顺序：最近使用（按 recency）→ 其余按字母。模型列表有几十条时，「我刚用过」
  // 比「按字母排」有用得多。
  const rank = new Map(recents.map((sel, i) => [sel, i]));
  const sorted = [
    ...alphabetical.filter((m) => rank.has(m.selector)).sort((a, b) => rank.get(a.selector)! - rank.get(b.selector)!),
    ...alphabetical.filter((m) => !rank.has(m.selector)),
  ];
  // options 的 value 是完整 selector（provider/model）。用半段 id 永远匹配
  // 不上任何 option —— 预选会静默落到 sorted[0]，用户看到错误的"当前模型"。
  const initial =
    current && sorted.some((m) => m.selector === current)
      ? current
      : sorted[0]?.selector;
  const options = sorted.map((m) => {
    // 卡片标题已给出提供方，下拉里只留模型段；名字不同时附在后面。
    const short = modelShortLabel(m.selector);
    const label = m.name && m.name !== short ? `${short} (${m.name})` : short;
    return { text: { tag: 'plain_text', content: label }, value: m.selector };
  });
  return {
    schema: '2.0',
    config: { summary: { content: `选择 ${provider} 模型` } },
    body: {
      elements: [
        { tag: 'markdown', content: `🎛 **${provider} 模型**`, text_size: 'heading' },
        {
          tag: 'markdown',
          content: `当前 ${formatCurrent(current)} · 思考 ${formatCurrent(thinking)}` +
            (recents.length > 0 ? ' · _下拉里最近用过的排在前面_' : ''),
          text_size: 'notation',
        },
        {
          tag: 'form',
          name: 'model_form',
          elements: [
            {
              tag: 'select_static',
              name: 'model_selector',
              placeholder: { tag: 'plain_text', content: '模型' },
              initial_option: initial,
              options,
            },
            thinkingSelect(thinking),
            ...inlineRow([{ element: { tag: 'button', name: 'submit_btn', text: { tag: 'plain_text', content: '切换' }, type: 'primary', form_action_type: 'submit', behaviors: [{ type: 'callback', value: { cmd: 'model.submit' } }], } }]),
            ...inlineRow([{ element: { tag: 'button', name: 'cancel_btn', text: { tag: 'plain_text', content: '取消' }, behaviors: [{ type: 'callback', value: { cmd: 'model.cancel' } }], } }]),
          ],
        },
      ],
    },
  };
}

/** Post-set confirmation card. Shows the new model and current thinking. */
export function modelSavedCard(model: string, thinking?: string): object {
  return {
    schema: '2.0',
    config: { summary: { content: '模型已切换' } },
    body: {
      elements: [
        { tag: 'markdown', content: `✅ **模型已设为** \`${model}\``, text_size: 'heading' },
        {
          tag: 'markdown',
          content: `🧠 **思考强度**：${thinking ? `\`${thinking}\`` : '_跟随 OMP 默认_'}\n\n_下一条消息生效。_`,
        },
      ],
    },
  };
}

/** Thinking level picker form card. */
export function thinkingCard(current?: string): object {
  const levels = [
    'auto',
    'off',
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
  ];
  return {
    schema: '2.0',
    config: { summary: { content: '切换思考强度' } },
    body: {
      elements: [
        {
          tag: 'markdown',
          text_size: 'heading',
          content:
            `🧠 **思考强度**\n` +
            `当前：` + (current ? `\`${current}\`` : '_跟随 OMP 默认_') +
            `\n\n_只作用于当前模型,不影响模型切换_`,
        },
        { tag: 'hr' },
        {
          tag: 'form',
          name: 'thinking_form',
          elements: [
            {
              tag: 'select_static',
              name: 'thinking_level',
              initial_option: current ?? 'auto',
              options: levels.map((lv) => ({
                text: { tag: 'plain_text', content: lv },
                value: lv,
              })),
            },
            ...inlineRow([{ element: { tag: 'button', name: 'submit_btn', text: { tag: 'plain_text', content: '切换' }, type: 'primary', form_action_type: 'submit', behaviors: [{ type: 'callback', value: { cmd: 'thinking.submit' } }], } }]),
            ...inlineRow([{ element: { tag: 'button', name: 'cancel_btn', text: { tag: 'plain_text', content: '取消' }, behaviors: [{ type: 'callback', value: { cmd: 'thinking.cancel' } }], } }]),
          ],
        },
      ],
    },
  };
}

export function thinkingSavedCard(level: string): object {
  return {
    schema: '2.0',
    config: { summary: { content: '思考强度已切换' } },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: `✅ **思考强度已设为** \`${level}\``,
          text_size: 'heading',
        },
        { tag: 'markdown', content: '_下一条消息生效。_', text_size: 'notation' },
      ],
    },
  };
}

export function thinkingCancelledCard(): object {
  return {
    schema: '2.0',
    config: { summary: { content: '已取消' } },
    body: { elements: [{ tag: 'markdown', content: '已取消,未做修改。' }] },
  };
}

export interface ResumeOption {
  /** 一个 OMP 会话 = 一个对话：要恢复的就是这条会话（也是行上的显示句柄）。 */
  sessionId: string;
  cwd: string;
  /** Session start, ISO. */
  timestamp: string;
  /** Session file's last write (ms epoch) = when the conversation was last
   * active. Binding the chat to this session must not claim "now". */
  updatedAtMs?: number;
  /** User-assigned display title (/rename), if any. Shown ahead of the
   * auto summary so the user can tell sessions apart by name. */
  title?: string;
  /** Short description of what the conversation was about (last assistant
   * text reply). Absent for empty/short-lived sessions. */
  summary?: string;
  /** The last real message the user sent in this session. */
  lastMessage?: string;
}


export function resumeSavedCard(
  sessionId: string,
  cwd: string,
  context?: string,
): object {
  const elements: object[] = [
    { tag: 'markdown', content: '✅ **会话已恢复**', text_size: 'heading' },
    {
      tag: 'markdown',
      content: `🔗 \`${escapeCode(sessionId)}\` · 📁 \`${escapeCode(shortPath(cwd))}\``,
    },
    { tag: 'markdown', content: '_下一条消息从该会话继续。_', text_size: 'notation' },
  ];
  if (context) {
    elements.push({ tag: 'hr' }, { tag: 'markdown', content: context });
  }
  return {
    schema: '2.0',
    config: { summary: { content: '会话已恢复' } },
    body: { elements },
  };
}


export function modelCancelledCard(): object {
  return {
    schema: '2.0',
    config: { summary: { content: '已取消' } },
    body: { elements: [{ tag: 'markdown', content: '已取消,未做修改。' }] },
  };
}
