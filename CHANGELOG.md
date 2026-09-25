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
- **`/exec` 直接执行命令**（别名 `/run`）：admin 在飞书里直接跑 shell 命令
  （`bash -c`，支持管道/重定向），当前 cwd 执行、30s 超时、输出截断
  1000 字符、禁交互、写审计日志。
### Fixed
- **表格多的回答必触发「卡片渲染中断」**：飞书把 markdown 表格渲染成卡片
  table 组件，单卡上限 5 个，超出即整卡 400（ErrCode 11310
  `card table number over limit`）→ 卡片流中断、run 被杀，用户只拿到
  「⚠️ 卡片渲染中断」的降级文本。表格数量对字节/元素预算完全不可见（6 个
  三行表格约 1 KB JSON），新增表格预算：渲染前按 table 数量切页
  （`splitByTableBudget`，切点落在表头、内容零丢失），超出的表格顺延到
  下一条消息继续以真表格渲染；渲染层再兜一层 `createTableBudget`（同一张
  卡片内第 6 个及以后的表格降级为代码块，文本不丢），保证任何卡片都不会
  超过 5 个 table 组件，降级卡片（`fallbackCard`）同样受此约束。
- **自愈看门狗把"探针慢"当成"进程死"，对健康 daemon 做了破坏性修复**：
  `scripts/self-heal.py` 原来只用 `pgrep -f "feishu-omp-bridge.mjs run"`
  （5s 超时）判进程存活，超时/argv 形态不符都会返回"没进程"；一旦连续 3 次
  误判就 `bridge restart` 杀掉一个已连续运行 52 小时的健康进程，接着
  `git reset` 回退（静默换掉用户刚提交的 commit）、`pnpm build` 120s 超时中断
  留下 dist/src 漂移，再唤起 omp 修复会话 —— 9 分钟内 5 次重启。现在：
  - 进程存活改为三路独立信号取 OR（launchd 给的 pid / `processes.json` 中进程
    自写的 pid + `kill -0` / `pgrep -f`），只有三路全部判死才算死；
  - 探针改三态（True 健康 / False 确认假死 / None 判不出），超时与信号矛盾
    一律算"判不出"：不计连续异常、不触发任何修复动作；
  - 删除 `bridge status` 超时时回退读 `processes.json` 静态 `botName` 的兜底
    （它会把"status 超时"粉饰成"健康"）；
  - 探针超时放宽（pgrep 5s→15s、status 15s→30s）；
  - 达阈值动手前**复检一次**，复检未明确判死即放弃本轮；
  - 回退路径加闸：`pnpm build` 超时/无法执行按"环境问题"处理（超时 120s→300s），
    恢复原 HEAD 并尽力重建 dist，不推进回退游标、不留 dist/src 漂移；只在
    工作区确实脏时才 stash，并在恢复时 pop 回去。
- `/model` 快捷模型按钮会把非 chat 角色当 chat 模型：OMP 18.2.7 新增
  `image`/`web`/`speech`/`dictation`/`judge` 角色，并把历史的
  `providers.webSearch`/`tts`/`stt` 设置自动迁移进 `modelRoles`；bridge 原来把
  `modelRoles` 里所有含 `/` 的取值都当"常用模型"按钮，点一下就会把
  `omp --model` 指到 TTS/搜索/出图模型上，该 chat 之后每轮都失败 → 现在按
  OMP 的角色语义过滤掉这些非 chat 角色（`memory` 等仍保留）。
- `/restart` 静默重启、请求方收不到回音：launchd kickstart 杀掉进程后无法再
  ack，而启动通知只发给 sessions.json 里有 session 的 chat，`/new`、`/cd`、
  `/ws` 又都会清掉 session —— 刚 `/ws` 完再 `/restart` 就完全没有回应，
  看着像没重启成功（实际进程已换新）→ 现在 `/restart` 与 `/release` 一样在
  bounce 前记下请求方 chat，新进程把它加进「已上线」通知目标；标记文件
  `release-notify.json` → `online-notify.json`（旧名读一次，兼容由旧构建
  执行的那次安装 bounce）；非 launchd 的进程内重连与 `restartProcess` 抛错
  时清掉标记，避免之后某次启动冒出一条过期的「已上线」。
