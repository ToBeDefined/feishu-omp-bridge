import type { AgentUiRequest, AgentUiResponse } from '../agent/types';
import { escapeMd } from '../utils/text';
import { inlineRow, panel, stackedPanels } from './templates';

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

export function renderOmpUiRequestCard(
  request: AgentUiRequest,
  scope?: string,
  /**
   * 倒计时：剩余秒数由调用方（读时钟的那一层）算好传入，本函数保持纯粹 ——
   * 同一张卡在不同 tick 传不同值，卡片自己永远不读 `Date.now()`。
   * 不传时退回按 `request.timeout` 渲染的总时长文案（无倒计时的老路径）。
   */
  opts: { remainingSeconds?: number } = {},
): object {
  const elements: object[] = [
    { tag: 'markdown', content: `🧩 **${escapeMd(request.title)}**`, text_size: 'heading' },
    markdown(introText(request)),
  ];

  const timeout = 'timeout' in request ? request.timeout : undefined;
  const remaining = opts.remainingSeconds;
  if (remaining !== undefined) {
    elements.push(
      markdown(`_⏳ 剩余 ${Math.max(0, Math.floor(remaining))} 秒；超时后按取消处理。_`),
    );
  } else if (timeout !== undefined && timeout > 0) {
    elements.push(
      markdown(`_此请求有超时限制：${Math.ceil(timeout / 1000)} 秒；超时后按取消处理。_`),
    );
  }

  if (request.method === 'confirm') {
    // 要用户确认的那句话是这张卡的「内容」：进灰底块，与说明文字和按钮分开
    // （OMP 卡片里唯一值得读的一段文字）。
    elements.push(
      ...stackedPanels([
        panel([{ tag: 'markdown', content: request.message, text_size: 'notation' }]),
      ]),
    );
    // 规则 1 + 2：确认 / 否 并排，退路动作「取消」单独一行铺满。
    // 这里刻意保留 `behaviors`（表单按钮同款）而不换成顶层 `value` —— OMP 扩展 UI 的
    // 回包链路最关键，不动它的投递方式；`inlineRow` 只负责排版。
    elements.push(
      ...inlineRow([
        { element: uiButton('确认', 'primary', callbackValue(request, 'confirm', scope)) },
        { element: uiButton('否', 'default', callbackValue(request, 'deny', scope)) },
      ]),
      ...inlineRow([{ element: uiButton('取消', 'danger', callbackValue(request, 'cancel', scope)) }]),
    );
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

/** 结果卡回声值的最长展示长度（超出截断，避免一段超长输入把卡撑爆）。 */
const RESULT_ECHO_MAX = 200;

export function renderOmpUiResultCard(
  title: string,
  status: 'submitted' | 'cancelled' | 'timed_out' | 'unavailable',
  /** 用户所选 / 提交的值（由调用方从 payload/formValue 取出）——回显在结果卡上，
   * 否则用户事后翻记录看不到自己选了什么。 */
  echo?: string,
): object {
  const text =
    status === 'submitted'
      ? '✅ 已提交给 OMP。'
      : status === 'cancelled'
        ? '已取消，OMP 会按取消处理。'
        : status === 'timed_out'
          ? '⏱ 已超时，OMP 会按取消处理。'
          : '⚠️ 当前 OMP 任务已结束，无法提交这个交互。';
  const elements: object[] = [markdown(`🧩 **${escapeMd(title)}**`), markdown(text)];
  if (echo !== undefined && echo !== '') {
    const flat = echo.replace(/\s+/g, ' ').trim();
    const shown = flat.length > RESULT_ECHO_MAX ? `${flat.slice(0, RESULT_ECHO_MAX)}…` : flat;
    elements.push(markdown(`✅ 已提交：**${escapeMd(shown)}**`));
  }
  return shell('OMP 交互已处理', elements);
}

function form(request: AgentUiRequest, elements: object[], scope?: string): object {
  return {
    tag: 'form',
    name: `omp_ui_${request.id}`,
    elements: [
      ...elements,
      ...inlineRow([{ element: { tag: 'button', text: { tag: 'plain_text', content: '提交' }, type: 'primary', form_action_type: 'submit', behaviors: [{ type: 'callback', value: callbackValue(request, 'submit', scope) }], } }]),
      ...inlineRow([{ element: { tag: 'button', text: { tag: 'plain_text', content: '取消' }, type: 'danger', behaviors: [{ type: 'callback', value: callbackValue(request, 'cancel', scope) }], } }]),
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


/** OMP 交互按钮：点回包走 `behaviors`（与表单按钮同一套投递方式）。 */
function uiButton(
  text: string,
  type: 'primary' | 'default' | 'danger',
  value: Record<string, unknown>,
): object {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: text },
    type,
    behaviors: [{ type: 'callback', value }],
  };
}

function callbackValue(
  request: AgentUiRequest,
  action: string,
  scope?: string,
): Record<string, unknown> {
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

