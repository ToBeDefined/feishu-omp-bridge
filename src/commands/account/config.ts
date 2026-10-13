import type { MessageReplyMode } from '../../config/schema';
import {
  getMaxConcurrentRuns,
  getMessageReplyMode,
  getRequireMentionInGroup,
  getRunIdleTimeoutMs,
  getShowToolCalls,
} from '../../config/schema';
import { saveConfig } from '../../config/store';
import {
  configCancelledCard,
  configFormCard,
  configInvalidCard,
  configSaveFailedCard,
  configSavedCard,
} from '../../card/config-card';
import { forgetManagedCard, sendManagedCard } from '../../card/managed';
import type { CommandContext, Handler } from '../index';
import { FORM_SETTLE_MS, reply, settleManagedCard, updateOrFallback } from '../shared';
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
    ...(access.owner !== undefined ? { owner: access.owner } : {}),
  });
  // 从卡片按钮重开表单时：原地把卡片换回表单，不再撤回旧卡另起一条。
  // keepManaged：这是一张**还会被提交**的表单卡，保留托管登记才能让随后的
  // 提交走 CardKit 原地更新，而不是退化成 patch + 一条 warning。
  if (ctx.fromCardAction) {
    await updateOrFallback(ctx, card, '请重新 `/config`。', { keepManaged: true, resendWhenUnmanaged: true });
  } else {
    await sendManagedCard(ctx.channel, ctx.msg.chatId, card);
  }
}

async function cancelConfig(ctx: CommandContext): Promise<void> {
  if (ctx.fromCardAction) {
    // 老卡片（重启前发出 / 非本进程托管）原地更新会失败 → 助手退回一条「已取消」。
    void settleManagedCard(ctx, configCancelledCard(), '已取消，未做修改。');
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
  // 字段缺失同样回落当前值：此前 `rawTools !== 'hide'` 会把「隐藏」静默改回「显示」
  // （CardKit 偶发丢字段，见上面 messageReply 的同款处理）。
  const showToolCalls =
    rawTools === 'show' || rawTools === 'hide'
      ? rawTools === 'show'
      : getShowToolCalls(ctx.controls.cfg);
  const rawMaxCC = String(fv.max_concurrent_runs ?? '').trim();
  const rawIdle = String(fv.run_idle_timeout_minutes ?? '').trim();
  const currentIdleMs = getRunIdleTimeoutMs(ctx.controls.cfg);
  const currentIdleMinutes = currentIdleMs ? Math.round(currentIdleMs / 60_000) : 0;
  // 数值字段：字段缺失（CardKit 偶发丢字段）与「明确填了非法值」必须分开 ——
  // 前者回落当前值，后者**拒绝提交**。旧行为是静默 clamp / 保留旧值（`999` → 50、
  // `abc` → 旧值、`1e3`/`5.5` 被 parseInt 截断），卡片却回「✅ 偏好已保存」。
  const invalid: string[] = [];
  const parseCount = (raw: string, label: string, min: number, max: number, fallback: number): number => {
    if (raw === '') return fallback;
    // 只认十进制整数：`1e3`、`5.5`、`-1`、`+5`、全角数字全算非法（旧代码用
    // `Number()`/`parseInt` 会把它们悄悄截断成 1000 / 5 / -1 / 5）。
    const n = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
    if (!Number.isInteger(n) || n < min || n > max) {
      invalid.push(`${label}只接受 ${min}-${max} 的整数，收到「${raw}」`);
      return fallback;
    }
    return n;
  };
  const maxConcurrentRuns = parseCount(
    rawMaxCC,
    '「并发上限」',
    1,
    50,
    getMaxConcurrentRuns(ctx.controls.cfg),
  );
  const runIdleTimeoutMinutes = parseCount(
    rawIdle,
    '「run 探活（分钟）」',
    0,
    120,
    currentIdleMinutes,
  );
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

  // 数值非法 / 越界：不写盘、不 clamp，明确回一张错误卡说清是哪一项。
  if (invalid.length > 0) {
    log.warn('command', 'config-rejected', { fields: invalid.length, reason: 'invalid-number' });
    try {
      await ctx.channel.send(
        ctx.msg.chatId,
        { card: configInvalidCard(invalid) },
        { replyTo: ctx.msg.messageId },
      );
    } catch (err) {
      log.fail('command', err, { step: 'config-invalid-card' });
      await reply(ctx, `❌ 提交被拒绝，未做任何修改：\n${invalid.map((e) => `· ${e}`).join('\n')}`);
    }
    return;
  }

  const formMsgId = ctx.msg.messageId;
  const configPath = ctx.controls.configPath;

  void (async () => {
    const submittedAt = Date.now();
    const waitForSettle = async (): Promise<void> => {
      const elapsed = Date.now() - submittedAt;
      if (elapsed < FORM_SETTLE_MS) {
        await new Promise<void>((r) => setTimeout(r, FORM_SETTLE_MS - elapsed));
      }
    };

    // `access.owner` 不在表单里（按设计只能在机器上配置），提交时必须原样保留 ——
    // 否则一次 /config 提交就会把 owner 从配置里抹掉（重启后高危命令对所有人拒绝）。
    const nextPreferences = {
      ...(ctx.controls.cfg.preferences ?? {}),
      messageReply,
      messageReplyMigrated: true,
      showToolCalls,
      maxConcurrentRuns,
      runIdleTimeoutMinutes,
      requireMentionInGroup,
      access: {
        ...(ctx.controls.cfg.preferences?.access ?? {}),
        allowedUsers,
        allowedChats,
        admins,
      },
    };
    const nextCfg = { ...ctx.controls.cfg, preferences: nextPreferences };

    try {
      await saveConfig(nextCfg, configPath);
      // Only mutate the live config after the disk write succeeded — writing
      // first would leave memory/disk split (and a lying "no changes made"
      // card) if saveConfig throws.
      ctx.controls.cfg.preferences = nextPreferences;
    } catch (err) {
      log.fail('command', err, { step: 'config.save' });
      const reason = err instanceof Error ? err.message : String(err);
      await waitForSettle();
      // 明确的失败卡（写清原因）+ 兜底：原地更新不行就 patch 消息，再不行回一条文本。
      // 旧行为是把卡换成「已取消，未做修改」并吞掉异常 —— 用户以为命令被忽略了。
      await updateOrFallback(
        ctx,
        configSaveFailedCard(reason),
        `❌ 偏好保存失败：${reason}（配置未改动，请稍后重试）`,
      );
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
    await updateOrFallback(
      ctx,
      configSavedCard({
        messageReply,
        showToolCalls,
        maxConcurrentRuns,
        runIdleTimeoutMinutes,
        requireMentionInGroup,
        allowedUsers: allowedUsers.join(', '),
        allowedChats: allowedChats.join(', '),
        admins: admins.join(', '),
        // 归属者不在表单里：这里显示的是既有配置，不是本次提交的值。
        ...(ctx.controls.cfg.preferences?.access?.owner !== undefined
          ? { owner: ctx.controls.cfg.preferences.access.owner }
          : {}),
      }),
      '✅ 偏好已保存，立即生效。',
    );
  })();
}