- OMP 进程提前退出导致 run 永久挂起、回复石沉大海：OMP 只在自己的 turn
  结束后（或 `--resume` 失败时）立刻退出，而 bridge 要先把媒体/引用处理
  完、把首张卡片发出去才去读它的 stdout；等真正开始读时管道已经 EOF，
  Node 的 `readline` 永远不会再触发 `close`，`for await` 永久挂起 →
  改为 spawn 当刻就开始 drain stdout 并缓冲成行，消费者什么时候来读都
  不会错过 EOF。升级 OMP 后 turn 结束即退出，这个竞态才被踩到。
- 失效 session id 让整个 chat 永久失联：OMP 在首轮就分配 session id，
  但只有首轮成功才落盘 jsonl；首轮失败（模型凭据缺失、被 abort）时
  bridge 存下的 id 之后 `--resume` 一定报 `Session "..." not found`，
  该 chat 之后每条消息都死在同一处 → 现在检测到该失败即清掉失效 id，
  并立刻用新 session 重放本轮，用户无需 `/new` 自救。
- 运行卡片只在结束时更新一次：`renderCard` 在 `terminal === 'running'` 时把卡片标成
  `config.streaming_mode = true`，而该标记会把客户端切到 CardKit 流式模式 —— 内容只认
  `cardkit.cardElement.content` 的打字机推送，整卡 `im.message.patch` 替换在流式模式
  结束前不会被应用。bridge 走的正是整卡 patch，于是整轮只有最后那次（`streaming_mode`
  已变 false）可见。去掉该标记后每次 patch 都会即时上屏（patch 频率本身受
  `im.message.patch` 往返约 0.6s 限制）。
- 自愈看门狗不再把 `omp --version` 的短暂失败当成 bridge 假死；在线状态只由 bridge 进程和 WS 决定，避免无故重启、回退并重复发送上线通知。
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
- **云文档评论永不回复**：`postCommentReply` 的调用被上一次改动删掉，只剩
  一个未使用的 `reply` 变量 —— 评论触发 OMP 跑完、烧完 token，答案直接
  丢弃，用户只看到 Typing 表情消失。已恢复发送，并把同文档串行锁真正
  `add()` 进去（此前只 has/delete，锁是空操作）。
- **OMP spawn 失败 → 该 chat 永久卡死**：Node 在 exec 失败时只发 `error`
  + `close`（永不发 `exit`），`exitCode`/`signalCode` 恒为 null，而
  `waitForExit` 只等 `exit` → `stop()` 永久挂起 → `runAgentBatch` 不返回 →
  该 scope 的 pending 队列再也不 flush。改为以 `close` 为准，并把
  `ENOENT` 等真实原因带进错误消息（原来只说 "spawn returned no pid"）。
- **`bridge stop` 后 `bridge restart` 在 macOS 上必然失败**：`stop` 会
  bootout（plist 仍在磁盘），`restart` 只看 `fileExists()` 就 `kickstart`，
  launchd 报 "Could not find service"。改为未运行时走完整 start 路径。
- **一个 scope 可能被两个 OMP 进程同时 `--resume`**：`ActiveRuns.register`
  是裸 `Map.set`，所有"检查后再 await 再注册"的路径都能撞车 —— 定时任务
  同一 tick 触发两个、进程内 `restart` 前的 flush 与 scheduler 竞争、
  `/doctor` 覆盖活跃 handle（泄漏 UI 定时器，之后还会往 doctor 的子进程
  写一条伪造的 `extension_ui_response`）、stale session 重放覆盖
  `/compact` 的占位。改为 `claim()` 预占 + `register()` 永不覆盖。
- **定时任务 / UI 卡片投递失败 → run 永久挂起**：`pendingUiRequests` 在
  调用 hook 之前就登记，而该集合会暂停 idle 看门狗；定时任务路径不传
  hooks（没有卡片、没有超时定时器），卡片发送失败时也一样 —— 两个出口都
  没有，run 永不结束。定时任务现在有可交互卡片，投递失败会把请求按
  cancelled 回填并释放看门狗。
