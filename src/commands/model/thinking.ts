import { getOmpThinking } from '../../config/schema';
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
      if (/^(auto|off|minimal|low|medium|high|xhigh|max)$/.test(trimmed)) {
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

async function setThinking(level: string, ctx: CommandContext, current: string | undefined): Promise<void> {
  if (!level || !/^(auto|off|minimal|low|medium|high|xhigh|max)$/.test(level)) {
    await reply(ctx, '❌ 合法值:`off|minimal|low|medium|high|xhigh|max|auto`');
    return;
  }
  const cfg = ctx.controls.cfg;
  cfg.preferences = { ...(cfg.preferences ?? {}), ompThinking: level };
  await saveConfig(cfg, ctx.controls.configPath);
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
  cfg.preferences = { ...(cfg.preferences ?? {}), ompThinking: undefined };
  await saveConfig(cfg, ctx.controls.configPath);
  log.info('command', 'thinking-reset', { scope: ctx.scope });
  await reply(ctx, '✅ 已清除思考强度设置,回退 OMP 默认。下一条消息生效。');
}
