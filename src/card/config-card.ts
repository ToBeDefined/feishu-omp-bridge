import type { MessageReplyMode } from '../config/schema';
import { escapeMd } from '../utils/text';
import { inlineRow, md, panel, stackedPanels } from './templates';

export interface ConfigFormOpts {
  messageReply: MessageReplyMode;
  showToolCalls: boolean;
  maxConcurrentRuns: number;
  /** 0 means "disabled". */
  runIdleTimeoutMinutes: number;
  requireMentionInGroup: boolean;
  /** Comma-separated open_id allowlist; empty string = unrestricted. */
  allowedUsers: string;
  /** Comma-separated chat_id allowlist; empty string = unrestricted. */
  allowedChats: string;
  /** Comma-separated admin open_id list; empty string = no admin gating. */
  admins: string;
  /** 归属者（`access.owner`）。**只读**：不在表单里，只能在机器上改；这里只是显示
   * 现状，免得「管理员」一栏空着让人以为没人管。 */
  owner?: string;
}

/** Form card for `/config`. */
export function configFormCard(opts: ConfigFormOpts): object {
  return {
    schema: '2.0',
    config: { summary: { content: '偏好设置' } },
    body: {
      elements: [
        md('⚙️ **偏好设置**', 'heading'),
        md(
          '_调整 bot 的行为偏好；改完点提交，**立即生效**（无需重启）并写入 `~/.feishu-omp-bridge/config.json`。_',
          'notation',
        ),
        {
          tag: 'form',
          name: 'config_form',
          elements: [
            {
              tag: 'markdown',
              content:
                '**消息回复方式**\n' +
                '_纯文本:agent 跑完一次性发出，不流式，体感最轻_\n' +
                '_消息卡片:轻量流式 markdown 卡片，飞书原生打字机动画_',
            },
            {
              tag: 'select_static',
              name: 'message_reply',
              // CardKit always submits the select's value (defaulting to
              // initial_option), so the option list must include the current
              // mode — otherwise a 'card' user submitting ANY unrelated
              // change silently downgrades to 'markdown'.
              initial_option: opts.messageReply,
              options: [
                { text: { tag: 'plain_text', content: '交互卡片' }, value: 'card' },
                { text: { tag: 'plain_text', content: '纯文本' }, value: 'text' },
                { text: { tag: 'plain_text', content: '消息卡片（默认）' }, value: 'markdown' },
              ],
            },
            {
              tag: 'markdown',
              content:
                '\n**工具调用显示**\n' +
                '_显示:可以看到 bot 跑了什么命令、读了哪些文件等过程_\n' +
                '_隐藏:只看 agent 最终的文字答复，跳过所有工具块_',
            },
            {
              tag: 'select_static',
              name: 'show_tool_calls',
              initial_option: opts.showToolCalls ? 'show' : 'hide',
              options: [
                { text: { tag: 'plain_text', content: '显示（默认）' }, value: 'show' },
                { text: { tag: 'plain_text', content: '隐藏' }, value: 'hide' },
              ],
            },
            {
              tag: 'markdown',
              content:
                '\n**并发上限**\n' +
                '_全局同时运行的 agent 进程数（主要影响话题群多话题并行场景）_\n' +
                '_默认 10，范围 1-50。超出的请求会 FIFO 排队_',
            },
            {
              tag: 'input',
              name: 'max_concurrent_runs',
              default_value: String(opts.maxConcurrentRuns),
              placeholder: { tag: 'plain_text', content: '10' },
              input_type: 'text',
            },
            {
              tag: 'markdown',
              content:
                '\n**run 探活（分钟）**\n' +
                '_agent 长时间没输出时自动 kill，防止假死_\n' +
                '_0 = 关闭（默认），范围 1-120。可被 `/timeout` 在单个 scope 覆盖_',
            },
            {
              tag: 'input',
              name: 'run_idle_timeout_minutes',
              default_value: String(opts.runIdleTimeoutMinutes),
              placeholder: { tag: 'plain_text', content: '0' },
              input_type: 'text',
            },
            {
              tag: 'markdown',
              content:
                '\n**群里需要 @ bot**\n' +
                '_是（默认）:群和话题群里，不 @ bot 的消息不会触发回复，bot 不接群里聊天_\n' +
                '_否:任何消息都会发给 agent（0.1.21 及更早版本的行为）_\n' +
                '_私聊永远不需要 @；`@全员` 永远不响应_',
            },
            {
              tag: 'select_static',
              name: 'require_mention_in_group',
              initial_option: opts.requireMentionInGroup ? 'yes' : 'no',
              options: [
                { text: { tag: 'plain_text', content: '是（默认）' }, value: 'yes' },
                { text: { tag: 'plain_text', content: '否' }, value: 'no' },
              ],
            },
            {
              tag: 'markdown',
              content:
                '🔒 **访问控制**\n\n' +
                '_控制谁能跟 bot 交互、谁能跑敏感命令。留空 = 不限制（默认）_',
            },
            {
              tag: 'markdown',
              // 只显示「归属者是谁」；为什么只读 / 没有时怎么回落不在这张卡上展开。
              content: `\n**归属者**（只读）:${opts.owner ? `\`${opts.owner}\`` : '_未设置_'}`,
            },
            {
              tag: 'markdown',
              content:
                '\n**用户白名单**（`allowedUsers`）\n' +
                '_只允许列表内的 open_id 跟 bot 交互。多个用英文逗号分隔。留空 = 不限制_\n' +
                '_open_id 可从日志 `~/.feishu-omp-bridge/logs/*.log` 里 grep `senderId` 字段_',
            },
            {
              tag: 'input',
              name: 'allowed_users',
              default_value: opts.allowedUsers,
              placeholder: { tag: 'plain_text', content: 'ou_xxx, ou_yyy（留空=不限制）' },
              input_type: 'text',
            },
            {
              tag: 'markdown',
              content:
                '\n**群白名单**（`allowedChats`）\n' +
                '_只限制群（含话题群）——bot 只在名单内的群响应。多个用英文逗号分隔。留空 = 所有群都响应_\n' +
                '_⚠️ 私聊不受此约束，DM 的访问权由“用户白名单”决定_',
            },
            {
              tag: 'input',
              name: 'allowed_chats',
              default_value: opts.allowedChats,
              placeholder: { tag: 'plain_text', content: 'oc_xxx, oc_yyy（留空=所有群）' },
              input_type: 'text',
            },
            {
              tag: 'markdown',
              content:
                '\n**管理员**（`admins`）\n' +
                '_只允许这些 open_id 跑管理命令: `/account` `/config` `/exit` `/reconnect` `/doctor` `/cd` `/ws`。高危命令 `/release` `/exec` `/run` 只认归属者（`owner`，默认取 `admins` 第一个）_\n' +
                '_留空 = 不做管理员限制（所有放行的用户都能跑）。⚠️ 改为非空时务必把自己包含在内，否则会自锁出 /config_',
            },
            {
              tag: 'input',
              name: 'admins',
              default_value: opts.admins,
              placeholder: { tag: 'plain_text', content: 'ou_xxx, ou_yyy（留空=不限制）' },
              input_type: 'text',
            },
            ...inlineRow([{ element: { tag: 'button', name: 'submit_btn', text: { tag: 'plain_text', content: '提交' }, type: 'primary', form_action_type: 'submit', behaviors: [{ type: 'callback', value: { cmd: 'config.submit' } }], } }]),
            ...inlineRow([{ element: { tag: 'button', name: 'cancel_btn', text: { tag: 'plain_text', content: '取消' }, behaviors: [{ type: 'callback', value: { cmd: 'config.cancel' } }], } }]),
          ],
        },
      ],
    },
  };
}

export function configSavedCard(opts: ConfigFormOpts): object {
  const replyLabel =
    opts.messageReply === 'card'
      ? '交互卡片'
      : opts.messageReply === 'markdown'
        ? '消息卡片'
        : '纯文本';
  const summarizeList = (raw: string): string => {
    const items = raw.split(',').map((s) => s.trim()).filter(Boolean);
    return items.length === 0 ? '_(不限制)_' : `${items.length} 项`;
  };
  return {
    schema: '2.0',
    config: { summary: { content: '偏好已保存' } },
    body: {
      elements: [
        md('✅ **偏好已保存**', 'heading'),
        md('_下条消息开始生效。_', 'notation'),
        ...stackedPanels([
          panel([
            md('**⚙️ 偏好**'),
            md(`**消息回复方式**: ${replyLabel}`),
            md(`**工具调用显示**: \`${opts.showToolCalls ? 'show' : 'hide'}\``),
            md(`**并发上限**: \`${opts.maxConcurrentRuns}\``),
            md(
              `**run 探活**: \`${opts.runIdleTimeoutMinutes > 0 ? `${opts.runIdleTimeoutMinutes} 分钟` : '关闭'}\``,
            ),
            md(`**归属者**: ${opts.owner ? `\`${opts.owner}\`` : '_(未设置)_'}`),
            md(`**群里需要 @ bot**: \`${opts.requireMentionInGroup ? '是' : '否'}\``),
          ]),
          panel([
            md('**🔒 访问控制**'),
            md(`**用户白名单**: ${summarizeList(opts.allowedUsers)}`),
            md(`**群白名单**: ${summarizeList(opts.allowedChats)}`),
            md(`**管理员**: ${summarizeList(opts.admins)}`),
          ]),
        ]),
      ],
    },
  };
}

export function configCancelledCard(): object {
  return {
    schema: '2.0',
    config: { summary: { content: '已取消' } },
    body: {
      elements: [{ tag: 'markdown', content: '已取消，未做任何修改。' }],
    },
  };
}

/**
 * 提交被拒绝（数值非法 / 越界等）：逐条说清**哪一项、为什么不合法**，不写盘。
 *
 * 与「已取消」分开：旧行为是静默 clamp（`999` → 50、`abc` → 旧值）或吞掉解析错误，
 * 卡片却回「✅ 偏好已保存」—— 用户以为改了，其实没改（或被改成了别的值）。
 * 这里不原地替换表单卡（那会连用户其它改动一起丢掉），而是另发一张卡。
 */
export function configInvalidCard(errors: string[]): object {
  return {
    schema: '2.0',
    config: { summary: { content: '偏好未保存' } },
    body: {
      elements: [
        { tag: 'markdown', content: '⚠️ **提交被拒绝，未做任何修改**', text_size: 'heading' },
        { tag: 'markdown', content: errors.map((e) => `· ${escapeMd(e)}`).join('\n') },
        {
          tag: 'markdown',
          content: '_原来的卡片还能继续改：修正上面的输入再点「提交」即可。_',
          text_size: 'notation',
        },
      ],
    },
  };
}

/**
 * 写盘失败：说清失败原因，不假装「已取消」（旧行为把卡换成
 * `configCancelledCard` 并吞掉异常，用户以为命令被忽略了）。
 */
export function configSaveFailedCard(reason: string): object {
  return {
    schema: '2.0',
    config: { summary: { content: '偏好保存失败' } },
    body: {
      elements: [
        { tag: 'markdown', content: '❌ **偏好保存失败，未生效**', text_size: 'heading' },
        { tag: 'markdown', content: `原因: ${escapeMd(reason)}` },
        {
          tag: 'markdown',
          content: '_配置未改动，请稍后重试（日志在 `~/.feishu-omp-bridge/logs/`）。_',
          text_size: 'notation',
        },
      ],
    },
  };
}
