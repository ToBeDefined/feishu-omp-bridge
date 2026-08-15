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

/** Provider chooser card for `/model`. */
export function modelProviderCard(
  current: string | undefined,
  providers: ModelProviderInfo[],
): object {
  const lines = [
    '🎛️ **切换模型**',
    '',
    `当前:` + (current ? `\`${current}\`` : '_跟随 OMP 默认_'),
    '',
    '选择提供方,再选具体模型。',
  ];
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
  return {
    schema: '2.0',
    config: { summary: { content: '切换模型' } },
    body: { elements: [{ tag: 'markdown', content: lines.join('\n') }, { tag: 'hr' }, ...buttons] },
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

/** Post-set confirmation card. */
export function modelSavedCard(model: string): object {
  return {
    schema: '2.0',
    config: { summary: { content: '模型已切换' } },
    body: {
      elements: [
        { tag: 'markdown', content: `✅ **模型已设为** \`${model}\`\n\n下一条消息生效。` },
      ],
    },
  };
}

export function modelCancelledCard(): object {
  return {
    schema: '2.0',
    config: { summary: { content: '已取消' } },
    body: { elements: [{ tag: 'markdown', content: '已取消,未做修改。' }] },
  };
}
