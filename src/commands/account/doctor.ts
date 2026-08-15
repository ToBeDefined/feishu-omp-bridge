import { homedir } from 'node:os';
import { getAgentStopGraceMs } from '../../config/schema';
import { renderCard } from '../../card/run-renderer';
import {
  finalizeIfRunning,
  initialState,
  markInterrupted,
  reduce,
  type RunState,
} from '../../card/run-state';
import { log, readRecentLogs, sanitizeLogsForDoctor } from '../../core/logger';
import type { CommandContext, Handler } from '../index';
import { reply } from '../shared';

export const doctorHandlers: Record<string, Handler> = {
  '/doctor': handleDoctor,
};

const DOCTOR_INSTRUCTIONS = `你是 feishu-omp-bridge 的诊断助理。下面会给你两段输入:
1. 用户的故障描述
2. 最近的运行日志(JSON line 格式,旧→新)

日志字段含义:
- ts: ISO 时间戳
- level: info | warn | error
- phase: 模块阶段。常见值: ws(WebSocket), intake(消息入站), queue(去抖队列), flush(批处理), media(附件下载), prompt(prompt 组装), session(会话), agent(OMP 子进程), card(卡片渲染), comment(文档评论), cardAction(卡片回调), command(斜杠命令), sdk(飞书 SDK 内部)
- event: enter | exit | transition | fail | 各 phase 自定义事件
- traceId: 同一逻辑操作的串联 ID(同一条消息的多个日志会共享)
- chatId: 飞书聊天 ID(用 chatId 反查相关日志)

回复严格三段,markdown 标题用二级:

## 可能原因
1-3 条最有可能的原因,每条带具体日志的时间戳或 traceId 引用。

## 关键日志片段
3-5 条最重要的日志,直接贴 JSON 行原文,后跟一行说明为什么重要。

## 建议下一步
1-3 条具体可执行的动作(检查 X / 重启 Y / 等待 Z 之类)。

如果日志里没有任何相关线索,直接说"日志不足以判断,建议:"再列动作。回复要直接,不寒暄。`;

function buildDoctorPrompt(description: string, logs: string): string {
  const desc = description.trim() || '(用户没写描述,自行从日志找最显眼的异常。)';
  return `${DOCTOR_INSTRUCTIONS}

---

用户故障描述:
${desc}

最近的运行日志:
\`\`\`
${logs}
\`\`\``;
}

async function handleDoctor(args: string, ctx: CommandContext): Promise<void> {
  log.info('command', 'doctor', {
    hasDescription: args.trim().length > 0,
    chatMode: ctx.chatMode,
  });
  ctx.activeRuns.interrupt(ctx.scope);

  const rawLogs = await readRecentLogs({ maxBytes: 60_000 });
  if (!rawLogs.trim()) {
    await ctx.channel.send(
      ctx.msg.chatId,
      { text: '没有找到日志文件 — bridge 可能刚启动或日志目录不可写。' },
      { replyTo: ctx.msg.messageId },
    );
    return;
  }
  const logs = sanitizeLogsForDoctor(rawLogs);

  const isP2p = ctx.chatMode === 'p2p';
  if (!isP2p) {
    await reply(ctx, '🔍 已收到诊断请求，分析结果将私信发给你。');
  }

  const prompt = buildDoctorPrompt(args, logs);
  const run = ctx.agent.run({
    prompt,
    cwd: homedir(),
    stopGraceMs: getAgentStopGraceMs(ctx.controls.cfg),
  });
  const handle = ctx.activeRuns.register(ctx.scope, run);

  try {
    if (isP2p) {
      await ctx.channel.stream(
        ctx.msg.chatId,
        {
          card: {
            initial: renderCard(initialState),
            producer: async (ctrl) => {
              let state: RunState = initialState;
              const flush = (): Promise<void> => ctrl.update(renderCard(state));
              for await (const evt of handle.run.events) {
                if (handle.interrupted) break;
                if (evt.type === 'system') continue;
                if (evt.type === 'usage') {
                  if (evt.costUsd !== undefined) {
                    log.info('agent', 'usage', { step: 'doctor', costUsd: Number(evt.costUsd.toFixed(4)) });
                  }
                  continue;
                }
                state = reduce(state, evt);
                await flush();
                if (state.terminal !== 'running') break;
              }
              state = handle.interrupted ? markInterrupted(state) : finalizeIfRunning(state);
              await flush();
              await handle.run.stop();
            },
          },
        },
        { replyTo: ctx.msg.messageId },
      );
    } else {
      let state: RunState = initialState;
      for await (const evt of handle.run.events) {
        if (handle.interrupted) break;
        if (evt.type === 'system') continue;
        if (evt.type === 'usage') {
          if (evt.costUsd !== undefined) {
            log.info('agent', 'usage', { step: 'doctor', costUsd: Number(evt.costUsd.toFixed(4)) });
          }
          continue;
        }
        state = reduce(state, evt);
        if (state.terminal !== 'running') break;
      }
      state = handle.interrupted ? markInterrupted(state) : finalizeIfRunning(state);
      await handle.run.stop();
      await ctx.channel.rawClient.im.v1.message.create({
        params: { receive_id_type: 'open_id' },
        data: {
          receive_id: ctx.msg.senderId,
          msg_type: 'interactive',
          content: JSON.stringify(renderCard(state)),
        },
      });
    }
  } catch (err) {
    log.fail('command', err, { step: 'doctor' });
  } finally {
    ctx.activeRuns.unregister(ctx.scope, run);
  }
}
