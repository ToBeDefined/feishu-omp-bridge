// Card builder for agent-authored Feishu interactive cards.

import { OMP_UI_MARKER } from './omp-ui';
import { inlineRow } from './templates';
import { escapeMd } from '../utils/text';

/**
 * Marker key on a button's `value` object that flags the cardAction as a
 * callback that should be forwarded back to the agent instead of dispatched
 * to a built-in command handler. Must match the constant the dispatcher
 * checks in `bot/card-dispatcher.ts`.
 */
export const AGENT_CALLBACK_MARKER = '__codex_cb';

/**
 * 桥自己发出的 agent 卡片按钮上的「发行标记」。模型可以自己发卡片（manually
 * crafted via lark-cli 或 feishu_send_card），但只有 bridge 会盖上这些标记 ——
 * dispatcher 只在标记存在时才做过期 / run 校验，手工卡片行为不变。
 */
/** 发行时间（epoch ms）：超过 TTL 的按钮按「任务已结束」处理。 */
export const AGENT_MARK_ISSUED_AT = '__omp_iat';
/** 发行作用域：点击时该作用域必须仍有在跑的 run。 */
export const AGENT_MARK_SCOPE = '__omp_scope';
/** 发行时的 run token：作用域里换了 run（旧任务结束 / /new）即失效。 */
export const AGENT_MARK_RUN = '__omp_run';

/** 桥注入的发行标记 key 全集（用于剔除，别透传给 agent）。 */
export const AGENT_MARK_KEYS = [
  AGENT_MARK_ISSUED_AT,
  AGENT_MARK_SCOPE,
  AGENT_MARK_RUN,
] as const;

/**
 * Keys the bridge injects into a button's `value` for its own routing. The
 * model supplies `value` verbatim, so any of these appearing there would let
 * a model-authored button forge a bridge-internal callback (agent callback
 * or OMP-UI response) — rejected below.
 */
const RESERVED_VALUE_KEYS = [
  OMP_UI_MARKER,
  AGENT_CALLBACK_MARKER,
  ...AGENT_MARK_KEYS,
] as const;

/** 桥发行 agent 卡片时盖在按钮 value 上的标记（由调用方提供，卡片层不做取数）。 */
export interface AgentCardMarks {
  issuedAt?: number;
  scope?: string;
  run?: string;
}

export interface AgentCardButton {
  label: string;
  value: Record<string, unknown>;
}

/** Column-set row cap — Feishu rejects oversized cards; keep buttons sane. */
const MAX_BUTTONS = 10;
/** Markdown body cap — matches the text-block split used elsewhere. */
const MAX_TEXT_CHARS = 4000;

/**
 * Build a CardKit 2.0 card from a high-level shape: a markdown body plus a
 * row of callback buttons. Every button's value gets the agent-callback
 * marker injected, so clicks land back in the agent's session via the
 * existing `forwardToAgent` path.
 */
export function buildAgentCard(
  title: string,
  text: string,
  buttons: unknown,
  /** 桥发行标记：由调用方（feishu-host）传入发行时间 / 作用域 / run token。 */
  marks?: AgentCardMarks,
): object {
  if (!Array.isArray(buttons) || buttons.length === 0) {
    throw new Error('buttons is required (at least one button)');
  }
  if (buttons.length > MAX_BUTTONS) {
    throw new Error(`buttons 最多 ${MAX_BUTTONS} 个按钮，收到 ${buttons.length} 个`);
  }
  if (text.length > MAX_TEXT_CHARS) {
    throw new Error(`正文过长：最多 ${MAX_TEXT_CHARS} 字符，收到 ${text.length} 字符`);
  }
  const markValue: Record<string, unknown> = {};
  if (marks?.issuedAt !== undefined) markValue[AGENT_MARK_ISSUED_AT] = marks.issuedAt;
  if (marks?.scope) markValue[AGENT_MARK_SCOPE] = marks.scope;
  if (marks?.run) markValue[AGENT_MARK_RUN] = marks.run;
  const normalized = buttons.map((raw) => {
    const b = raw as Partial<AgentCardButton> | null;
    const label = typeof b?.label === 'string' && b.label.trim() ? b.label : '';
    const value = b?.value && typeof b.value === 'object' && !Array.isArray(b.value) ? b.value : undefined;
    if (!label || !value) {
      throw new Error('each button requires label (string) and value (object)');
    }
    for (const key of RESERVED_VALUE_KEYS) {
      if (key in value) {
        throw new Error(`按钮 value 不允许包含保留字段 ${key}（由 bridge 注入，模型不可覆盖）`);
      }
    }
    return { label, value };
  });

  return {
    schema: '2.0',
    config: { summary: { content: title } },
    body: {
      elements: [
        // Same S1 shape as every other card: a heading line first. `title` is
        // model-supplied, so it is markdown-escaped (it still feeds `summary`).
        { tag: 'markdown', content: `🤖 **${escapeMd(title)}**`, text_size: 'heading' },
        { tag: 'markdown', content: text },
        // Buttons go through `inlineRow` like the rest of the site: `weighted`
        // columns under `flex_mode: 'none'`, at most 2 per row (the old
        // `flex_mode: 'flow'` + `width: 'auto'` let widths drift per label).
        ...inlineRow(
          normalized.map(({ label, value }, i) => ({
            element: {
              tag: 'button',
              text: { tag: 'plain_text', content: label },
              name: label,
              type: i === 0 ? 'primary' : 'default',
              behaviors: [
                { type: 'callback', value: { ...value, ...markValue, [AGENT_CALLBACK_MARKER]: true } },
              ],
            },
          })),
        ),
      ],
    },
  };
}