- **首轮对话前设的 `/timeout`、`/rename` 被静默清掉**：`resumeFor` 因
  `cwd` 不匹配返回 undefined 后，`stale.cwd !== cwd`（`undefined !== '/x'`）
  命中，整个条目被 `clear()` 删除。改为只清真的存在会话的条目，并新增
  `clearSessionId`（保留 title / idle 覆盖）供失效会话回滚使用。
- **配置 `ompSessionDir` 后 `/resume` `/ctx` `/search` `/rename` 全部读错
  目录**（历史命令读硬编码 `paths.ompSessionsDir`，运行写配置目录）；
  同时该字段不展开 `~`，README 的示例值会让 omp 建一个字面量 `~` 目录。
- **`/resume` 可认领别的 chat 的会话**（两个 scope 同时 `--resume` 同一
  JSONL），且原目录不存在时会静默改写该会话记录的工作目录 → 现在拒绝并
  说明原因（跨 scope 占用 / 原目录已删），不再制造假的 (sessionId, cwd)。
- **prompt 信封可被普通群成员伪造**：`<bridge_context>` / `<quoted_message>`
  / `<interactive_card>` 的内容未转义，且引用的消息可以来自白名单外的
  成员 —— 展示名或引用正文里的闭合标签能提前结束 bridge 声明的"这是
  数据"块。三个信封现在都做标签中和 / 属性转义。
- **host tools 信任模型给的 `chatId`/`path`**：`allowedChats` 只在入站校验，
  agent 能往任意会话写、并上传任意本地文件（含 config.json / keystore）；
  `feishu_send_file` 与 `feishu_view_image` 的 path 现在限制在 session cwd
  / 媒体缓存 / 临时目录内（含 symlink 解析），越界给出明确错误。
- **卡片体积预算按字符算，中文长回答必降级**：飞书上限是字节，CJK 约 3
  字节/字符 —— 2 万中文字符 ≈ 59 KB JSON 已贴上限，分页判定却是 false。
  改为按 UTF-8 字节。
- **卡片 markdown 转义缺口**：`escapeMd` 不处理 `[]()`/`!`，工具输出也未
  中和 ``` —— 任意成员的消息内容或模型读到的文件能渲染成活链接 / 追踪
  像素。统一走扩展后的 `escapeMd` + 按内容长度决定的反引号围栏。
- **模型自造卡片可伪造 bridge 内部回调**：按钮 value 被原样 spread，可带
  `__omp_ui` + `scope`；`/model`、`/thinking` 保存失败被 `runHandler` 吞掉
  且不回复；`/doctor` 注册覆盖活跃 run。
- **`/exec` 参数被压平**（连续空白/制表符被合并，命令与输入不一致）、
  输出无上限缓冲（`yes` 跑满 30s 可 OOM）、`/diff` 未纳入 admin 门控。
- 配置 / keystore / model-history / registry 的 read-modify-write 未串行化
  且共用 `${path}.tmp-<pid>` 临时名 → 并发提交丢更新、互相截断。
- `scheduler` 不校验 `intervalMs`（0/负值每 tick 必触发）；systemd 的
  `StandardOutput`/`StandardError` 未转义（按 systemd 源码，该指令不支持
  引号，只需转义 `%` 说明符）；`secret-resolver` 的自定义 exec provider
  拿到空环境（`spawn` 是替换而非合并）、小写 `${var}` 被当字面量当密钥用。
- `estimate.findSessionFile` 用子串匹配 session id（`s1` 命中 `s10`）；
  `registry.resolveTarget` 对非纯数字 id 也做下标兜底（`/exit 3f2` 命中
  第 3 个）；`self-update.py` 回滚时忽略 `git stash pop` 冲突。
- 长驻 daemon 只在启动时清理媒体缓存与旧日志 → 改为每 6 小时复扫。

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
