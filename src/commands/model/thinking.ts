import { getOmpModel, getOmpThinking, isOmpThinkingLevel } from '../../config/schema';
import type { AppPreferences } from '../../config/schema';
import { saveConfig } from '../../config/store';
import { sendManagedCard } from '../../card/managed';
import {
  THINKING_FOLLOW_DEFAULT,
  thinkingCancelledCard,
  thinkingCard,
  thinkingSavedCard,
} from '../../card/model-card';
import type { CommandContext, Handler } from '../index';
import { recallMessage, reply, settleManagedCard } from '../shared';
import { loadModelData } from './data';
import { log } from '../../core/logger';

export const thinkingHandlers: Record<string, Handler> = {
  '/thinking': handleThinking,
  '/think': handleThinking,
};

async function handleThinking(args: string, ctx: CommandContext): Promise<void> {
  const trimmed = args.trim();
  const cfg = ctx.controls.cfg;
  const current = getOmpThinking(cfg);

  const [sub, ...rest] = trimmed.split(/\s+/);
  switch (sub) {
    case '':
      return showThinkingPicker(ctx, current);
    case 'set':
      return setThinking(rest.join(' '), ctx);
    case 'submit':
      return submitThinking(ctx);
    case 'cancel':
      return cancelThinking(ctx);
    case 'reset':
      return resetThinking(ctx, current);
    default:
      if (trimmed === '') return showThinkingPicker(ctx, current);
      if (isOmpThinkingLevel(trimmed)) {
        return setThinking(trimmed, ctx);
      }
      await reply(
        ctx,
        '❌ 用法:`/thinking` 打开选择卡片,或 `/thinking <level>`(`off|minimal|low|medium|high|xhigh|max|auto`)。',
      );
  }
}

async function showThinkingPicker(ctx: CommandContext, current: string | undefined): Promise<void> {
  const data = await loadModelData(ctx.controls.cfg, false);
  // 能力看的是**当前模型**（`current` 是当前档位）：缓存里找不到（没设模型 /
  // 模型被过滤后直接指定的）就是「不知道」→ 不限制档位；找到了但 thinking 为空
  // = 该模型确实不支持思考强度。
  const model = getOmpModel(ctx.controls.cfg);
  const entry = model ? data.list.find((m) => m.selector === model) : undefined;
  if (ctx.fromCardAction) await recallMessage(ctx, ctx.msg.messageId);
  await sendManagedCard(
    ctx.channel,
    ctx.msg.chatId,
    thinkingCard(current, entry ? (entry.thinking ?? []) : undefined),
  );
}

/**
 * Persist a preferences change, surfacing a save failure to the user.
 * An unguarded `saveConfig` throws into runHandler's catch, which only logs:
 * the user gets no reply and the card keeps its live buttons, so the change
 * looks ignored. Returns false when the write failed (live config untouched).
 */
async function persistThinkingPreferences(
  ctx: CommandContext,
  nextPreferences: AppPreferences,
): Promise<boolean> {
  try {
    await saveConfig({ ...ctx.controls.cfg, preferences: nextPreferences }, ctx.controls.configPath);
  } catch (err) {
    log.fail('command', err, { step: 'thinking.save' });
    await reply(ctx, '❌ 保存思考强度设置失败，配置未改动，请稍后重试。');
    if (ctx.fromCardAction) {
      void settleManagedCard(ctx, thinkingCancelledCard(), '已取消，未做修改。');
    }
    return false;
  }
  ctx.controls.cfg.preferences = nextPreferences;
  return true;
}

async function setThinking(level: string, ctx: CommandContext): Promise<void> {
  if (!level || !isOmpThinkingLevel(level)) {
    await reply(ctx, '❌ 合法值:`off|minimal|low|medium|high|xhigh|max|auto`');
    return;
  }
  const cfg = ctx.controls.cfg;
  const nextPreferences = { ...(cfg.preferences ?? {}), ompThinking: level };
  if (!(await persistThinkingPreferences(ctx, nextPreferences))) return;
  log.info('command', 'thinking-set', {
    scope: ctx.scope,
    level,
    via: ctx.fromCardAction ? 'card' : 'text',
  });
  if (ctx.fromCardAction) {
    void settleManagedCard(ctx, thinkingSavedCard(level), `✅ 思考强度已设为 \`${level}\`。`);
  } else {
    await reply(ctx, `✅ 思考强度已设为 \`${level}\`。下一条消息生效。`);
  }
}

async function submitThinking(ctx: CommandContext): Promise<void> {
  const level = String(ctx.formValue?.thinking_level ?? '').trim();
  if (!level) {
    await reply(ctx, '未选择思考强度，未做修改。');
    return;
  }
  // 卡片里的「跟随 OMP 默认」= 清掉 ompThinking —— 否则卡片路径回不到默认。
  if (level === THINKING_FOLLOW_DEFAULT) {
    return resetThinking(ctx, getOmpThinking(ctx.controls.cfg));
  }
  await setThinking(level, ctx);
}

async function cancelThinking(ctx: CommandContext): Promise<void> {
  if (!ctx.fromCardAction) return;
  void settleManagedCard(ctx, thinkingCancelledCard(), '已取消，未做修改。');
}

async function resetThinking(ctx: CommandContext, current: string | undefined): Promise<void> {
  const cfg = ctx.controls.cfg;
  if (!current) {
    await reply(ctx, '本来就没设置过思考强度,一直跟随 OMP 默认。');
    return;
  }
  const nextPreferences = { ...(cfg.preferences ?? {}), ompThinking: undefined };
  if (!(await persistThinkingPreferences(ctx, nextPreferences))) return;
  log.info('command', 'thinking-reset', { scope: ctx.scope });
  if (ctx.fromCardAction) {
    // 卡片上选「跟随 OMP 默认」也要把卡片收尾（否则点完还是原样、看不出生效）。
    void settleManagedCard(
      ctx,
      thinkingSavedCard(THINKING_FOLLOW_DEFAULT),
      '✅ 已回退 OMP 默认思考强度。下一条消息生效。',
    );
    return;
  }
  await reply(ctx, '✅ 已清除思考强度设置,回退 OMP 默认。下一条消息生效。');
}
