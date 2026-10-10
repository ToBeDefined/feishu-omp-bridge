import { summarizeMd } from '../utils/text';
import { isOmpThinkingLevel, OMP_THINKING_LEVELS } from '../config/schema';
import { actions, shortPath, type ButtonSpec } from './templates';
import { escapeCode, escapeMd } from '../utils/text';
import { formatAgo } from '../utils/time';

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

/** Recent model selector buttons, shown as quick-set. */
function modelRecentButtons(current: string | undefined, recents: string[]): object[] {
  const items = recents.filter((m) => m !== current);
  return items.map((m) => ({
    tag: 'button',
    text: { tag: 'plain_text', content: m },
    type: 'default',
    value: { cmd: 'model.use', arg: m },
  }));
}

/** Common (modelRoles) model buttons, shown as quick-set. */
function modelCommonButtons(current: string | undefined, commons: string[]): object[] {
  const items = commons.filter((m) => m !== current);
  return items.map((m) => ({
    tag: 'button',
    text: { tag: 'plain_text', content: m },
    type: 'default',
    value: { cmd: 'model.use', arg: m },
  }));
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
  const lines = [
    `当前模型：` + formatCurrent(current),
    `思考强度：` + formatCurrent(thinking),
  ];
  const commonButtons = modelCommonButtons(current, commons);
  const commonBlock: object[] =
    commonButtons.length > 0
      ? [{ tag: 'markdown', content: '\n**常用**' }, ...commonButtons, { tag: 'hr' }]
      : [];
  const recentButtons = modelRecentButtons(current, recents);
  const recentBlock: object[] =
    recentButtons.length > 0
      ? [{ tag: 'markdown', content: '\n**最近使用**' }, ...recentButtons, { tag: 'hr' }]
      : [];
  const buttons = providers.map((p) => ({
    tag: 'button',
    text: { tag: 'plain_text', content: `${p.provider} (${p.count})` },
    type: p.provider.toLowerCase() === (current?.split('/')[0] ?? '') ? 'primary' : 'default',
    value: { cmd: 'model.provider', arg: p.provider },
  }));
  buttons.push({
    tag: 'button',
    text: { tag: 'plain_text', content: '回退默认' },
    type: current ? 'default' : 'primary',
    value: { cmd: 'model.reset', arg: '' },
  });
  buttons.push({
    tag: 'button',
    text: { tag: 'plain_text', content: '取消' },
    type: 'default',
    value: { cmd: 'model.cancel', arg: '' },
  });
  return {
    schema: '2.0',
    config: { summary: { content: '切换模型' } },
    body: {
      elements: [
        { tag: 'markdown', content: '🎛 **切换模型**', text_size: 'heading' },
        { tag: 'markdown', content: lines.join('\n') },
        ...commonBlock,
        ...recentBlock,
        { tag: 'markdown', content: '\n**选择提供方**' },
        ...buttons,
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
): object {
  const sorted = [...models].sort((a, b) => a.selector.localeCompare(b.selector));
  // options 的 value 是完整 selector（provider/model）。用半段 id 永远匹配
  // 不上任何 option —— 预选会静默落到 sorted[0]，用户看到错误的"当前模型"。
  const initial =
    current && sorted.some((m) => m.selector === current)
      ? current
      : sorted[0]?.selector;
  const options = sorted.map((m) => {
    const label = m.name && m.name !== m.selector ? `${m.selector} (${m.name})` : m.selector;
    return { text: { tag: 'plain_text', content: label }, value: m.selector };
  });
  return {
    schema: '2.0',
    config: { summary: { content: `选择 ${provider} 模型` } },
    body: {
      elements: [
        {
          tag: 'markdown',
          text_size: 'heading',
          content:
            `🎛 **${provider} 模型**\n` +
            `当前模型：` + formatCurrent(current) +
            `\n思考强度：` + formatCurrent(thinking),
        },
        { tag: 'hr' },
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
            {
              tag: 'column_set',
              flex_mode: 'flow',
              horizontal_spacing: 'small',
              columns: [
                {
                  tag: 'column',
                  width: 'auto',
                  elements: [
                    {
                      tag: 'button',
                      name: 'submit_btn',
                      text: { tag: 'plain_text', content: '切换' },
                      type: 'primary',
                      form_action_type: 'submit',
                      behaviors: [{ type: 'callback', value: { cmd: 'model.submit' } }],
                    },
                  ],
                },
                {
                  tag: 'column',
                  width: 'auto',
                  elements: [
                    {
                      tag: 'button',
                      name: 'cancel_btn',
                      text: { tag: 'plain_text', content: '取消' },
                      behaviors: [{ type: 'callback', value: { cmd: 'model.cancel' } }],
                    },
                  ],
                },
              ],
            },
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
            {
              tag: 'column_set',
              flex_mode: 'flow',
              horizontal_spacing: 'small',
              columns: [
                {
                  tag: 'column',
                  width: 'auto',
                  elements: [
                    {
                      tag: 'button',
                      name: 'submit_btn',
                      text: { tag: 'plain_text', content: '切换' },
                      type: 'primary',
                      form_action_type: 'submit',
                      behaviors: [{ type: 'callback', value: { cmd: 'thinking.submit' } }],
                    },
                  ],
                },
                {
                  tag: 'column',
                  width: 'auto',
                  elements: [
                    {
                      tag: 'button',
                      name: 'cancel_btn',
                      text: { tag: 'plain_text', content: '取消' },
                      behaviors: [{ type: 'callback', value: { cmd: 'thinking.cancel' } }],
                    },
                  ],
                },
              ],
            },
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
  sessionId: string;
  cwd: string;
  timestamp: string;
  /** User-assigned display title (/rename), if any. Shown ahead of the
   * auto summary so the user can tell sessions apart by name. */
  title?: string;
  /** Short description of what the conversation was about (last assistant
   * text reply). Absent for empty/short-lived sessions. */
  summary?: string;
  /** The last real message the user sent in this session. */
  lastMessage?: string;
}

/** First 8 chars of a session id — the compact per-row handle in the
 * `/resume` list, where 20 full ULIDs would swamp the row. Singular
 * "this is your session" lines show the id in full. */
function shortId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}

/** Session picker card for `/resume`. One compact row per session:
 * title/summary + time · cwd · id on the left, a one-click 恢复 button
 * on the right. */
export function resumeCard(
  current: string | undefined,
  sessions: ResumeOption[],
  opts: { offset?: number; total?: number } = {},
): object {
  const offset = opts.offset ?? 0;
  const total = opts.total ?? sessions.length;
  const elements: object[] = [
    { tag: 'markdown', content: '🕘 **恢复会话**', text_size: 'heading' },
    {
      tag: 'markdown',
      content:
        '当前：' +
        (current ? `\`${escapeCode(current)}\`` : '_无_') +
        ' · 点击右侧按钮一键恢复',
      text_size: 'notation',
    },
    { tag: 'hr' },
  ];

  sessions.forEach((s, i) => {
    const isCurrent = current !== undefined && s.sessionId === current;
    const num = `#${offset + i + 1}`;
    // Named session → title leads, summary becomes a detail line; unnamed →
    // the summary IS the identity; neither → placeholder.
    const heading = s.title
      ? `${num} 🏷 **${escapeMd(s.title)}**`
      : s.summary
        ? `${num} **${summarizeMd(s.summary, 24)}**`
        : `${num} _未命名会话_`;
    const tsMs = Date.parse(s.timestamp);
    const metaParts = [
      Number.isFinite(tsMs) ? formatAgo(Date.now() - tsMs) : '',
      `\`${escapeCode(shortPath(s.cwd))}\``,
      escapeMd(shortId(s.sessionId)),
    ].filter(Boolean);
    const details: object[] = [
      { tag: 'markdown', content: heading },
      {
        tag: 'markdown',
        content: metaParts.join(' · '),
        text_size: 'notation',
      },
    ];
    if (s.title && s.summary) {
      details.push({
        tag: 'markdown',
        content: `📝 ${summarizeMd(s.summary, 48)}`,
        text_size: 'notation',
      });
    }
    if (s.lastMessage) {
      details.push({
        tag: 'markdown',
        content: `💬 ${summarizeMd(s.lastMessage, 48)}`,
        text_size: 'notation',
      });
    }
    elements.push({
      tag: 'column_set',
      flex_mode: 'none',
      horizontal_spacing: 'small',
      columns: [
        { tag: 'column', width: 'weighted', weight: 1, vertical_align: 'center', elements: details },
        {
          tag: 'column',
          width: 'auto',
          vertical_align: 'center',
          elements: [
            {
              tag: 'button',
              text: { tag: 'plain_text', content: isCurrent ? '✓ 当前' : '恢复' },
              type: isCurrent ? 'default' : 'primary',
              // Keep the value so the click still resolves to this session, but a
              // current-session switch is a no-op in applyResume.
              value: { cmd: 'resume.use', arg: s.sessionId },
            },
          ],
        },
      ],
    });
    if (i < sessions.length - 1) elements.push({ tag: 'hr' });
  });

  const remaining = Math.max(0, total - (offset + sessions.length));
  const pageSize = sessions.length;
  const footer: ButtonSpec[] = [];
  if (offset > 0) {
    footer.push({
      text: '↑ 较新的会话',
      value: { cmd: 'resume.back', arg: String(Math.max(0, offset - pageSize)) },
    });
  }
  if (remaining > 0) {
    footer.push({
      text: `↓ 更早（剩 ${remaining}）`,
      value: { cmd: 'resume.more', arg: String(offset + sessions.length) },
    });
  }
  footer.push({ text: '取消', value: { cmd: 'resume.cancel', arg: '' } });
  elements.push(
    { tag: 'hr' },
    {
      tag: 'markdown',
      content: `第 ${offset + 1}-${offset + pageSize} 条 / 共 ${total} 条`,
      text_size: 'notation',
    },
    // 2-per-row equal columns — 3 auto columns squeezed the labels together.
    ...actions(footer),
  );
  return {
    schema: '2.0',
    config: { summary: { content: '恢复会话' } },
    body: { elements },
  };
}

export function resumeCancelledCard(): object {
  return {
    schema: '2.0',
    config: { summary: { content: '已取消' } },
    body: { elements: [{ tag: 'markdown', content: '已取消,未做修改。' }] },
  };
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
