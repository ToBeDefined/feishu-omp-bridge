import { homedir } from 'node:os';

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

/** Provider chooser card for `/model`. */
export function modelProviderCard(
  current: string | undefined,
  providers: ModelProviderInfo[],
  recents: string[] = [],
  commons: string[] = [],
): object {
  const lines = [
    '🎛️ **切换模型**',
    '',
    `当前:` + (current ? `\`${current}\`` : '_跟随 OMP 默认_'),
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
): object {
  const currentId = current?.split('/')[1] ?? '';
  const sorted = [...models].sort((a, b) => a.selector.localeCompare(b.selector));
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
          content:
            `🎛️ **${provider} 模型**\n` +
            `当前:` + (current ? `\`${current}\`` : '_跟随 OMP 默认_'),
        },
        { tag: 'hr' },
        {
          tag: 'form',
          name: 'model_form',
          elements: [
            {
              tag: 'select_static',
              name: 'model_selector',
              initial_option: currentId || sorted[0]?.selector,
              options,
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
  const lines = [`✅ **模型已设为** \`${model}\``];
  lines.push(`🧠 **思考强度**:${thinking ? `\`${thinking}\`` : '_跟随 OMP 默认_'}`);
  lines.push('', '下一条消息生效。');
  return {
    schema: '2.0',
    config: { summary: { content: '模型已切换' } },
    body: { elements: [{ tag: 'markdown', content: lines.join('\n') }] },
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
          content:
            `🧠 **思考强度**\n` +
            `当前:` + (current ? `\`${current}\`` : '_跟随 OMP 默认_') +
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
        { tag: 'markdown', content: `✅ **思考强度已设为** \`${level}\`\n\n下一条消息生效。` },
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
  /** Short description of what the conversation was about (last assistant
   * text reply). Absent for empty/short-lived sessions. */
  summary?: string;
  /** The last real message the user sent in this session. */
  lastMessage?: string;
}

/** Session picker card for `/resume`. */
export function resumeCard(
  current: string | undefined,
  sessions: ResumeOption[],
  opts: { offset?: number; total?: number } = {},
): object {
  const offset = opts.offset ?? 0;
  const total = opts.total ?? sessions.length;
  const lines = [
    '🕘 **恢复会话**',
    '',
    `当前会话:` + (current ? `\`${current}\`` : '（无）'),
    '',
    '选择要恢复的历史会话。',
  ];
  // Each session renders as a structured description block (folder, last
  // message, last reply, id) followed by a single switch button. The current
  // session gets a marker and a disabled-looking state (it's already active).
  const blocks: object[] = [];
  for (const s of sessions) {
    const isCurrent = current !== undefined && s.sessionId === current;
    const desc = s.summary ? summarize(s.summary) : '';
    const md = [
      isCurrent ? '⭐ **当前会话**' : '',
      `📁 ${shortCwd(s.cwd)}`,
      s.lastMessage ? `💬 最后消息: ${summarize(s.lastMessage)}` : '',
      desc ? `📝 最后回复: ${desc}` : '',
      `🆔 \`${s.sessionId}\``,
    ]
      .filter(Boolean)
      .join('\n');
    blocks.push(
      { tag: 'markdown', content: md },
      {
        tag: 'button',
        text: { tag: 'plain_text', content: isCurrent ? '已在当前' : '切换到该会话' },
        type: isCurrent ? 'primary' : 'default',
        // Keep the value so the click still resolves to this session, but a
        // current-session switch is a no-op in applyResume.
        value: { cmd: 'resume.use', arg: s.sessionId },
      },
      { tag: 'hr' },
    );
  }
  const remaining = Math.max(0, total - (offset + sessions.length));
  const pageSize = sessions.length;
  const footer: object[] = [];
  const rangeInfo = `第 ${offset + 1}-${offset + pageSize} 条 / 共 ${total} 条`;
  if (offset > 0) {
    footer.push({
      tag: 'button',
      text: { tag: 'plain_text', content: '较新的会话' },
      type: 'default',
      value: { cmd: 'resume.back', arg: String(Math.max(0, offset - pageSize)) },
    });
  }
  if (remaining > 0) {
    footer.push({
      tag: 'button',
      text: { tag: 'plain_text', content: `加载更早 (剩余 ${remaining})` },
      type: 'default',
      value: { cmd: 'resume.more', arg: String(offset + sessions.length) },
    });
  }
  footer.push({
    tag: 'button',
    text: { tag: 'plain_text', content: '取消' },
    type: 'default',
    value: { cmd: 'resume.cancel', arg: '' },
  });
  return {
    schema: '2.0',
    config: { summary: { content: '恢复会话' } },
    body: {
      elements: [
        { tag: 'markdown', content: lines.join('\n') },
        { tag: 'hr' },
        ...blocks,
        ...(footer.length > 0
          ? [{ tag: 'markdown', content: `_${rangeInfo}_` }, ...footer]
          : []),
      ],
    },
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
  const content = [
    `✅ **已恢复会话** \`${sessionId}\``,
    `📁 cwd: \`${cwd}\``,
    '',
    '下一条消息从该会话继续。',
  ];
  if (context) {
    content.push('', '---', '', context);
  }
  return {
    schema: '2.0',
    config: { summary: { content: '会话已恢复' } },
    body: {
      elements: [{ tag: 'markdown', content: content.join('\n') }],
    },
  };
}

function shortCwd(cwd: string): string {
  const home = homedir();
  const rel = cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
  return rel.length > 24 ? `…${rel.slice(-24)}` : rel;
}

/** Compact a session description for a card button: collapse newlines, cap
 * length, append ellipsis if truncated. */
function summarize(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 32 ? `${flat.slice(0, 32)}…` : flat;
}

export function modelCancelledCard(): object {
  return {
    schema: '2.0',
    config: { summary: { content: '已取消' } },
    body: { elements: [{ tag: 'markdown', content: '已取消,未做修改。' }] },
  };
}
