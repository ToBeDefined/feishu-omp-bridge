import type { AppConfig, TenantBrand } from '../../config/schema';
import { secretKeyForApp } from '../../config/schema';
import { removeSecret, setSecret } from '../../config/keystore';
import { buildEncryptedAccountConfig, saveConfig } from '../../config/store';
import {
  accountCurrentCard,
  accountFailureCard,
  accountFormCard,
  accountSuccessCard,
} from '../../card/account-cards';
import { sendManagedCard } from '../../card/managed';
import { validateAppCredentials } from '../../utils/feishu-auth';
import type { CommandContext, Handler } from '../index';
import { FORM_SETTLE_MS, recallMessage, reply, updateOrFallback } from '../shared';

export const accountCmdHandlers: Record<string, Handler> = {
  '/account': handleAccount,
};

async function handleAccount(args: string, ctx: CommandContext): Promise<void> {
  const sub = args.trim().split(/\s+/)[0] ?? '';
  switch (sub) {
    case '':
      return showCurrent(ctx);
    case 'change':
      return showForm(ctx);
    case 'submit':
      return submitAccount(ctx);
    case 'cancel':
      return cancelAccount(ctx);
    default:
      await reply(ctx, '用法：`/account` 或 `/account change`');
  }
}

async function showCurrent(ctx: CommandContext): Promise<void> {
  const card = accountCurrentCard({
    appId: ctx.controls.cfg.accounts.app.id,
    botName: ctx.channel.botIdentity?.name,
    tenant: ctx.controls.cfg.accounts.app.tenant,
  });
  await ctx.channel.send(ctx.msg.chatId, { card }, { replyTo: ctx.msg.messageId });
}

async function showForm(ctx: CommandContext): Promise<void> {
  const card = accountFormCard({ initialTenant: ctx.controls.cfg.accounts.app.tenant });
  // 「更换凭据」来自卡片：原地把卡片换成表单，不再撤回旧卡另起一条。
  if (ctx.fromCardAction) {
    await updateOrFallback(ctx, card, '请重新 `/account change`。');
  } else {
    await sendManagedCard(ctx.channel, ctx.msg.chatId, card);
  }
}

async function cancelAccount(ctx: CommandContext): Promise<void> {
  if (ctx.fromCardAction) await recallMessage(ctx, ctx.msg.messageId);
}

async function submitAccount(ctx: CommandContext): Promise<void> {
  const fv = ctx.formValue ?? {};
  const appId = String(fv.app_id ?? '').trim();
  const appSecret = String(fv.app_secret ?? '').trim();
  const tenant = (fv.tenant === 'lark' ? 'lark' : 'feishu') as TenantBrand;

  const channel = ctx.channel;
  const configPath = ctx.controls.configPath;
  const restart = ctx.controls.restart;

  // CRITICAL: detach the work from the cardAction handler. Lark's client
  // keeps the form locked while the handler is pending — if we await the
  // settle window inline, the lock holds and the update gets reverted.
  const chatId = ctx.msg.chatId;
  void (async () => {
    const submittedAt = Date.now();
    const waitForSettle = async (): Promise<void> => {
      const elapsed = Date.now() - submittedAt;
      if (elapsed < FORM_SETTLE_MS) {
        await new Promise<void>((r) => setTimeout(r, FORM_SETTLE_MS - elapsed));
      }
    };

    const finishSuccess = async (card: object): Promise<void> => {
      await waitForSettle();
      await updateOrFallback(ctx, card, '✅ 已更换应用凭据，正在重连…');
    };

    const finishFailure = async (errorMessage: string): Promise<void> => {
      await waitForSettle();
      await updateOrFallback(
        ctx,
        accountFailureCard(errorMessage),
        `❌ 更换凭据失败：${errorMessage}`,
      );
      const retry = accountFormCard({
        initialTenant: tenant,
        prefillAppId: appId,
      });
      await sendManagedCard(channel, chatId, retry).catch((err) =>
        console.warn('[account] post retry form failed:', err),
      );
    };

    if (!appId || !appSecret) {
      await finishFailure('App ID 或 App Secret 为空');
      return;
    }

    const result = await validateAppCredentials(appId, appSecret, tenant);
    if (!result.ok) {
      await finishFailure(result.reason ?? 'unknown');
      return;
    }

    let newCfg: AppConfig;
    try {
      newCfg = await buildEncryptedAccountConfig(
        appId,
        tenant,
        ctx.controls.cfg.preferences,
      );
      const secretKey = secretKeyForApp(appId);
      await setSecret(secretKey, appSecret);
      try {
        await saveConfig(newCfg, configPath);
      } catch (err) {
        // saveConfig 失败时，刚写入 keystore 的 secret 成了孤儿（config.json
        // 仍指向旧凭据，这条密钥查无出处）。best-effort 删除后再抛，失败
        // 本身不掩盖原始错误。
        await removeSecret(secretKey).catch(() => {});
        throw err;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await finishFailure(`保存凭据失败：${msg}`);
      return;
    }

    await finishSuccess(accountSuccessCard({ appId, botName: result.botName, tenant }));

    setTimeout(() => {
      void restart().catch((err) => {
        console.error('[account] restart failed:', err);
        process.exit(1);
      });
    }, 1500);
  })();
}
