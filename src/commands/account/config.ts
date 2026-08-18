import type { MessageReplyMode } from '../../config/schema';
import {
  getMaxConcurrentRuns,
  getMessageReplyMode,
  getRequireMentionInGroup,
  getRunIdleTimeoutMs,
  getShowToolCalls,
} from '../../config/schema';
import { saveConfig } from '../../config/store';
import { configCancelledCard, configFormCard, configSavedCard } from '../../card/config-card';
import { forgetManagedCard, sendManagedCard, updateManagedCard } from '../../card/managed';
import type { CommandContext, Handler } from '../index';
import { FORM_SETTLE_MS, recallMessage, reply } from '../shared';
import { log } from '../../core/logger';

export const configHandlers: Record<string, Handler> = {
  '/config': handleConfig,
};

async function handleConfig(args: string, ctx: CommandContext): Promise<void> {
  const sub = args.trim().split(/\s+/)[0] ?? '';
  switch (sub) {
    case '':
      return showConfigForm(ctx);
    case 'submit':
      return submitConfig(ctx);
    case 'cancel':
      return cancelConfig(ctx);
    default:
      await reply(ctx, '用法:`/config`');
  }
}

async function showConfigForm(ctx: CommandContext): Promise<void> {
  const ms = getRunIdleTimeoutMs(ctx.controls.cfg);
  const access = ctx.controls.cfg.preferences?.access ?? {};
  const card = configFormCard({
    messageReply: getMessageReplyMode(ctx.controls.cfg),
    showToolCalls: getShowToolCalls(ctx.controls.cfg),
    maxConcurrentRuns: getMaxConcurrentRuns(ctx.controls.cfg),
    runIdleTimeoutMinutes: ms ? Math.round(ms / 60_000) : 0,
    requireMentionInGroup: getRequireMentionInGroup(ctx.controls.cfg),
    allowedUsers: (access.allowedUsers ?? []).join(', '),
    allowedChats: (access.allowedChats ?? []).join(', '),
    admins: (access.admins ?? []).join(', '),
  });
  if (ctx.fromCardAction) await recallMessage(ctx, ctx.msg.messageId);
  await sendManagedCard(ctx.channel, ctx.msg.chatId, card);
}

async function cancelConfig(ctx: CommandContext): Promise<void> {
  if (ctx.fromCardAction) {
    const formMsgId = ctx.msg.messageId;
    void (async () => {
      await new Promise((r) => setTimeout(r, FORM_SETTLE_MS));
      await updateManagedCard(ctx.channel, formMsgId, configCancelledCard()).catch((err) =>
        log.warn('command', 'config-cancel-update-failed', { err: String(err) }),
      );
      forgetManagedCard(formMsgId);
    })();
  }
}

