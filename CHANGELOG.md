# Changelog

本文件记录对用户或运行行为有影响的变更。格式参考
[Keep a Changelog](https://keepachangelog.com/zh-CN/)，语义遵循
[Semantic Versioning](https://semver.org/lang/zh-CN/)。

项目为持续迭代，`package.json` 的 `version` 尚未随变更发布。维护约定：

- **累积模式**：所有新变更一律追加到 `[Unreleased]` 对应分类
  （Added / Changed / Fixed / Removed）。
- **发版时**：把 `[Unreleased]` 整段提升为 `[<version>] - <date>`，
  同时 bump `package.json` 的 `version`，并清空 `[Unreleased]` 各分类。

## [Unreleased]

### Added
- **文件内容提取**：用户发 txt/md/json/代码等文本文件，bridge 直接提取
  内容内联进 prompt（截断 8000 字符），agent 不用再自己读路径；二进制
  与 PDF/docx 保持路径（PDF/docx 由 agent 的 read 工具解析）。
- **`/diff` 命令**：展示当前 session cwd 的 `git diff`（stat 摘要 + 正文，
  截断 4000 字符），review 改动不用开电脑。
- **`feishu_add_reaction` host tool**：Agent 给消息加表情回应（OK/LAUGH/
  LIKE 等），用于确认收到或标记完成。
- **`feishu_list_messages` host tool**：Agent 拉取当前 chat 最近消息（可
  指定 chatId / 条数上限 / 截止时间），用于回顾讨论历史、整理群聊纪要、
  回答"刚才是谁说了什么"。
- **`feishu_send_card` host tool**：Agent 用高层结构（标题 + markdown 正文 +
  按钮列表）发飞书交互卡片，点击经既有 `__codex_cb` 链路回填为
  `[card-click]`，无需 shell 出 `lark-cli im send-card`。按钮上限 10 个、
  正文上限 4000 字符，超出即报清晰错误而非让飞书拒卡。
- **子代理生命周期渲染**：OMP 派发并行子代理时，卡片显示状态行
  （🤖 工作中 / ✅ 完成 / ❌ 失败 / ⏹ 已中止），不再黑盒。
- **`/cd` 相对路径**：`/cd <path>` 现在支持相对当前工作目录的路径
  （如 `src`、`../x`、`./a/b`），不再强制绝对路径或 `~/xxx`；相对路径
  基于当前 chat/topic 的 cwd 解析。
- **`/release` 自发布命令**：飞书 `/release` 与 CLI
  `feishu-omp-bridge release` 一键完成 `pnpm typecheck` → `pnpm test` →
  `pnpm build` → 重启 daemon；任一步失败即中止、不重启，避免「改源码后
  漏 build、重启加载旧 dist」的坑。admin 命令。
- **`/exec` 直接执行命令**：admin 在飞书里直接跑 shell 命令
  （`bash -c`，支持管道/重定向），当前 cwd 执行、30s 超时、输出截断
  1000 字符、禁交互、写审计日志。
### Fixed
- OMP 原生 UI 卡片超时自动取消：OMP 带 `timeout` 的 confirm/select/input
  等待用户输入时，idle watchdog 是暂停的，用户一直不回会永久挂死 run →
  超时后自动回 `cancelled + timedOut` 并更新卡片为"⏱ 已超时"；用户先答
  则取消定时器，不产生第二个响应。
- 自愈回退改为三级策略：① 优先回退到 lastGoodSha（最近验证过健康、
  dist 匹配的提交）；② 失败进入阶梯退避，防对暂时性故障连续过激回退；
  ③ 退避后仍失败，从 lastGoodSha 起一个个 commit 往前回退，步数上限
  10 交给 omp。lastGoodSha 仅在 dist 确由当前 HEAD build 出时才记录，
  避免"HEAD 已前进但 dist 还是旧代码"把坏提交误当 good。
- `/restart` 名不副实：原来只做进程内重连，不重载代码，改完代码
  重启"几次"仍是旧行为 → 改为 launchd kickstart 真重启进程，加载新
  代码；非 launchd 环境自动回退进程内重连。`/reconnect` 保持重连语义。
- Agent 卡片点击后无反馈、可重复点击：回调转发后卡片按钮仍可点 →
  点击即冻结为"✅ 已选择 xxx"（bridge 托管卡更新卡片，按钮加 `name`
  供识别），并按 messageId 去重，双击/重复点不再重复转发。
- 卡片渲染失败导致回复永久停在"工作中"：card 流一旦中断（schema 400 /
  网络 / SDK 限制）只 stop run，用户回复被吞 → 新增降级路径，优先发
  极简卡片（仅 markdown 元素），再失败兜底纯文本，绝不让用户消息石沉大海。
- 交互卡片按钮 400 失败：`feishu_send_card` 与 OMP confirm 卡片用
  `tag: 'action'` 放按钮，schema 2.0 同样不支持（ErrCode 200861
  `unsupported tag action`）→ 改为 `column_set` + `column` 布局。
- 分页卡片 400 失败：run-renderer 用 `tag: 'note'` 渲染分页提示，而
  CardKit 2.0 schema 已不支持 `note` 元素（ErrCode 200861）→ 改用
  `markdown` + `text_size: 'notation'`，与其余注记统一。
- 长正文静默截断：run-renderer 对 text 块截断与分页机制冲突导致内容
  丢失 → 改为按 4000 字符分块 + 卡片分页，内容零丢失。
- `/thinking` 不生效：thinking 在 adapter 构造时固化，per-run 不读配置
  → 与 `/model` 对称地按 run 现读。
- 空思考占位符：`thinking=max` 模型对追问输出单个 `.`，渲染成无内容的
  「思考完成」卡片 → 无字母/数字的 reasoning 不渲染面板。
- card 模式用户提交 `/config` 被静默降级为 markdown：选择器缺 `card`
  选项，而 CardKit 提交时必然回传 `initial_option`。
- 非 admin 执行 `/cd` `/ws` 被拒时误清 pending 排队消息。
- 评论触发 OMP 运行脱离管控：同文档并发双写 session JSONL → 串行锁。
- config / model / thinking 先改内存后落盘，保存失败时状态分叉。
- 自愈脚本路径打包后恒错（`../../../` 解析到仓库父目录）。
- 定时任务不校验失效 cwd，永久 ENOENT 循环。
- 会话扫描全量读文件 → `includes` 预筛后再解析。
- 卡片合成消息硬编码 `chatType: 'p2p'` → 传真实 chat mode。
- stderr 无上限缓存 → 只留尾部 64 KB；`send_file` 无尺寸检查 →
  30 MB 上限；`view_image` 整读改 `stat`。
- `scheduler.load` 不校验 `enabled`/`nextRunAt`；`migrate` 命令只 import
  未注册。

### Removed

- 死代码：`src/bot/scope.ts`、`isManaged`、`ChatModeCache.invalidate`、
  未使用的 `senderId` 参数。

## [0.1.0] — 2026-05 起的历史功能

### 消息与会话

- 私聊、普通群聊 `@bot`、话题群、云文档评论 `@bot`。
- 文本、图片、语音、视频（飞书 ASR 转写）、文件输入；消息 debounce 合并。
- 每个 chat / topic 独立 OMP session，`--resume` 续聊；cwd 变化自动新建。
- 处理中消息可靠排队，`!` 前缀直接 steer 当前 run。

### 会话命令

- `/context` `/ctx` 会话概览；`/resume` `/session` 分页恢复历史会话；
  `/new`；`/rename`（含 `/rename auto` 用 LLM 生成标题）。
- `/search` `/s` 跨会话、跨工作区全文搜索，卡片化结果与详情。

### 模型与思考

- `/model` 交互式选择器（按提供方下钻、最近使用、常用模型、7 天缓存、
  `refresh` 强制刷新）。
- `/thinking` `/think` 切换思考强度，与模型切换联动展示。
- `/config` 表单卡片；`/account` 凭据管理。

### OMP host surface

- `feishu_current_context` / `feishu_send_message` / `feishu_reply_message`
  / `feishu_get_message` / `feishu_send_file` / `feishu_recall_message`
  / `feishu_view_image`。
- 只读 `feishu://current/context`、`feishu://message/<message_id>` URI。

### 运行与控制

- `/stop` 中断、`/restart` 远程重启（launchd `kickstart`）、`/exit`、
  `/ps`、`/reconnect`、`/every` 定时任务、`/doctor` 诊断。
- 强制单进程；launchd 托管 + watchdog 自愈 + 代码坏自动回滚 + 受控自更新。

### 渲染

- 流式文本 / thinking / 工具调用增量面板 / token usage。
- OMP 原生 UI（select / confirm / input / editor / notify / status /
  widget / title / editor_text / open_url）映射为飞书交互卡片并写回。
- 卡片超长自动分页续接；markdown 转义；quoted_message 清洗。
