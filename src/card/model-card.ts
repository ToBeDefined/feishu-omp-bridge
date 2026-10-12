import { isOmpThinkingLevel, OMP_THINKING_LEVELS } from '../config/schema';
import {
  contextPanels,
  inlineActions,
  inlineRow,
  md,
  panel,
  shortPath,
  stackedPanels,
  type ContextInfo,
} from './templates';
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

/** 最近使用 / 常用两个快捷区各自最多展示几个 —— 再多就把卡片撑成按钮墙
 * （模型历史存 20 条，常用角色也可能十几条）。 */
const QUICK_SET_MAX = 4;

/** 「🕘 最近使用」的一条：`selector` 与展示用的时间 / 次数。时间和次数**都由命令层
 * 算好传入** —— 卡片层是纯函数，不读时钟、不读历史文件（否则渲染结果不可断言）。 */
export interface RecentModel {
  selector: string;
  /** 相对时间文案（命令层 `formatAgoOr(at, '')`）；无时间戳的旧记录 → 省略。 */
  ago?: string;
  /** 使用次数。1 次不写：每条历史至少 1 次，写出来只是噪音。 */
  count?: number;
}

/** 快捷区按钮 / 下拉选项的尾注：` · 3 分钟前 · 5 次`；两样都没有就为空。 */
function recentNote(item: RecentModel): string {
  const parts = [
    item.ago,
    item.count !== undefined && item.count > 1 ? `${item.count} 次` : undefined,
  ].filter((part): part is string => part !== undefined && part !== '');
  return parts.length > 0 ? ` · ${parts.join(' · ')}` : '';
}

/**
 * Quick-set 按钮（最近使用 / 常用）：并排、每行最多 2 个（`inlineRow` 的规则），
 * 当前模型不出现（再点一次是无操作）。标签只留模型段 —— 卡片标题已给出提供方，
 * 每个按钮都重复 `provider/` 只是噪音。
 *
 * 先剔当前模型再截断到 4 个：否则当前模型占掉一个名额，可见按钮只剩 3 个。
 */