async function submitConfig(ctx: CommandContext): Promise<void> {
  const fv = ctx.formValue ?? {};
  const rawReply = String(fv.message_reply ?? '').trim();
  // 表单未回传该字段（CardKit form_value 偶发丢弃）时回退到当前值，
  // 而非 'card' —— 否则渲染模式会被静默切换。
  const messageReply: MessageReplyMode =
    rawReply === 'markdown' || rawReply === 'text' || rawReply === 'card'
      ? (rawReply as MessageReplyMode)
      : getMessageReplyMode(ctx.controls.cfg);
  const rawTools = String(fv.show_tool_calls ?? '').trim();
  const showToolCalls = rawTools !== 'hide';
  const rawMaxCC = String(fv.max_concurrent_runs ?? '').trim();
  const parsedMaxCC = Number(rawMaxCC);
  const maxConcurrentRuns =
    Number.isFinite(parsedMaxCC) && parsedMaxCC >= 1
      ? Math.min(50, Math.floor(parsedMaxCC))
      : getMaxConcurrentRuns(ctx.controls.cfg);
  const rawIdle = String(fv.run_idle_timeout_minutes ?? '').trim();
  const currentIdleMs = getRunIdleTimeoutMs(ctx.controls.cfg);
  const currentIdleMinutes = currentIdleMs ? Math.round(currentIdleMs / 60_000) : 0;
  let runIdleTimeoutMinutes: number;
  if (rawIdle === '') {
    runIdleTimeoutMinutes = currentIdleMinutes;
  } else {
    const parsedIdle = Number(rawIdle);
    if (!Number.isFinite(parsedIdle) || parsedIdle < 0) {
      runIdleTimeoutMinutes = currentIdleMinutes;
    } else if (parsedIdle === 0) {
      runIdleTimeoutMinutes = 0;
    } else {
      runIdleTimeoutMinutes = Math.min(120, Math.max(1, Math.floor(parsedIdle)));
    }
  }
  const rawRequireMention = String(fv.require_mention_in_group ?? '').trim();
  let requireMentionInGroup: boolean;
  if (rawRequireMention === 'yes') requireMentionInGroup = true;
  else if (rawRequireMention === 'no') requireMentionInGroup = false;
  else requireMentionInGroup = getRequireMentionInGroup(ctx.controls.cfg);

  const parseList = (raw: unknown): string[] => {
    return [...new Set(
      String(raw ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    )];
  };
  const allowedUsers = parseList(fv.allowed_users);
  const allowedChats = parseList(fv.allowed_chats);
  const admins = parseList(fv.admins);

  // Same-class guard for the user allowlist: a submitter who removes
  // themselves from a non-empty allowedUsers would be silently dropped by
  // intake on the very next message (isUserAllowed) — locked out of the bot
  // entirely, only recoverable by hand-editing the config file on disk.
  if (allowedUsers.length > 0 && !allowedUsers.includes(ctx.msg.senderId)) {
    log.warn('command', 'config-lockout-refused', {
      kind: 'users',
      sender: ctx.msg.senderId.slice(-6),
      proposedUsers: allowedUsers.length,
    });
    await reply(
      ctx,
      `❌ 拒绝提交:你设置了非空的用户白名单,但其中不包含你自己的 open_id (\`${ctx.msg.senderId}\`)。这会让你下一条消息起被 bot 完全拒答。请把自己的 open_id 加进去再提交。`,
    );
    return;
  }

  // Self-lockout guard: if the submitter sets a non-empty admins list that
  // doesn't include themselves, they lose access to /config immediately.
  if (admins.length > 0 && !admins.includes(ctx.msg.senderId)) {
    log.warn('command', 'config-lockout-refused', {
      kind: 'admins',
      sender: ctx.msg.senderId.slice(-6),
      proposedAdmins: admins.length,
    });
    await reply(
      ctx,
      `❌ 拒绝提交:你设置了非空的管理员列表,但其中不包含你自己的 open_id (\`${ctx.msg.senderId}\`)。这会立即把你自己锁出 /config。请把自己的 open_id 加进去再提交。`,
    );
    return;
  }

  // Symmetrical guard for chat allowlist.
  if (
    ctx.chatMode !== 'p2p' &&
    allowedChats.length > 0 &&
    !allowedChats.includes(ctx.msg.chatId)
  ) {
    log.warn('command', 'config-lockout-refused', {
      kind: 'chats',
      currentChat: ctx.msg.chatId.slice(-6),
      proposedChats: allowedChats.length,
    });
    await reply(
      ctx,
      `❌ 拒绝提交:你设置了非空的群白名单,但其中不包含当前会话的 chat_id (\`${ctx.msg.chatId}\`)。提交后这个会话的消息会被 intake 静默丢弃,bot 不再响应。要么把当前 chat_id 加进白名单,要么清空"群白名单"留待空(=所有会话都响应)。`,
    );
    return;
  }

  const formMsgId = ctx.msg.messageId;
  const channel = ctx.channel;
  const configPath = ctx.controls.configPath;

  void (async () => {
    const submittedAt = Date.now();
    const waitForSettle = async (): Promise<void> => {
      const elapsed = Date.now() - submittedAt;
      if (elapsed < FORM_SETTLE_MS) {
        await new Promise<void>((r) => setTimeout(r, FORM_SETTLE_MS - elapsed));
      }
    };

    ctx.controls.cfg.preferences = {
      ...(ctx.controls.cfg.preferences ?? {}),
      messageReply,
      messageReplyMigrated: true,
      showToolCalls,
      maxConcurrentRuns,
      runIdleTimeoutMinutes,
      requireMentionInGroup,
      access: { allowedUsers, allowedChats, admins },
    };

    try {
      await saveConfig(ctx.controls.cfg, configPath);
    } catch (err) {
      log.fail('command', err, { step: 'config.save' });
      await waitForSettle();
      await updateManagedCard(channel, formMsgId, configCancelledCard()).catch(() => {});
      forgetManagedCard(formMsgId);
      return;
    }

    log.info('command', 'config-saved', {
      messageReply,
      showToolCalls,
      maxConcurrentRuns,
      runIdleTimeoutMinutes,
      requireMentionInGroup,
      allowedUsersCount: allowedUsers.length,
      allowedChatsCount: allowedChats.length,
      adminsCount: admins.length,
    });
    await waitForSettle();
    await updateManagedCard(
      channel,
      formMsgId,
      configSavedCard({
        messageReply,
        showToolCalls,
        maxConcurrentRuns,
        runIdleTimeoutMinutes,
        requireMentionInGroup,
        allowedUsers: allowedUsers.join(', '),
        allowedChats: allowedChats.join(', '),
        admins: admins.join(', '),
      }),
    ).catch((err) =>
      log.warn('command', 'config-save-update-failed', { err: String(err) }),
    );
    forgetManagedCard(formMsgId);
  })();
}
