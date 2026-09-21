import { getOmpThinking, isOmpThinkingLevel } from '../../config/schema';
import type { AppPreferences } from '../../config/schema';
import { saveConfig } from '../../config/store';
import { forgetManagedCard, sendManagedCard, updateManagedCard } from '../../card/managed';
import {
  thinkingCancelledCard,
  thinkingCard,
  thinkingSavedCard,
} from '../../card/model-card';
import type { CommandContext, Handler } from '../index';
import { FORM_SETTLE_MS, recallMessage, reply } from '../shared';
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
      return setThinking(rest.join(' '), ctx, current);
    case 'submit':
      return submitThinking(ctx, current);
    case 'cancel':
      return cancelThinking(ctx);
    case 'reset':
      return resetThinking(ctx, current);
    default:
      if (trimmed === '') return showThinkingPicker(ctx, current);
      if (isOmpThinkingLevel(trimmed)) {
        return setThinking(trimmed, ctx, current);
      }
      await reply(
        ctx,
        '❌ 用法:`/thinking` 打开选择卡片,或 `/thinking <level>`(`off|minimal|low|medium|high|xhigh|max|auto`)。',
      );
  }
}

async function showThinkingPicker(ctx: CommandContext, current: string | undefined): Promise<void> {
  if (ctx.fromCardAction) await recallMessage(ctx, ctx.msg.messageId);
  await sendManagedCard(ctx.channel, ctx.msg.chatId, thinkingCard(current));
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
      const formMsgId = ctx.msg.messageId;
      void (async () => {
        await new Promise((r) => setTimeout(r, FORM_SETTLE_MS));
        await updateManagedCard(ctx.channel, formMsgId, thinkingCancelledCard()).catch(() => {});
        forgetManagedCard(formMsgId);
      })();
    }
    return false;
  }
  ctx.controls.cfg.preferences = nextPreferences;
  return true;
}

async function setThinking(level: string, ctx: CommandContext, current: string | undefined): Promise<void> {
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
    const formMsgId = ctx.msg.messageId;
    void (async () => {
      await new Promise((r) => setTimeout(r, FORM_SETTLE_MS));
      await updateManagedCard(ctx.channel, formMsgId, thinkingSavedCard(level)).catch(() => {});
      forgetManagedCard(formMsgId);
    })();
  } else {
    await reply(ctx, `✅ 思考强度已设为 \`${level}\`。下一条消息生效。`);
  }
}

async function submitThinking(ctx: CommandContext, current: string | undefined): Promise<void> {
  const level = String(ctx.formValue?.thinking_level ?? '').trim();
  if (!level) {
    await reply(ctx, '未选择思考强度,已取消。');
    return;
  }
  await setThinking(level, ctx, current);
}

async function cancelThinking(ctx: CommandContext): Promise<void> {
  if (!ctx.fromCardAction) return;
  const formMsgId = ctx.msg.messageId;
  void (async () => {
    await new Promise((r) => setTimeout(r, FORM_SETTLE_MS));
    await updateManagedCard(ctx.channel, formMsgId, thinkingCancelledCard()).catch(() => {});
    forgetManagedCard(formMsgId);
  })();
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
  await reply(ctx, '✅ 已清除思考强度设置,回退 OMP 默认。下一条消息生效。');
}
