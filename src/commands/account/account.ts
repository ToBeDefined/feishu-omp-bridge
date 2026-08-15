import type { AppConfig, TenantBrand } from '../../config/schema';
import { secretKeyForApp } from '../../config/schema';
import { setSecret } from '../../config/keystore';
import { buildEncryptedAccountConfig, saveConfig } from '../../config/store';
import {
  accountCurrentCard,
  accountFailureCard,
  accountFormCard,
  accountSuccessCard,
} from '../../card/account-cards';
import { forgetManagedCard, sendManagedCard, updateManagedCard } from '../../card/managed';
import { validateAppCredentials } from '../../utils/feishu-auth';
import type { CommandContext, Handler } from '../index';
import { FORM_SETTLE_MS, recallMessage, reply } from '../shared';

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
  if (ctx.fromCardAction) {
    await recallMessage(ctx, ctx.msg.messageId);
  }
  await sendManagedCard(ctx.channel, ctx.msg.chatId, card);
}

async function cancelAccount(ctx: CommandContext): Promise<void> {
  if (ctx.fromCardAction) await recallMessage(ctx, ctx.msg.messageId);
}

async function submitAccount(ctx: CommandContext): Promise<void> {
  const fv = ctx.formValue ?? {};
  const appId = String(fv.app_id ?? '').trim();
  const appSecret = String(fv.app_secret ?? '').trim();
  const tenant = (fv.tenant === 'lark' ? 'lark' : 'feishu') as TenantBrand;

  const formMsgId = ctx.msg.messageId;
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
      await updateManagedCard(channel, formMsgId, card).catch((err) =>
        console.warn('[account] form update failed:', err),
      );
      forgetManagedCard(formMsgId);
    };

    const finishFailure = async (errorMessage: string): Promise<void> => {
      await waitForSettle();
      await updateManagedCard(channel, formMsgId, accountFailureCard(errorMessage))
        .catch((err) => console.warn('[account] mark old form failed:', err));
      forgetManagedCard(formMsgId);
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
      await setSecret(secretKeyForApp(appId), appSecret);
      await saveConfig(newCfg, configPath);
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
