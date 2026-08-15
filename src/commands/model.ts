import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { paths } from '../config/paths';
import {
  getOmpBinary,
  getOmpModel,
  getOmpThinking,
} from '../config/schema';
import type { AppConfig } from '../config/schema';
import { saveConfig } from '../config/store';
import { forgetManagedCard, sendManagedCard, updateManagedCard } from '../card/managed';
import {
  modelCancelledCard,
  modelProviderCard,
  modelSavedCard,
  modelSelectCard,
  thinkingCancelledCard,
  thinkingCard,
  thinkingSavedCard,
} from '../card/model-card';
import { recentModels } from '../bot/model-history';
import type { CommandContext, Handler } from './index';
import { FORM_SETTLE_MS, recallMessage, reply } from './shared';
import { log } from '../core/logger';

export const modelHandlers: Record<string, Handler> = {
  '/model': handleModel,
  '/thinking': handleThinking,
  '/think': handleThinking,
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

/** Force-refresh the model cache, then show the updated provider card. */
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

interface OmpModelEntry {
  provider: string;
  selector: string;
  name?: string;
}

const execFileAsync = promisify(execFile);

/** Read the configured modelRoles (per-role models in ~/.omp config) and
 * return the distinct model selectors, newest-first as authored. The
 * `default` role often carries a `:thinking` suffix, which is stripped. */
async function commonOmpModels(cfg: AppConfig): Promise<string[]> {
  const omp = getOmpBinary(cfg);
  try {
    const { stdout } = await execFileAsync(omp, ['config', 'get', 'modelRoles', '--json'], {
      encoding: 'utf8',
      env: { ...process.env },
    });
    const parsed = JSON.parse(stdout) as { value?: Record<string, string> };
    const seen = new Set<string>();
    const out: string[] = [];
    for (const role of Object.keys(parsed.value ?? {})) {
      const raw = parsed.value?.[role] ?? '';
      const sel = raw.split(':')[0] ?? '';
      if (!sel || !sel.includes('/')) continue;
      if (seen.has(sel)) continue;
      seen.add(sel);
      out.push(sel);
    }
    return out;
  } catch (err) {
    log.warn('command', 'common-models-failed', { err: String(err) });
    return [];
  }
}

async function listOmpModels(cfg: AppConfig): Promise<OmpModelEntry[]> {
  const omp = getOmpBinary(cfg);
  try {
    const { stdout } = await execFileAsync(omp, ['models', '--json'], {
      encoding: 'utf8',
      env: { ...process.env },
      maxBuffer: 4 * 1024 * 1024,
    });
    const parsed = JSON.parse(stdout) as { models?: OmpModelEntry[] };
    return parsed.models ?? [];
  } catch (err) {
    log.warn('command', 'model-list-failed', { err: String(err) });
    return [];
  }
}

/** Cache entry on disk: both the full model list and the configured common
 * models, refreshed together. */
interface ModelsCache {
  fetchedAt: number;
  list: OmpModelEntry[];
  commons: string[];
}

const MODEL_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

async function loadModelsCache(): Promise<ModelsCache | undefined> {
  try {
    const text = await readFile(paths.modelsCacheFile, 'utf8');
    const parsed = JSON.parse(text) as ModelsCache;
    if (typeof parsed.fetchedAt !== 'number' || !Array.isArray(parsed.list)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

async function saveModelsCache(cache: ModelsCache): Promise<void> {
  try {
    await mkdir(dirname(paths.modelsCacheFile), { recursive: true });
    const tmp = `${paths.modelsCacheFile}.tmp-${process.pid}`;
    await writeFile(tmp, `${JSON.stringify(cache)}\n`, 'utf8');
    await rename(tmp, paths.modelsCacheFile);
  } catch (err) {
    log.warn('command', 'models-cache-write-failed', { err: String(err) });
  }
}

/** Load the model list and common models, using the 7-day disk cache unless
 * `force` requests a refresh (which rewrites the cache). */
async function loadModelData(cfg: AppConfig, force: boolean): Promise<ModelsCache> {
  if (!force) {
    const cached = await loadModelsCache();
    if (cached && Date.now() - cached.fetchedAt < MODEL_CACHE_TTL_MS) return cached;
  }
  const [list, commons] = await Promise.all([listOmpModels(cfg), commonOmpModels(cfg)]);
  const fresh: ModelsCache = { fetchedAt: Date.now(), list, commons };
  if (!force) await saveModelsCache(fresh);
  return fresh;
}
