import type { AgentUiRequest, AgentUiResponse } from '../agent/types';
import { escapeMd } from './templates';

export const OMP_UI_MARKER = '__omp_ui';
export const OMP_UI_VALUE_FIELD = 'omp_ui_value';

export function isOmpUiPayload(payload: Record<string, unknown>): boolean {
  return payload[OMP_UI_MARKER] === true;
}

export function ompUiRequestId(payload: Record<string, unknown>): string | undefined {
  return typeof payload.requestId === 'string' ? payload.requestId : undefined;
}

export function ompUiTitle(payload: Record<string, unknown>): string {
  return typeof payload.title === 'string' && payload.title.trim() ? payload.title : 'OMP 交互';
}

export function responseFromOmpUiAction(
  payload: Record<string, unknown>,
  formValue: Record<string, unknown> | undefined,
): AgentUiResponse | undefined {
  const action = typeof payload.action === 'string' ? payload.action : '';
  const method = typeof payload.method === 'string' ? payload.method : '';

  if (action === 'cancel') return { cancelled: true };
  if (method === 'confirm' && action === 'confirm') return { confirmed: true };
  if (method === 'confirm' && action === 'deny') return { confirmed: false };

  if (action === 'submit') {
    const raw = formValue?.[OMP_UI_VALUE_FIELD] ?? payload.value;
    return { value: normalizeFormValue(raw) };
  }
  return undefined;
}

export function renderOmpUiRequestCard(request: AgentUiRequest, scope?: string): object {
  const elements: object[] = [
    markdown(`🧩 **${escapeMd(request.title)}**`),
    markdown(introText(request)),
  ];

  const timeout = 'timeout' in request ? request.timeout : undefined;
  if (timeout !== undefined && timeout > 0) {
    elements.push(markdown(`_此请求有超时限制：${Math.ceil(timeout / 1000)} 秒_`));
  }

  if (request.method === 'confirm') {
    elements.push(markdown(request.message));
    elements.push({
      tag: 'column_set',
      flex_mode: 'flow',
      horizontal_spacing: 'small',
      columns: [
        { tag: 'column', width: 'auto', elements: [button('确认', 'primary', callbackValue(request, 'confirm', scope))] },
        { tag: 'column', width: 'auto', elements: [button('否', 'default', callbackValue(request, 'deny', scope))] },
        { tag: 'column', width: 'auto', elements: [button('取消', 'danger', callbackValue(request, 'cancel', scope))] },
      ],
    });
  } else if (request.method === 'select') {
    elements.push(form(request, [
      {
        tag: 'select_static',
        name: OMP_UI_VALUE_FIELD,
        options: request.options.map((option) => ({
          text: { tag: 'plain_text', content: option },
          value: option,
        })),
      },
    ], scope));
  } else if (request.method === 'input') {
    elements.push(form(request, [
      {
        tag: 'input',
        name: OMP_UI_VALUE_FIELD,
        placeholder: { tag: 'plain_text', content: request.placeholder ?? '请输入' },
        input_type: 'text',
      },
    ], scope));
  } else {
    elements.push(form(request, [
      {
        tag: 'input',
        name: OMP_UI_VALUE_FIELD,
        default_value: request.prefill ?? '',
        placeholder: { tag: 'plain_text', content: request.promptStyle ? '输入要发送给 OMP 的内容' : '请输入' },
        input_type: 'multiline_text',
      },
    ], scope));
  }

  return shell('等待 OMP 交互', elements);
}

export function renderOmpUiResultCard(title: string, status: 'submitted' | 'cancelled' | 'unavailable'): object {
  const text =
    status === 'submitted'
      ? '✅ 已提交给 OMP。'
      : status === 'cancelled'
        ? '已取消，OMP 会按取消处理。'
        : '⚠️ 当前 OMP 任务已结束，无法提交这个交互。';
  return shell('OMP 交互已处理', [markdown(`🧩 **${escapeMd(title)}**`), markdown(text)]);
}

function form(request: AgentUiRequest, elements: object[], scope?: string): object {
  return {
    tag: 'form',
    name: `omp_ui_${request.id}`,
    elements: [
      ...elements,
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
                text: { tag: 'plain_text', content: '提交' },
                type: 'primary',
                form_action_type: 'submit',
                behaviors: [{ type: 'callback', value: callbackValue(request, 'submit', scope) }],
              },
            ],
          },
          {
            tag: 'column',
            width: 'auto',
            elements: [
              {
                tag: 'button',
                text: { tag: 'plain_text', content: '取消' },
                type: 'danger',
                behaviors: [{ type: 'callback', value: callbackValue(request, 'cancel', scope) }],
              },
            ],
          },
        ],
      },
    ],
  };
}

function shell(summary: string, elements: object[]): object {
  return {
    schema: '2.0',
    config: { summary: { content: summary } },
    body: { elements },
  };
}

function markdown(content: string): object {
  return { tag: 'markdown', content };
}

function button(text: string, type: 'primary' | 'default' | 'danger', value: object): object {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: text },
    type,
    behaviors: [{ type: 'callback', value }],
  };
}

function callbackValue(request: AgentUiRequest, action: string, scope?: string): object {
  return {
    [OMP_UI_MARKER]: true,
    requestId: request.id,
    method: request.method,
    title: request.title,
    action,
    ...(scope ? { scope } : {}),
  };
}

function introText(request: AgentUiRequest): string {
  switch (request.method) {
    case 'select':
      return 'OMP 需要你选择一个选项。';
    case 'confirm':
      return 'OMP 需要你确认是否继续。';
    case 'input':
      return 'OMP 需要你输入一段文本。';
    case 'editor':
      return request.promptStyle ? 'OMP 需要你编辑即将发送的提示词。' : 'OMP 需要你编辑一段多行文本。';
  }
}

function normalizeFormValue(value: unknown): string {
  if (Array.isArray(value)) return value.length > 0 ? String(value[0] ?? '') : '';
  if (value === undefined || value === null) return '';
  return String(value);
}

