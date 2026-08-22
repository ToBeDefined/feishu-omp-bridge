# feishu_send_card host tool 设计

日期：2026-08-23

## 背景

bridge 现有 7 个 Feishu host tools（`current_context` / `send_message` /
`reply_message` / `get_message` / `send_file` / `recall_message` /
`view_image`），覆盖 IM 消息收发、文件、撤回、看图，但缺「发交互卡片」。

输入侧已经能吃卡片回调：`card/dispatcher.ts` 的 `forwardToAgent` 把带
`__codex_cb` 标记的按钮点击转成 `[card-click] {...}` 消息进 pending 队列，
下轮 OMP 在同一 session 收到。发卡片底层也已经齐：`card/managed.ts` 的
`sendManagedCard(channel, chatId, card, replyTo?)` 用 CardKit 2.0 发卡，
thread 下自动 reply。缺的只是一个 host tool 把这两块积木串起来，让 agent
不必 shell 出 `lark-cli im send-card`。

## 目标

新增 `feishu_send_card` host tool：agent 用高层结构发一张带按钮的卡片，
用户点击后经现有 `__codex_cb` 链路回填为 `[card-click]` 消息。零新增回调代码。

## 方案

采用「高层 builder」方案（备选方案 A 直接透传 CardKit 2.0 JSON，LLM 易拼错，
弃；方案 C 加 `schema` 兜底，多一个分支，YAGNI，弃）。

### tool 签名

- name：`feishu_send_card`
- 入参（`additionalProperties: false`）：
  - `title`: string（必填，卡片 summary）
  - `text`: string（必填，markdown 正文）
  - `buttons`: `Array<{ label: string; value: object }>`（必填，至少 1 个）
  - `replyTo`: string（可选 messageId；缺省用 `ctx.replyToMessageId`）
- 返回：`{ messageId: string }`

### 组装

`card/agent-card.ts` 提供纯函数：

```ts
buildAgentCard(title: string, text: string, buttons: AgentCardButton[]): object
```

产出 CardKit 2.0 schema（结构参照 `card/omp-ui.ts` 的 `shell` / `button`）：

- 每个按钮 `behaviors: [{ type: 'callback', value }]`，`value` 自动注入
  `__codex_cb: true`（保留 agent 提供的其余字段）。
- 按钮 `type` 第一个默认 `primary`，其余 `default`。

### 发送

`feishu-host.ts` 内新 tool 复用：

```ts
sendManagedCard(channel, ctx.chatId, card, replyTo ?? ctx.replyToMessageId)
```

### 回调

无新代码。`forwardToAgent` 已把点击转成 `[card-click]` 消息进当前 scope 的
pending 队列。

## 非目标

- 不透明传原始 CardKit schema（方案 C）。
- 不做卡片更新 / 托管生命周期（agent 卡片发完即弃）。
- 不做 `feishu_list_messages`（读历史消息，后续单独做）。

## 测试

- `card/agent-card.test.ts`：`buildAgentCard` 单测 —— schema 结构、按钮
  value 注入 `__codex_cb`、空 `buttons` 抛错。
- `bot/feishu-host.test.ts` 追加：`feishu_send_card` execute 用 fake channel
  验证发送参数与返回 `messageId`。

## 风险

- `sendManagedCard` 用 module-local map 记录托管卡片；agent 卡片发完即弃但会
  占一条 map 条目，内存可忽略，不引入 forget 逻辑。

## 落点

- 新增 `src/card/agent-card.ts`
- 修改 `src/bot/feishu-host.ts`（注册 tool）
- 新增 `src/card/agent-card.test.ts`
- 修改 `src/bot/feishu-host.test.ts`