function quickSetButtons(current: string | undefined, models: RecentModel[]): object[] {
  const items = models.filter((m) => m.selector !== current).slice(0, QUICK_SET_MAX);
  return inlineActions(
    items.map((m) => ({
      // 「最近使用」按钮缀上「…前 / N 次」：一眼看出哪条是刚才在用的那个。
      text: modelShortLabel(m.selector) + recentNote(m),
      value: { cmd: 'model.use', arg: m.selector },
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

/** 思考档位的中文说明 —— 写进 option 文本里（每档一句话），不额外加说明块：
 * 8 档各占一行说明会把卡片撑过半屏。 */
const THINKING_HINTS: Record<string, string> = {
  auto: '自动',
  off: '关闭思考',
  minimal: '最少',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '很高',
  max: '最高',
};

function thinkingOption(level: string): object {
  const hint = THINKING_HINTS[level];
  return {
    text: { tag: 'plain_text', content: hint ? `${level}（${hint}）` : level },
    value: level,
  };
}

/** 「跟随 OMP 默认」（= 清掉 ompThinking）；`/model`、`/thinking` 两张卡共用。 */
const FOLLOW_DEFAULT_OPTION: object = {
  text: { tag: 'plain_text', content: '跟随 OMP 默认' },
  value: THINKING_FOLLOW_DEFAULT,
};

function thinkingSelect(current?: string): object {
  const initial = current && isOmpThinkingLevel(current) ? current : THINKING_FOLLOW_DEFAULT;
  return {
    tag: 'select_static',
    name: 'thinking_level',
    placeholder: { tag: 'plain_text', content: '思考强度' },
    initial_option: initial,
    options: [FOLLOW_DEFAULT_OPTION, ...OMP_THINKING_LEVELS.map(thinkingOption)],
  };
}

/** Provider chooser card for `/model`. */
export function modelProviderCard(
  current: string | undefined,
  providers: ModelProviderInfo[],
  recents: RecentModel[] = [],
  commons: string[] = [],
  thinking?: string,
): object {
  /** 一段快捷选择（标题 + 并排按钮），空段整块不渲染。 */
  const section = (title: string, models: RecentModel[]): object[] => {
    const buttons = quickSetButtons(current, models);
    return buttons.length > 0 ? [{ tag: 'markdown', content: `**${title}**` }, ...buttons] : [];
  };
  // 顺序：最近使用 → 常用 → 提供方。最近使用是「我刚才在用的那个」，
  // 是这张卡最高频的动作，理应排在最前（此前常用在前，最近使用在中间）。
  const recentSection = section('🕘 最近使用', recents);
  // 常用没有使用记录，只是一份配置里的角色清单 → 无时间/次数尾注。
  const commonSection = section('⭐ 常用', commons.map((selector) => ({ selector })));
  // 提供方按钮：**当前提供方置首**，其余按模型数降序、同数按字母序 —— 打开这张卡
  // 多半是想在当前提供方里换个模型，先看到它（此前按 Map 插入序，cursor 永远第一）。
  const currentProvider = (current?.split('/')[0] ?? '').toLowerCase();
  const orderedProviders = [...providers].sort((a, b) => {
    const aCurrent = a.provider.toLowerCase() === currentProvider ? 0 : 1;
    const bCurrent = b.provider.toLowerCase() === currentProvider ? 0 : 1;
    if (aCurrent !== bCurrent) return aCurrent - bCurrent;
    if (a.count !== b.count) return b.count - a.count;
    return a.provider.localeCompare(b.provider);
  });
  const providerButtons = inlineActions(
    orderedProviders.map((p) => ({
      text: `${p.provider} (${p.count})`,
      style: p.provider.toLowerCase() === currentProvider ? ('primary' as const) : ('default' as const),
      value: { cmd: 'model.provider', arg: p.provider },
    })),
  );
  return {
    schema: '2.0',
    config: { summary: { content: '🎛 切换模型' } },
    body: {
      elements: [
        { tag: 'markdown', content: '🎛 **切换模型**', text_size: 'heading' },
        {
          tag: 'markdown',
          content: `当前 ${formatCurrent(current)} · 💭 思考 ${formatCurrent(thinking)}`,
          text_size: 'notation',
        },
        ...recentSection,
        ...commonSection,
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
  /** 全局最近使用的 selector，最新在前：本提供方命中的那些排到下拉最前面，
   * 并在名字后缀上「…前 / N 次」（时间与次数由命令层算好）。 */
  recents: RecentModel[] = [],
): object {
  const alphabetical = [...models].sort((a, b) => a.selector.localeCompare(b.selector));
  // 顺序：最近使用（按 recency）→ 其余按字母。模型列表有几十条时，「我刚用过」
  // 比「按字母排」有用得多。
  const recent = new Map(recents.map((r, i) => [r.selector, { rank: i, note: recentNote(r) }]));
  const sorted = [
    ...alphabetical
      .filter((m) => recent.has(m.selector))
      .sort((a, b) => recent.get(a.selector)!.rank - recent.get(b.selector)!.rank),
    ...alphabetical.filter((m) => !recent.has(m.selector)),
  ];
  // options 的 value 是完整 selector（provider/model）。用半段 id 永远匹配
  // 不上任何 option —— 预选会静默落到 sorted[0]，用户看到错误的"当前模型"。
  //
  // 预选只认「本提供方列表里真的有这个模型」：`current` 属于别的提供方时，
  // 预选 sorted[0] 会让用户「看一眼就点切换」就把模型换成别的（实测 provider=cursor、
  // current=futu/… 时预选 cursor/claude-4-sonnet）。这种情况**不预选**，只留
  // placeholder；真提交了也由 submit 明确回「未选择模型」，绝不静默用第一个。
  const inList = current !== undefined && sorted.some((m) => m.selector === current);
  const foreignCurrent = current !== undefined && !inList;
  const options = sorted.map((m) => {
    // 卡片标题已给出提供方，下拉里只留模型段；名字不同时附在后面。
    const short = modelShortLabel(m.selector);
    const label = m.name && m.name !== short ? `${short} (${m.name})` : short;
    // 命中的「最近使用」就是下拉最前面那几条 —— 在名字后写清「…前 / N 次」，
    // 用户不必先点开才知道哪条是刚才在用的。
    return {
      text: { tag: 'plain_text', content: label + (recent.get(m.selector)?.note ?? '') },
      value: m.selector,
    };
  });
  // 「最近用过的排在前面」只在**本提供方命中** recents 时才提 —— 否则 cursor 卡上
  // 明明一个最近用过的都没有，却在说这句话。
  const recentHits = sorted.filter((m) => recent.has(m.selector)).length;
  return {
    schema: '2.0',
    config: { summary: { content: `选择 ${provider} 模型` } },
    body: {
      elements: [
        { tag: 'markdown', content: `🎛 **${provider} 模型**`, text_size: 'heading' },
        {
          tag: 'markdown',
          content: `当前 ${formatCurrent(current)} · 💭 思考 ${formatCurrent(thinking)}` +
            (foreignCurrent ? ' · ⚠️ 当前模型不属于该提供方' : '') +
            (recentHits > 0 ? ' · _下拉里最近用过的排在前面_' : ''),
          text_size: 'notation',
        },
        {
          tag: 'form',
          name: 'model_form',
          elements: [
            {
              tag: 'select_static',
              name: 'model_selector',
              placeholder: { tag: 'plain_text', content: '选择一个模型' },
              ...(inList ? { initial_option: current } : {}),
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
        { tag: 'markdown', content: `✅ **模型已设为** \`${escapeCode(model)}\``, text_size: 'heading' },
        { tag: 'markdown', content: '_下一条消息生效。_', text_size: 'notation' },
        ...stackedPanels([
          panel([
            md('**🎛 模型信息**'),
            md(`**模型**: \`${escapeCode(model)}\``),
            md(`**💭 思考强度**: ${thinking ? `\`${escapeCode(thinking)}\`` : '_跟随 OMP 默认_'}`),
          ]),
        ]),
      ],
    },
  };
}

/**
 * Thinking level picker form card.
 *
 * `supported` 是当前模型的能力集合（缓存里的 `ModelInfo.thinking`）：
 * - `undefined` = **不知道**（没设模型 / 模型不在缓存里，例如被过滤后直接指定的）
 *   → 不限制档位，全都放出来；
 * - `[]` = 模型明确不支持思考强度（本机 328 个模型里 110 个如此）→ 只留「跟随默认」。
 */
export function thinkingCard(current?: string, supported?: string[]): object {
  const cap = supported === undefined ? undefined : new Set(supported.filter(isOmpThinkingLevel));
  const currentLevel = current && isOmpThinkingLevel(current) ? current : undefined;
  let levels = OMP_THINKING_LEVELS.filter((lv) => cap === undefined || cap.has(lv));
  // 当前档位不在支持集合里（换过模型）时也要留在列表里：否则预选只能落到「跟随默认」，
  // 与标题上写的当前值互相矛盾。
  if (currentLevel && !levels.includes(currentLevel)) levels = [currentLevel, ...levels];
  const unsupported = cap !== undefined && cap.size === 0;
  return {
    schema: '2.0',
    config: { summary: { content: '切换思考强度' } },
    body: {
      elements: [
        { tag: 'markdown', content: '💭 **思考强度**', text_size: 'heading' },
        {
          tag: 'markdown',
          content:
            `当前: ` + (currentLevel ? `\`${currentLevel}\`` : '_跟随 OMP 默认_') +
            (unsupported ? '（该模型不支持思考强度）' : ''),
          text_size: 'notation',
        },
        { tag: 'markdown', content: '_只作用于当前模型，不影响模型切换_', text_size: 'notation' },
        {
          tag: 'form',
          name: 'thinking_form',
          elements: [
            {
              tag: 'select_static',
              name: 'thinking_level',
              placeholder: { tag: 'plain_text', content: '思考强度' },
              // 预选必须与标题一致：`current` 没设就是「跟随默认」，不再预选 `auto`。
              initial_option: currentLevel ?? THINKING_FOLLOW_DEFAULT,
              options: [FOLLOW_DEFAULT_OPTION, ...levels.map(thinkingOption)],
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
  // 卡片路径也能「回到默认」（`__default`）：这时显示的是跟随默认，不是那个哨兵值。
  const label = level === THINKING_FOLLOW_DEFAULT ? '_跟随 OMP 默认_' : `\`${level}\``;
  return {
    schema: '2.0',
    config: { summary: { content: '思考强度已切换' } },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: `✅ **思考强度已设为** ${label}`,
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
    body: { elements: [{ tag: 'markdown', content: '已取消，未做任何修改。' }] },
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


export function resumeSavedCard(info: ContextInfo): object {
  // 与 /status 同一套灰底面板（contextPanels），不再把 renderContext 的纯文本
  // 整段塞进来 —— 用户要求切换会话后的状态展示与其它卡片统一风格。
  return {
    schema: '2.0',
    config: { summary: { content: '会话已恢复' } },
    body: {
      elements: [
        { tag: 'markdown', content: '✅ **会话已恢复**', text_size: 'heading' },
        // 只留 cwd：会话 id 就在下面「🗂 会话」面板里，别在同一张卡上写两遍。
        {
          tag: 'markdown',
          content: `📁 \`${escapeCode(shortPath(info.cwd))}\``,
          text_size: 'notation',
        },
        { tag: 'markdown', content: '_下一条消息从该会话继续。_', text_size: 'notation' },
        ...contextPanels(info),
        ...(info.sessionStale
          ? [
              {
                tag: 'markdown',
                content: '⚠️ _session 来自旧 cwd，下一条消息将新建会话_',
                text_size: 'notation',
              },
            ]
          : []),
      ],
    },
  };
}


export function modelCancelledCard(): object {
  return {
    schema: '2.0',
    config: { summary: { content: '已取消' } },
    body: { elements: [{ tag: 'markdown', content: '已取消，未做任何修改。' }] },
  };
}
