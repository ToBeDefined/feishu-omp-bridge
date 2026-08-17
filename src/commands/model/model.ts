import { getOmpModel, getOmpThinking } from '../../config/schema';
import { saveConfig } from '../../config/store';
import { forgetManagedCard, sendManagedCard, updateManagedCard } from '../../card/managed';
import {
  modelCancelledCard,
  modelProviderCard,
  modelSavedCard,
  modelSelectCard,
} from '../../card/model-card';
import { recentModels } from '../../session/model-history';
import type { CommandContext, Handler } from '../index';
import { FORM_SETTLE_MS, recallMessage, reply } from '../shared';
import { loadModelData } from './data';
import { log } from '../../core/logger';

export const modelHandlers: Record<string, Handler> = {
  '/model': handleModel,
};

async function handleModel(args: string, ctx: CommandContext): Promise<void> {
  const trimmed = args.trim();
  const cfg = ctx.controls.cfg;
  const current = getOmpModel(cfg);

  const [sub, ...rest] = trimmed.split(/\s+/);
  switch (sub) {
    case '':
      return showModelProviders(ctx, current);
    case 'provider':
      return showModelPicker(rest.join(' '), ctx, current);
    case 'use':
      return setModel(rest.join(' '), ctx, current);
    case 'submit':
      return submitModel(ctx, current);
    case 'cancel':
      return cancelModel(ctx);
    case 'reset':
      return resetModel(ctx, current);
    case 'refresh':
      return refreshModels(ctx, current);
    default:
      if (trimmed === '') return showModelProviders(ctx, current);
      if (trimmed.startsWith('-') || /\s/.test(trimmed)) {
        await reply(ctx, '❌ 用法:`/model` 打开选择卡片,或 `/model <id>` 直接设置(如 `futu/deepseek-v4-flash-0731`)。');
        return;
      }
      return setModel(trimmed, ctx, current);
  }
}

async function refreshModels(ctx: CommandContext, current: string | undefined): Promise<void> {
  await reply(ctx, '🔄 正在刷新模型缓存…');
  const data = await loadModelData(ctx.controls.cfg, true);
  const byProvider = new Map<string, number>();
  for (const m of data.list) {
    byProvider.set(m.provider, (byProvider.get(m.provider) ?? 0) + 1);
  }
  const providers = [...byProvider.entries()].map(([provider, count]) => ({ provider, count }));
  const recents = await recentModels();
  if (ctx.fromCardAction) await recallMessage(ctx, ctx.msg.messageId);
  await sendManagedCard(
    ctx.channel,
    ctx.msg.chatId,
    modelProviderCard(current, providers, recents, data.commons),
  );
}

async function showModelProviders(ctx: CommandContext, current: string | undefined): Promise<void> {
  const [data, recents] = await Promise.all([
    loadModelData(ctx.controls.cfg, false),
    recentModels(),
  ]);
  const byProvider = new Map<string, number>();
  for (const m of data.list) {
    byProvider.set(m.provider, (byProvider.get(m.provider) ?? 0) + 1);
  }
  const providers = [...byProvider.entries()].map(([provider, count]) => ({ provider, count }));
  if (ctx.fromCardAction) await recallMessage(ctx, ctx.msg.messageId);
  await sendManagedCard(
    ctx.channel,
    ctx.msg.chatId,
    modelProviderCard(current, providers, recents, data.commons),
  );
}

async function showModelPicker(
  provider: string,
  ctx: CommandContext,
  current: string | undefined,
): Promise<void> {
  const data = await loadModelData(ctx.controls.cfg, false);
  const pick = data.list.filter((m) => m.provider === provider);
  if (pick.length === 0) {
    await reply(ctx, `未找到提供方 \`${provider}\`。请用 \`/model\` 重选。`);
    return;
  }
  if (ctx.fromCardAction) await recallMessage(ctx, ctx.msg.messageId);
  await sendManagedCard(ctx.channel, ctx.msg.chatId, modelSelectCard(provider, current, pick));
}

async function submitModel(ctx: CommandContext, current: string | undefined): Promise<void> {
  const selector = String(ctx.formValue?.model_selector ?? '').trim();
  if (!selector) {
    await reply(ctx, '未选择模型,已取消。');
    return;
  }
  const cfg = ctx.controls.cfg;
  cfg.preferences = { ...(cfg.preferences ?? {}), ompModel: selector };
  await saveConfig(cfg, ctx.controls.configPath);
  log.info('command', 'model-set', { scope: ctx.scope, model: selector, via: 'card' });
  if (ctx.fromCardAction) {
    const formMsgId = ctx.msg.messageId;
    void (async () => {
      await new Promise((r) => setTimeout(r, FORM_SETTLE_MS));
      await updateManagedCard(ctx.channel, formMsgId, modelSavedCard(selector, getOmpThinking(ctx.controls.cfg))).catch(() => {});
      forgetManagedCard(formMsgId);
    })();
  } else {
    await reply(ctx, `✅ 模型已设为 \`${selector}\`。下一条消息生效。`);
  }
}

async function cancelModel(ctx: CommandContext): Promise<void> {
  if (!ctx.fromCardAction) return;
  const formMsgId = ctx.msg.messageId;
  void (async () => {
    await new Promise((r) => setTimeout(r, FORM_SETTLE_MS));
    await updateManagedCard(ctx.channel, formMsgId, modelCancelledCard()).catch(() => {});
    forgetManagedCard(formMsgId);
  })();
}

async function resetModel(ctx: CommandContext, current: string | undefined): Promise<void> {
  const cfg = ctx.controls.cfg;
  if (!current) {
    await reply(ctx, '本来就没设置过模型,一直跟随 OMP 默认。');
    return;
  }
  cfg.preferences = { ...(cfg.preferences ?? {}), ompModel: undefined };
  await saveConfig(cfg, ctx.controls.configPath);
  log.info('command', 'model-reset', { scope: ctx.scope });
  await reply(ctx, '✅ 已清除模型设置,回退 OMP 默认。下一条消息生效。');
}

async function setModel(model: string, ctx: CommandContext, current: string | undefined): Promise<void> {
  if (!model) {
    await reply(ctx, '未指定模型。用 `/model` 打开选择卡片。');
    return;
  }
  const cfg = ctx.controls.cfg;
  cfg.preferences = { ...(cfg.preferences ?? {}), ompModel: model };
  await saveConfig(cfg, ctx.controls.configPath);
  log.info('command', 'model-set', { scope: ctx.scope, model, via: ctx.fromCardAction ? 'card' : 'text' });
  if (ctx.fromCardAction) {
    const formMsgId = ctx.msg.messageId;
    void (async () => {
      await new Promise((r) => setTimeout(r, FORM_SETTLE_MS));
      await updateManagedCard(ctx.channel, formMsgId, modelSavedCard(model, getOmpThinking(ctx.controls.cfg))).catch(() => {});
      forgetManagedCard(formMsgId);
    })();
  } else {
    await reply(
      ctx,
      `✅ 模型已设为 \`${model}\`。\n🧠 思考强度:` +
        (getOmpThinking(ctx.controls.cfg) ? `\`${getOmpThinking(ctx.controls.cfg)}\`` : '_跟随 OMP 默认_') +
        `\n\n下一条消息生效。`,
    );
  }
}
