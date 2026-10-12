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
- **`/release force` / `/restart force`**（也认 `--force` / `-f`）：显式跳过"等在跑的 run 排空"
  那一环，立即重启；正在跑的 run 会被 kickstart 中断，卡片上写明「强制重启」以免被当成异常。
  日志记 `release-force` / `restart-force`（含当时是否真有 run）。参数拼错不会被静默降级：
  只认上述写法，其它 token 回用法提示且什么都不做（否则 `/release frce` 会退化成等满 5 分钟）。
### Added
- **`/history`（别名 `/sessions`）命令**：对话历史清单，按最后活动时间倒序。`/history` 只看当前
  工作目录，`/history all` 看全部工作目录（跨 workspace，每行标注目录）；每行
  显示最后活动时间、对话轮数、标题或最后一条用户消息、session id 句柄，并带
  「继续对话」按钮（与 `/resume <id>` 同一条恢复路径：占用校验 + 原目录存在性
  校验；当前会话所在行不按钮，标记「✅ 当前」跟在行号之后），超 8 条分页。
  admin 命令。
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
- **`rollback.test.ts` 在重负载下假失败**：这组用例真跑 git（每例 10~20 次 spawn），
  vitest 默认 5s 超时在 `/release` 时刻（实测过一次 load average 99，Xcode
  clang/SWBBuildService 在编译）会被击穿 —— git 单条命令从 30ms 涨到 2.4s、冷缓存下建
  一个 3 提交小仓库要 5~16s，导致发布在「测试」步骤中止（并伴随 ENOTEMPTY 清理竞态）。
  现为本文件设 `testTimeout: 60s`，清理改为可重试且不再把清理错误变成第二个失败。
### Fixed
- **适配 OMP 18.10.1（三处 RPC 行为变化，均已对真机验证）**：
  - **`agent_end` 带非终止标记**：OMP 现在会给「调度了后续动作就结束」的
    `agent_end` 打上 `isTerminal:false`（自动重试续跑、压缩续跑、排队的
    steer/follow_up 排空、IRC 唤醒），真正收尾时再发一帧 `isTerminal:true`。
    bridge 原来把**每一帧** `agent_end` 都当运行结束，会在续跑刚排上时杀掉
    进程 —— 续跑的回合既不渲染也写丢。现在只有 `isTerminal !== false` 才算
    终止（旧版 OMP 不带该字段，行为不变）。
  - **OMP 不再在 stdin 打开时自行退出**：18.8 及以前回合结束就自行退出；
    18.10 要等 stdin 关闭。而 bridge 的事件消费方（batch/comments）都在
    `done` 事件上直接 `break`，`for await` 的 break 会把生成器在 `yield`
    处 `return()` 掉 —— 适配器里 yield **之后**的 `endInput`（关 stdin）
    从未执行。结果每条自然结束的消息都走到 reap 的 2s 兜底：warn +
    `SIGTERM` 杀进程组，而非干净的 exit 0。现在适配器在 yield 终止事件
    **之前**先 `endInput`，实测 `done` 后 28ms 干净退出。
  - **`notice` 帧形状对不上（死代码）**：线上形状是
    `{type, level, message, source?}`（wire schema 与 18.10.1 源码确认），
    bridge 却在读 `frame.error`，永不命中 —— session 持久化失败等错误级
    通知被静默丢弃。现在映射为卡片内非终止的 `ui_notice`（ℹ️/⚠️ 图标），
    不结束 run。
- **「标题」只认 `/rename` 起的名字**：`/ctx`、`/status` 与 `/rename` 的无参查询
  从前会拿**最后一条用户消息**当标题显示（还标上 🏷），看起来像是用户给会话起的
  名字；没有名字时还渲染「未命名」占位。现在没有真名就**不渲染标题行**，也不再有
  「未命名」占位；`/rename`（无参）如实回答「当前会话没有标题」。列表类仍然保留
  原来的显示回退（`/history`、`/resume`、`/search` 用最后一条用户消息做身份，且
  **不带 🏷**），两者不再混淆。顺带删掉 `resolveSessionDisplay`：`/ctx`、`/status`
  不再为了显示名字去扫一遍会话目录。

- **卡片「⏹ 终止」一直不消失（三处收尾缺口）**：
  1. **补卡失败就把记录丢了**：崩溃/重启后的兜底补卡（`finalizeInterruptedCards`）无论
     成败都会清空 `running-cards.json` —— 补卡被飞书拒一次（例如卡片超 30KB 上限，
     HTTP 400），那张卡就永远停在运行态。现在：超长/被拒 → 退回一张**极小终态卡**；
     连它也没补上 → **保留记录**，下次启动继续补。
  2. **产流中断时不停摆的卡没人管**：卡片中途更新失败（飞书拒卡/网络）时，旧代码只在
     新消息里发一张兜底卡，原来那张卡留在“运行中”的画面上（带 ⏹）。现在当场把它
     补成终态（按字节切到能放下的部分 + 「更新失败」提示，仍失败则极小卡）。
  3. **一个事件都没来的空流页面从不补终态**：旧条件要求「本页收到过 agent 事件」才补，
     于是子进程秒退 / RPC 没帧这类静默失败会把带 ⏹ 的初始卡留在聊天里，且没有任何
     告警。现在只要这一页的卡还不是终态就补（初始卡已终态的排空页仍不重复推送）。
  另外：产流失败时不再撤掉崩溃恢复记录（原先 `finally` 里无条件撤，等于把这张卡的
  兜底机会也一起删了），成功收尾才撤。

### Added
- **`/history 继续对话` 恢复无归属历史时不再顶着当前会话的身份**：恢复一条
  「没有归属」的历史会话时，旧路径会把它并进 chat 的**当前会话**，于是恢复后的
  `/ctx`、恢复卡片顶着当前那条会话的标题，`/history` 的行与恢复后的身份对不上
  （用户报「history 之后继续对话，标题还是错的」）。现在这条会话直接成为当前
  会话：`/resume <id>` 与「继续对话」走同一条 `applyResume`，标题/开始时间取
  会话文件本身，不借用别人的。
- **标题按 session id 归属**：`/rename` 命名的对象从「chat 条目」改为**那个 OMP
  会话**（`sessions.json.titles[sessionId]`）——`/new`、`/cd`、OMP 漂移、`/resume`
  换走再换回来，名字都还在。`/ctx`、`/status`、`/history`、`/resume`、`/search`
  一律按这条口径显示，不再张冠李戴。
- **会话文件被删后的恢复被拒**：`sessionId` 指向的 OMP JSONL 已不存在时，
  `/resume` / `/history 继续对话` 明确报错，而不是恢复出一个空壳。
- **`/rename` 的标题原先跟着 chat 跑，`/ctx` 与 `/history` 张冠李戴**：标题以前存在
  sessions.json 的 chat 条目上（`SessionEntry.title`），谁被绑定就显示谁 ——
  在 A 会话起的名字，`/resume` / `/history 继续对话` 到 B 会话后会在 B 的
  `/ctx` 与 `/history` 行上显示；`set()` 还会把上一个绑定的 `createdAt` 一起
  带过来，恢复旧会话后「开始对话」显示的是上一次绑定的时间。现在按 session id
  归属（见上）；`/resume` 与「继续对话」写入被恢复会话自己的开始 / 最后活跃
  时间，`/rename` 在没有会话时明确报错；旧文件里的 chat 级（v1）/ 工作会话级
  （v2）标题在加载时迁移到它当时绑定的那个**会话 id**。
- **卡片流式更新触发飞书频率限制（230020）**：卡片更新原先不限速，快速
  流式输出时对同一条消息的 patch 频率超限（"Update the single messages
  too frequently"），整轮回复被「⚠️ 卡片渲染中断」兜底卡取代。现在同卡
  更新强制 ≥1s 间隔（latest-wins 合并，最终状态不丢，仅降低中间刷新率）；
  历史故障（10-05、10-09 ×2）错误签名均为 230020。
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
- **「⚠️ 卡片渲染中断」高频复发的三个根因**（近一周 7 次流中断的完整归因）：
  - **卡片字节预算虚高**：飞书卡片上限实为 **30KB**（ErrCode 200860
    "Card content exceeds limit"；2026-09-29 实测 36,291 字节卡片被
    230099 + ErrCode 200800 拒绝），而 bridge 按"~64KB"分页在 48KB →
    30–48KB 区间的卡片全部被拒、整轮降级。分页预算下调至 26KB（留出
    `{"content":"…"}` 转义膨胀与页脚开销），新增按事故尺寸构造的回归
    测试（18 个工具面板 ≈ 36KB 必须触发分页）。
  - **卡片更新频控失效（ErrCode 230020）**：SDK Throttle 的字符阈值
    （默认 50 字符）对整卡替换永远成立——一次卡片更新就是几千字符，
    `fireSoon(0)` 把配置的 400ms 间隔彻底旁路，文本突发时每次更新都
    立即 patch（实测旧代码连发间隔 0/60/121/182/243ms）。补丁后字符
    阈值触发也尊重 ms 下限（实测冷启动 1 次 + 401ms 节拍）。
  - **瞬时错误一击致命**：`im.message.patch` 遇 230020 频控或 5xx 内部
    错误（2026-09-26/27 各一次）直接杀死整条卡片流。现在对 230020 /
    HTTP 429 / 5xx 以 600ms 线性退避重试至多 3 次；内容/尺寸类 400
    （230099）仍快速失败。三项均在 node-sdk 补丁层实现（沿用既有
    Throttle 补丁的模式，`pnpm patch-commit` 重新生成）。
- **分页闭环的三个缺口**（上述预算下调后由新的端到端测试逐一暴露）：
  - 字节超限分支收页时把**未裁剪的全量 state** 再推一遍——正是刚测超限的
    那张卡，飞书必拒。新增 `splitByByteBudget`：按块取最长可放下的前缀，
    放不下的整体进 carry 翻页；单块超限只可能是文本块（工具卡体有 2.5KB
    上限），按行边界切，病态单行二分硬切。
  - **每页首卡无预算检查**：第 2 页起 initial 直接渲染 carry 状态，超限时
    开页即被拒。分页循环在重置后先过一次 `splitByByteBudget` 再渲染首卡。
  - **done 后的排空页把同一内容发两遍**（initial 一遍、finalize 再一遍，
    表格分页同样存在）：无事件的排空页跳过 finalize；终态事件自己的更新
    卡不再被 finalize 重复推送（`sawEvent` / `sawTerminalPush` 双守卫）。
    端到端测试改为「每条消息取终态卡」模型，40 段落/12 表格断言不丢、
    不重。
- `/restart` 误报 `kickstart-failed`（一周 4 次、stderr 为空）：`launchctl
  kickstart -k` 让 launchd 反杀 daemon 进程组，daemon 自己 spawn 的
  launchctl 子进程一并被杀，`spawnSync` 拿到 `status=null` 被当成失败，
  白跑一次进程内重连后才被挂起的 SIGTERM 收走。现在按三态处理：子进程
  被信号杀死（`signal` 置位）视为「结果不明」，记 `kickstart-ambiguous`
  并挂 3s 兜底重连（带 `stopping` 守卫）；真正的 spawn 失败（`error`）
  与带 stderr 的失败才立即走进程内重连。
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
- **macOS 上 bridge 里执行的内网命令连不上本地网络（`No route to host`）**：
  macOS 15+ 的「本地网络」隐私按**进程身份**放行，且只会给「用户可见的 app」
  弹授权框；由 launchd 直接拉起的 `node` 既弹不出授权框、也不会出现在
  设置 → 隐私与安全性 → 本地网络 列表里，于是整棵进程树（node → omp(bun) →
  bash → 工具进程）访问**同网段**地址一律被内核拒绝：node 报
  `EHOSTUNREACH`，Python/ftplib 报 `[Errno 65] No route to host`，而路由网段
  （如内网 GitLab）和公网不受影响 —— 表现就是「bridge 里跑 `ftc pod install`
  永远连不上 FTP，本地终端却没问题」。现在 macOS 的 launchd plist 改为拉起一个
  编译+签名出来的 supervisor app（`~/.feishu-omp-bridge/macos/FeishuOmpBridge.app`，
  `ai.feishu-omp-bridge.supervisor`，带 `NSLocalNetworkUsageDescription`），
  由它作为父进程运行 `node <bridge> run`：整棵树都归到这个 app 身份，macOS
  首次会弹一次授权框（`start` 时出现的那个窗口即为此，授权成功后自动关闭并
  在 `~/.feishu-omp-bridge/macos/local-network-granted` 留标记），之后 bridge
  及其所有工具子进程都能访问本地网络。签名身份不写死：`FOB_MACOS_SIGN_IDENTITY`
  优先，其次复用固化文件 `~/.feishu-omp-bridge/macos/sign-identity`，最后按
  「Developer ID Application > Apple Development > Mac Developer」从钥匙串里挑一个
  并固化（避免钥匙串顺序变化导致重签、丢授权）；都没有才退回 ad-hoc 并给出提示。
  缺少 `swiftc`（Xcode CLT）或签名身份时自动回退到原来的直启方式，只回落到旧行为、
  不影响其它功能。
- **适配 OMP 18.8.2（RPC 模式两处行为变化）**：
  - **子代理生命周期帧默认停发**（OMP 18.4.11）：RPC 客户端不显式
    `set_subagent_subscription` 就收不到任何 `subagent_lifecycle` / progress
    帧（默认级别 `off`），18.4.4 升级后运行卡片的子代理状态行静默失效。
    现在 ready 后即发送 `set_subagent_subscription level=progress` 恢复；
    旧版 OMP 对未知命令回 `success:false` 响应，仅记 warn、不再当终止错误。
  - **resume 时保存的模型不可恢复从静默回退改为启动即退出**（OMP 18.6.3）：
    RPC 模式无 UI、不允许模型回退，`error: Could not restore model …`
    会让每条消息都死在 ready 之前，chat 被永久卡死。现在与 `Session not
    found` 同样判定为 stale resume：丢弃该 chat 的 session id 并原样重放
    一次（会话文件仍留在磁盘上，可用 `omp --resume` 在 TUI 继续）；
    `/model` 固定了模型的 chat 不受此变化影响。首次尝试的错误卡片对
    stderr 尾部做截断（保留末尾 2000 字符，具体错误行在最后），
    避免 Bun 源码帧噪音把卡片撑爆。

### Changed
- **卡片不再显示 OMP 的工具挂载通告**（`ℹ️ xd://: mounted …`）：每次会话/重启都会打一次且无
  可操作信息，之前会成为卡片首行。仅屏蔽 info 级且以该前缀开头的通告；warning/error 与
  其它 info 通告照常显示（`src/card/run-state.ts` 的 `isSuppressedNotice`）。

- **`kickstart-ambiguous` 日志降级为 info**：实测每次 kickstart 都会走这条（launchd 组杀
  连带把 launchctl 自己带走），属正常路径 —— 新 boot 注册即证明重启发生；保留
  `kickstart-ambiguous-survived` 的 warn（那才是真异常）。
- README（中英）补「排空差异」说明：聊天 `/release`、`/restart` 会等在跑的 run 收尾，
  CLI `release`/`restart` 看不到内存中的 run，会立即重启，有 run 在跑时优先用聊天命令。

### Added
- **`feishu-omp-bridge rollback [sha]`**：发布后运行时才发现坏掉时的救回通道（故意做成
  CLI 命令 —— 此时 bot 可能已无法接收聊天命令）。默认目标取自自愈状态里的 `lastGoodSha`，
  无则 `HEAD~1`；顺序：脏工作区拒绝 → `git revert --no-commit <target>..HEAD` + 一条 revert
  提交（**不改历史**） → 与 `release` 同一套 typecheck/test/build 门禁 → 清熔断 → 重启。
  任一步失败都把仓库恢复到操作前的 HEAD（流水线失败时连刚创建的 revert 提交一起撤销）。
  23 条测试，含真实临时 git 仓库下的 revert/冲突/脏树/流水线失败场景。
- **self-heal 自动回退默认开启**：`install()` 把 `HEAL_ALLOW_ROLLBACK=1` 写进 heal 的
  launchd plist（`HEAL_ALLOW_OMP` 仍默认 0，即不自动起 omp 修复会话）；改回只需
  `HEAL_ALLOW_ROLLBACK=0 python3 scripts/self-heal.py install` + bootout/bootstrap 该 job
  （直接 kickstart 不会刷新 plist 定义 —— 已写入脚本注释）。
- README（中英）补「发布 / 回退（recovery）」流程说明。

### Fixed
- **复查发现的 4 个自身缺陷（本轮 hardening 引入/遗留）**：
  - **`FOB_SUPERVISED` 误标会导致自我击杀（P0）**：plist 无条件写该标记，而
    ProgramArguments 只在 supervisor 可用时才用它 —— 一旦 swiftc/签名不可用回退成
    launchd 直拉 node，父进程本来就是 launchd(1)，守护进程会在启动 5s 后自判孤儿并退出。
    现在只在**真的**走 supervisor 时写这个标记；systemd unit（本就没有 supervisor）
    移除该环境变量。
  - **熔断漏计崩溃型失败**：原来只在 3 条显式 exit-1 路径记账，崩溃/超时/未捕获异常
    不计入 → 熔断永远不触发。现在每轮 boot 在通过闸门后先登记一条尝试记录（以 pid
    锚定、每轮一条），走到 `noteBootSuccess` 才清零；显式失败路径只升级原因，不重复计数。
  - **补卡「超限丢弃」改为「一小时退避」**：原先超过 3 次就丢记录，会让卡片的 ⏹ 永远
    无人收尾；现在记录保留、退避期内不再外呼（崩溃循环里仍是每小时至多一次）。
  - **看门狗开关语义**：两个危险动作都关时，升级阶梯不再消耗 `ompAttempts`/退避状态
    （否则多轮之后会打印「已达上限，停止自愈」，等于把「只关危险动作」变成「永久关自愈」）。

### Fixed
- **机器被拖垮的根因治理（launchd 全生命周期）**——今天的卡死是多主体重启风暴叠加：
  KeepAlive(10s) 无限重拉 + 失败 boot 每轮白付重活 + 发布留下孤儿 worker +
  常驻看门狗会自动 `git 回退+build+起 agent`，全程无熔断、无共享状态、失败不可见。
  - **崩溃熔断**（新 `src/daemon/boot-guard.ts`）：`~/.feishu-omp-bridge/boot-attempts.json`
    记录失败窗；连续 5 次（10 分钟窗）失败即停止自动重启（bootout + exit 0）、尝试向
    首个会话 chat 发告警卡；人工 `feishu-omp-bridge start` 时清计数放行。
  - **失败路径最短化**：配置完整性校验 + 单实例守卫移到 preflight/`ps -A`/目录 GC/omp
    探测**之前**；非 TTY 且配置不完整直接 exit 1 给修复指令（不再进扫码向导挂死）；
    失败路径不再做孤儿 worker 全表扫描。
  - **进程生命周期兜底**：`stop()` 15s 硬看门狗、第二次信号直接 exit(1)、等日志轮转
    落定；`FOB_SUPERVISED=1` 下检测 `ppid===1`（supervisor 已死）自动优雅退出；plist
    加 `ExitTimeOut=8`；桥内 `/restart`、`/release` 重启前先重写 plist（此后
    `FOB_SUPERVISED`/`ExitTimeOut` 才真正生效）。
  - **日志与临时文件**：stderr 一并轮转（`rotateDaemonLogsIfNeeded`）；启动清扫
    `*.tmp-*` 陈旧临时文件，并修掉 `cleanupTmpFiles` 与 `writeAtomic` 随机后缀命名
    不匹配（旧实现永远清不掉）。
  - **通知幂等**：崩溃恢复补卡最多重试 3 次即丢弃（不再每 10s 无限外呼）；普通 boot
    上线卡加入 10 分钟窗口节流（崩溃循环不再刷屏）。
  - **看门狗降级**（`scripts/self-heal.py`）：尊重熔断（命中则本轮不动手）；自动
    `git 回退 + build` 与 `omp` 升级改为默认关闭、需 `HEAL_ALLOW_ROLLBACK=1` /
    `HEAL_ALLOW_OMP=1`；与 self-update 共享锁；循环单轮异常不再中断、顶层异常兜底
    避免自身崩溃循环。
  - **release 超时杀进程组**：步骤超时改为整组 SIGKILL，不再留 vitest worker 孤儿。

### Fixed
- **发布/重启不再静默吞掉在跑的 run**：`/release` 与 `/restart` 的 kickstart 会连带
  杀掉正在执行的 OMP run，而那条消息已经 ack、待处理队列只在内存里 —— 重启后
  彻底丢失（实测一次发布吞掉一个提问并留下「进程中断」残卡）。现在两者在重启前
  先等在跑的 run 排空（上限 5 分钟，超时记日志并继续，兜底补卡仍在）。

### Fixed
- **已完成卡片被误标「进程中断」**：run 跑完、终态卡片已 patch 之后，进程若在
  「删崩溃恢复记录」之前被杀（如 `/release` 的 kickstart），下次启动的兜底会把
  记录里那张**已完工**的快照再贴一条「⚠️ 进程中断，以上为已输出的部分内容」，
  用户会看到完整回复被标成中断。现在 `stripRunningState` 只在快照确实还带运行态
  元素（⏹/正在…）时才贴注解并剥离，终态快照原样收尾。

### Changed
- **测试 worker 池限流**：`/release` 在 bridge 本机跑测试，vitest 默认 worker = 核数-1
  （16 核 → 15 个 worker + 测试内 spawn 的子进程，发布瞬间峰值 17 个 node 进程、
  1.5GB RSS）。`vitest.config.ts` 限为 `maxWorkers: 6`：峰值降到 7 个进程 / 0.7GB，
  全量耗时不变（套件是 I/O 密集型，6.1s vs 6.7s），仍远低于发布步骤 120s 超时。

### Fixed
- **孤儿测试 worker 清扫**：`/release` 的测试步骤后紧接 `kickstart -k` 会 SIGTERM 整个
  守护进程树，vitest 的 worker 池若未走完 teardown 就以孤儿（ppid=1）身份残留——
  实测一轮发布留下 10 个 worker，各占约 4GB 内存并持续吃 CPU。现在 boot 时清扫
  这类孤儿（判据：ppid=1 且命令行为 vitest worker；开发者自己跑的测试父进程存活，
  不会误伤）。

### Fixed
- **重启死锁（生产事故）**：`kickstart` 杀掉 supervisor 后其 node 子进程可能脱管存活
  （ppid=1 孤儿），此后每次 launchd 拉起的新实例都会因「单实例守卫」拒绝启动并 exit 1，
  无限崩溃循环，release 卡永远停在「重启中」。现在 boot 时会把**可顶替**的冲突实例
  （孤儿、已消失条目，或 launchd/systemd 托管环境——plist/unit 注入 `FOB_SUPERVISED=1`）
  SIGTERM 掉再继续；前台开发实例（父进程为活终端）保持守卫本意，仍拒绝。

### Fixed
- **审查第五批（daemon / CLI / bot 胶水，6 切片并行修复）**：
  - **评论管线**：事件按 `event_id`（缺失则 fileToken+comment+reply+time）有界去重，
    重推不再重跑 agent / 重复回复 / 污染 doc 会话；agent 事件流抛错时 `run.stop()`
    进 finally（不再泄漏 omp 子进程）；同文档 in-flight 只提示一次「处理中」。
  - **配置**：`config.json` 非法 JSON 不再 throw（此前在 launchd KeepAlive 下变成
    每 10s 一次的静默崩溃循环），warn 后按「无配置」走清晰报错。
  - **CLI**：`kill <id>` 对 launchd 托管进程改走 adapter.stop（此前 SIGTERM 后被
    KeepAlive 立刻拉起还谎报「已关闭」）；`start` 的清野进程跳过注册表内任何
    pid（不再误杀其他 app 实例）；SIGINT/SIGTERM 处理器提前到第一个 await 之前，
    stop() 对未初始化的 bridge/entry 有守卫；`secrets get` 对非对象 stdin 走
    exit(2)；`/account` saveConfig 失败回滚刚写的 secret。
  - **daemon**：launchd `isRunning` 按 `launchctl print` 的 pid 判活（loaded≠running，
    node 路径失效不再假显「运行中」）；`stopAndDisableAutostart` 真正写禁用版
    plist（裸 bootout 挡不住下次登录自启，注释纠正）；schtasks /TR 裸路径交给
    Node 转义、/End 后固定 1.5s 再 /Run、哨兵退出码 1056/267011 过滤；systemd
    unit 的 ExecStart/Environment 统一 `%`→`%%`；macos-supervisor stamp 读取
    包 try/catch（读失败重建而非炸掉 install）。
  - **bot**：intake 按 messageId 有界去重（WS 重推不再重复入队）；quote 的 post
    分支保留 title/链接，纯链接 post 不再渲染空引用块；`feishu_send_card` 的
    replyTo 过会话白名单（与 reply_message 一致）。
  - **registry**：跨进程文件锁（`<file>.lock` O_EXCL + 陈旧接管），register/
    update/unregister 全走锁，消灭 last-writer-wins 丢条目（同 app 双长连接的根）。
  - **running-cards**：写盘统一 tmp+rename 原子替换、单一串行链（原先两条链
    互相覆盖 + 非原子写让并发读者看到半截文件），boot 补卡与崩溃恢复不再受负载
    影响丢/留错记录。
  - **守护日志**：daemon-stdout.log 启动时超 20MB copytruncate（launchd 追加写
    原本无限增长）。
  - **测试**：新增 ~90 个用例（评论去重/finally、registry 锁、launchd pid 解析、
    systemd % 转义、schtasks 状态解析、secrets 形状守卫、account 回滚、start 信号
    时序、killStray 选择、quote post、intake 去重、managed 链）；修复 4 处负载
    下必现/偶发的测试自身竞态（盲等 sleep → 链排空/唯一 tmp 路径）。三套并行
    全绿（748×3）。

### Fixed
- **审查第四批（卡片管线 / agent 传输，reviewer 掉线后人工补审）**：
  - **子代理名放进 code span 却用 `escapeMd`**：反斜杠转义在 `` `...` `` 里不生效，
    `a_b*reviewer` 会渲染成 `a\_b\*reviewer`（可见反斜杠）。改用 `codeSpan`
    （只把反引号换成撇号），4 处渲染统一。
  - **用户输入裸插 code span**：`/ws use`、`/ctx` 的「命名工作空间」名字若含反引号会提前
    闭合 span（后续文本变成正文），改用 `codeSpan`。
  - **子进程 stdio 没有 `'error'` 监听**：`omp` 子进程在写入前/中死掉时 EPIPE 是**异步**
    `'error'` 事件（`writeFrame` 的 try/catch 只兜同步抛），无监听会直接抛出 —— 落到进程级
    `uncaughtException`（进程不死，但每次都是未捕获异常、状态被视为不可靠）。`agent/omp`
    两个 spawn 点（主 run + oneshot compact）与 `secret-resolver` 的 provider 写入都补上，
    抽成 `wireChildStdio()`。

### Fixed
- **存储层对「坏形状 JSON」的容忍（审查第三批）**：
  - `loadConfig`：文件是合法 JSON 但**不是对象**（`null` / 数组 / 数字 / 字符串）时原样返回
    —— 调用方 `cfg.accounts…` 直接抛，能把启动流程带崩；现在按「没有配置」返回 `{}` 并告警。
  - `WorkspaceStore.load`：`null` 会走 `parsed.chats` 抛 TypeError 且不在容忍范围（非
    SyntaxError）→ 冒泡成启动失败；现在按坏文件重置。
  - `SessionStore`：① 遇到**比当前更新**的 `v`（降级运行 / 手工改过）不再按 v1 解析成空
    再用空 v3 覆盖（会丢用户全部会话），改为不迁移不落盘并告警；② `bind()` 的
    `times?.updatedAtMs ?? Date.now()` 挡不住 `NaN`（`Date.parse` 失败产物）——`NaN` 写盘
    变 `null`，下次 load 因 `updatedAt` 非数字**丢掉整条会话**，现在一律回落成有限数；
    ③ 写盘临时名补随机后缀，与 keystore/registry 一致。
  以上均有测试（含「重新加载后会话仍在」的端到端断言）。

### Fixed
- **`self-heal.py` 回退成功后把用户的本地改动静默留在 stash 里**：只有「环境问题恢复原 HEAD」
  那条路会 `stash pop`，**回退成功**、**推进游标退更早节点**、**重启仍失败** 三条路都不会
  —— 用户的未提交改动从此躺在 stash 里没人知道（`self-update.py` 早修过这一类，回退脚本漏了）。
  现在抽出 `_restore_stash()` 并在所有保留「回退后 HEAD」的路径上调用，pop 冲突时保留 stash
  并明确提示；补 pytest 场景（回退成功必须 pop，反证：去掉该调用即失败）。

### Fixed
- **全仓审查（6 路并行 reviewer + 人工核实）第二批**：
  - **安全（high）：`feishu_send_file` 可外发应用私有文件**。可发送根含 `ctx.cwd`，而
    scope 还没有当前会话/工作区时 cwd 会回退成 `$HOME`（新建私聊第一轮、`/cd ~` 都命中）
    —— 此时 `~/.feishu-omp-bridge/secrets.enc`、`config.json`、`~/.ssh/*` 全在「白名单」内，
    与代码注释声称的拒绝恰恰相反。现在私有应用目录里**只放行媒体缓存**，其余一律拒绝
    （跟随符号链接解析后的真身判断），3 条测试覆盖（含 symlink 绕过）。
  - **安全（medium）：出队途中（已 claim、未 register）的批次拦不住**。`interrupt()` 只找
    handle ⇒ `/new`、`/cd`、`/ws use`、`/stop` 在池子排队/下载媒体/查 chat 模式这段窗口内
    是空操作，旧批次随后照跑并把刚重置的 scope 重新绑成「以旧对话为首轮」的会话。
    现在 `interrupt` 会给未注册的 claim 打取消标记，`register` 拒绝被取消的 claim
    （调用方据此杀掉子进程），带测试。
  - **安全（low）：按 `messageId` 的工具绕过 `access.allowedChats`**。`feishu_get_message`
    / `reply_message` / `recall_message` / `add_reaction` / `feishu://message/<id>` 只用
    模型给的 id，不校验那条消息属于哪个会话 —— 于是能读/写被排除的会话。现在先问出所属
    会话再套白名单（触发消息本身免检），带测试。
  - **安全（low）：裸 `/cd`、`/ws list|save|remove` 也丢排队消息**（它们并不换上下文）。
    `resetsContext` 改为按参数判断：`/cd` 需带路径、`/ws` 只在 `use|undo` 时算重置。
  - **崩溃恢复记录被删（medium）**：`batch.ts` 的 `failed` 标志从未被写入 ⇒ `finally` 里
    `if (!failed) forgetStreamingCard(...)` 等价于无条件删除，卡在运行态（⏹ 不消失）的
    卡片再也没机会被下次启动补终态。现在抛错路径置 `failed = true`，并把用例改成确定化
    （反证：临时去掉那行，该用例失败）。
  - **running-cards 的读改写竞态**：`remember`/`forget` 只串行了「写」而不串行「读—改—写」，
    实测 `remember` 紧跟 `forget`（一次**成功**回合的正常收尾）会让记录残留 —— 下次启动
    给**已完成**的卡片补「进程中断，以上为已输出的部分内容」。现在整段读改写走同一条链，
    并留了回归测试。
- **测试路径隔离（全局）**：`vitest.config.ts` 新增 `setupFiles: test/setup-paths.ts`，把
  `paths.*` 全部指向每个 worker 自己的临时目录 —— 此前有测试没有覆盖
  `paths.runningCardsFile`，**直接写真实 `~/.feishu-omp-bridge/running-cards.json`**
  （把它写空），并让同一路径在并行 worker 间互相干扰（表现为偶发「看到 2 条记录」的 flake）。
  另加断言防止以后退化。

### Fixed
- **全仓审查（6 路并行 reviewer + 人工核实）修掉的一批真实缺陷**：
  - **`/config` 表单「工具调用显示」被静默改回「显示」**：`show_tool_calls` 字段缺失时
    旧代码写 `rawTools !== 'hide'` ⇒ 恒为 true；用户设的「隐藏」会在提交任何其它设置时
    被改回（CardKit 偶发丢字段，`messageReply` 早有同款回落，这一处漏了）。现在空值回落
    到当前值，并带两条测试（缺失→保留、明确 hide→按表单）。
  - **原子写的临时文件名 / 串行化**：`media/cache.ts` 的 `.part-<pid>`、`scheduler` 与
    `model/data.ts`、`config/store` 的 wrapper 都只用 pid 后缀且无串行 —— 同进程并发
    写同一路径会互相覆盖，rename 出去的就是半截文件（媒体缓存被写坏、`tasks.json` 损坏后
    下次启动「corrupt → start empty」**静默丢掉全部定时任务**）。现在临时名一律
    `pid + 6 字节随机`（与仓库既有的 keystore/registry/session 一致），scheduler 另加
    写盘串行链。
  - **日志写流没有 `'error'` 监听**：`EPIPE`/`ENOSPC`/权限变化这类流错误在无监听时会**抛出**，
    而进程级 `uncaughtException` 处理器又往同一条坏流里写（可能反复抛）。现在流上挂
    error 处理：一次性停用文件日志（console 仍在），daemon 继续运行。

### Fixed
- **点「取消」不再毫无反应**：`/config`、`/model`、`/thinking` 的取消都是「原地把卡片改成
  已取消」，而卡片必须在本进程的托管表里才更新得动 —— 重启前发出的老卡片、或在 bridge
  之外发的卡片（手工调试）都不在里面，原地更新抛错后被 `.catch(() => {})` 静默吞掉，
  用户点了取消**什么都不发生**（本次就是这样被发现的）。新增
  `settleManagedCard(ctx, card, fallbackText)` 三级收尾：① 托管卡片照旧走 CardKit 更新；
  ② 不是托管卡片则**把消息内容整体 patch 成新卡片**（手工调试卡片、重启前的老卡片都能
  真的变成「已取消」）；③ 连 patch 都不行才退回一条「已取消，未做修改。」。四个取消点
  （config / model×2 / thinking×2）全部改用，回归测试覆盖三种分支。**同一类缺陷的其余
  残留一并收编**：`/model`、`/thinking` 保存成功后的「已保存」收尾、`/config` 提交后的
  「偏好已保存」收尾、`/account` 的成败收尾（此前用 `console.warn` 静默吞）全部走同一套
  `settleManagedCard` / `updateOrFallback`（后者为不含延迟的核心，供自带 `waitForSettle`
  的表单路径使用），失败即回一句文字，卡片再也不会「点了没反应」。

### Changed
- **`/config` 卡片补上「归属者」只读展示**：`owner` 按设计不在表单里（只能在机器上改
  `config.json`，防远端提权），于是「管理员」一栏空着时，卡片上完全看不出谁在管 ——
  用户反馈「管理员这些看不到」。现在访问控制段多一行 `**归属者**(只读)`，**只显示身份**
  （`**归属者**(只读):\`ou_…\``；未设置时 `_未设置_`）—— 为什么只读、没有时怎么回落
  不在卡片上展开（用户明确要求只留这一行）；保存卡也带上它。
  `owner` 仍是纯展示：不进表单字段，提交时原样保留（见下面那条修复）。

### Fixed
- **`/config` 表单提交不再抹掉 `access.owner`**：`nextPreferences.access` 此前按表单字段
  整体重建（allowedUsers / allowedChats / admins），把不在表单里的 `owner` 一并丢掉 ——
  owner 按设计只能在机器上配置，于是**一次 `/config` 提交就把它抹掉**，重启后
  `/release`、`/exec` 等高危命令对所有人拒绝。现在提交时原样保留既有 `access.owner`，
  并带回归测试（保留 + 空表单回落两种）。
- **`saveConfig` 加了凭据护栏（配置被覆盖的事故复盘）**：冒烟脚本曾拿「只有
  `preferences` 的假 cfg」调 `/model submit`，把**真配置文件覆盖成 97 字节**——
  运行中的进程还在用内存里的配置，所以当场毫无异常，直到下次重启才会连不上飞书。
  现在 `saveConfig` 拒绝任何「丢掉 `accounts.app.id`」的写入（护栏在写链里抛，保持
  Promise 契约，调用方现有的 `.catch` / `try await` 能兜住），并补了回归测试：
  假 cfg 写入被拒且磁盘文件原样保留。

### Changed
- **`/model` 卡片重排：最近使用排最前 + 按钮并排**：
  - 分区顺序改为 **🕘 最近使用 → ⭐ 常用 → 📦 提供方**（此前「常用」在前、最近使用夹在中间）。
  - 快捷选择按钮改走 `inlineActions`（**每行 ≤2 个**）——此前每个按钮各占一整行，最近使用
    + 常用 + 提供方叠起来半屏都是按钮；现在行数减半，提供方也并排两列（当前提供方仍高亮为
    primary）。
  - 按钮标签只留模型段（`futu/kimi-k3` → `kimi-k3`），提供方由分区/标题给出，不再每条重复。
  - **两个快捷区各自最多 4 个**（`QUICK_SET_MAX`，先剔当前模型再截断，保证可见按钮仍是 4 个）：
    模型历史存 20 条、常用角色可能有十几条，全铺出来会把卡片撑成按钮墙。
  - 提供方选择卡（`/model <provider>`）的下拉里 **最近用过的模型排到最前**（按 recency，
    其余仍按字母序），标签同样只留模型段；头部「当前 / 思考」压成一行 notation。
  - `回退默认` 与退路 `取消` 各占一行铺满（按钮规则 1/2）。
### Changed
- **`/resume` 不带参数时转发给 `/history`**：两者的清单卡片本是重复能力（都是「历史会话
  一行一个 + 一键恢复」，只是 `/resume` 那份分页 5 条、带「取消」）。现在
  `/resume`（`/session`）**带参数**才走自己的路径（`/resume <会话 id|前缀>` 直连恢复），
  不带参数就是 `/history`；选择器卡片（`resumeCard` / `resumeCancelledCard`）、它的
  分页/取消/`use` 按钮分支、`showResumePage` 与 `RESUME_PAGE_SIZE` 全部下线（121 行）。
  随之：`resetsContext(cmd, args)` 改为**看参数** —— `/resume` 只有带目标才算换上下文，
  裸 `/resume`（只读清单）不再丢弃排队中的消息（与 `/s`、`/search` 同规则），
  intake 与卡片按钮两条路径共用这一个判断。`/help` 的命令说明也并成一条
  （`/resume <会话 id>` 单列一条，`/history` 那条注明「不带参数的 /resume 也走这里」）。
- **`/status`、`/ctx`、`/context` 合并成同一张卡**：此前两张卡有约 85% 内容逐字相同
  （同样的「🗂 会话 / 🧩 环境」两面板 + 窗口行），差别只在 `/status` 多 agent 名与
  「会话目录已失效」告警、`/ctx` 多「命名工作空间快捷名」与「最近内容」。
  现在一条命令三个写法（`/status` 主名，`/ctx`、`/context` 别名，同一 handler），
  卡片 = 会话面板 + 环境面板（含 agent 名 + 📂 工作空间快捷名）+ 💬 最近内容
  （最后一条用户消息 / 助手回答，各截 80 字）+ 失效告警。
  随之删掉重复实现：`StatusInfo` / `contextCard` / `ContextInfo` 里的重复字段合并成
  一份 `ContextInfo`（新增 `agentName`、`sessionStale`），`context.ts` 只留取数
  （`collectContextInfo` / `renderContext` / `loadSessionSummary` 等），命令层归到
  `status.ts` 一个 handler；`/help` 的两行说明并成一行
  （`/status · /ctx · /context` — 会话状态：会话 / 环境 / 最近内容）。
  代价明说：`/status` 现在也会读一次会话文件（最近内容），且沿用
  `resolveConversationCwd` 的「目录失效就退回 $HOME 并回写」行为；`/ctx` 此前用的是
  只读口径 —— 两者统一到前者（状态卡报的是「下一条消息实际会跑在哪」）。
- **定下卡片按钮布局规则，并全站对齐**（`src/card/templates.ts`）：
  1. **同一层级的并列动作等宽并排一行** —— 确认 / 否、切换 / 删除、继续对话 / 详情、
     上一页 / 下一页：一律 `inlineRow`（`inlineActions` 是其按钮 spec 版）；
     **单个动作也走它**（一列 = 整行宽）。**一行最多 2 个按钮**（`INLINE_ROW_MAX`）：
     手机卡片可用宽度约 300px，三列等宽时每键只剩 ~100px，「📂 工作空间」这种中文
     标签会被压到看不见文字（用户实测 `/help` 页脚三个跳转即如此）—— 超出的自动折到
     下一行，最后一行只有一个按钮时它铺满整行。
  2. **退路动作「取消」单独一行、铺满整宽，放在并列动作下方** —— 它语义不同（放弃当前
     操作），和正向动作挤在一行既容易误点，也把正向动作拽到同一视觉层级；用
     `confirmActions(choices, cancel)` 一步到位。
  3. **危险动作（删除 / 退出）排在同一行的最右**；长标签多分宽度（`weight`），免得
     等宽把它挤到折行。
  落地补一条：**`/help` 页脚四个动作 = 新建会话 · 恢复会话 · 会话状态 · 工作空间**
  （`📊 状态` → `📊 会话状态`，`/cd` 卡片上同一动作的按钮一并改名 —— 同一个动作全站
  只用同一个名字）（等价 `/new`，排在最前、primary；
  4 个动作按每行 2 个折成两行）。走 `{cmd:'new'}` → `runCommandHandler('/new')`，
  与文本 `/new` 同一条路径（重置当前会话 + 中断在跑的 run + 丢弃旧上下文积压消息）。
  历史包袱清掉：原来的 `actions()`（每个按钮各占一整行）按规则 1/2 全部改完后没有
  调用方，已删除；`inlineRow`（元素版，给表单按钮用）与新规则文档一起进 `templates.ts`。
  落地：**OMP 确认卡**（确认 / 否 并排 + 取消单独铺满 —— 就是「🧩 确认执行」那张），
  OMP 表单卡与 `/config`、`/model`、`/thinking`、`/account` 表单（提交铺满一行、取消在
  其下单独一行），`/resume` 页脚（分页并排 + 取消单独铺满）、`/history` 分页、
  `/help` 与 `/cd` 页脚的跳转按钮（并排）。
  投递方式不动：OMP 交互按钮保留 `behaviors`（表单按钮同款），只改排版。
- **灰底块样式推广到其它卡片**（`panel`/`stackedPanels`，与 `/context`、`/status`、`/search` 同一套）：
  - **列表类卡片：一行一个灰底块 + 行尾并排按钮**（此前是「内容列 | 按钮列」的
    `column_set`，按钮贴在内容右侧、每行只有一格按钮）：
    `/history`（继续对话）、`/resume`（恢复 / ✓ 当前）、`/ws list`（切换 / 删除）、
    `/ps`（退出）。
  - **事实类卡片：事实进灰底块**，动作与说明留在块外：`/compact` 的估算
    （token / MB / 预计耗时 / 上限，数字加粗）、`/account` 的当前应用
    （App ID / Bot 名 / Tenant）、OMP 交互卡片里**要用户确认的那句话**。
  - **有意没改的**：单个句子/通知类卡片（`/restart`、上线通知、过期提示、agent 选择确认）
    —— 一行文字套灰框只增加装饰；表单类（`/config`、`/account` 表单、`/model` 选择器、
    `/thinking`）——灰框会和输入控件抢视觉层级；`/diff`、`/exec` 的长文本 —— 已经是
    灰边折叠面板（要的是「折叠」而不是「分组」）。
- **`/search` 结果卡片重做**（`src/card/search-card.ts`）：
  - **命中片段以关键词为中心**：此前取消息**开头** 80/120 字符，关键词在长回答深处时
    snippet 里根本看不到命中（搜索最关键的信息丢失）——现在围绕首处命中截取并两侧
    加 `…`，列表 56/88 字符、详情 600/1000 字符；详情保留原文换行。
  - **关键词高亮修好正则元字符**：`escapeMd` 不管 `. + | ? ^ $ { }`，它们会被当成
    正则语法 —— `/search 1.5` 会把 `125` 也加粗，`/search a|b` 把裸 `a` 加粗。现在
    按字面匹配。
  - **行布局改为「内容 + 按钮」分栏**（`column_set`，同 `/history`）：此前每行是
    「标题行 + meta 行 + 每个命中块的引用块 + 整行按钮行」，6 行卡片长得像一页文档；
    现在一行 = 身份 + meta + 最多 2 处命中（其余提示「另有 N 处匹配，点详情看全部」），
    「继续对话 / 详情」贴在行右侧。
  - **命中当前对话时标记出来**：行号后面直接跟「✅ 当前」（埋在 meta 行里没人看得见，
    与 `/history` 同款），该行**不再给「继续对话」**（恢复当前会话等于原地重启，是无操作），
    只留「详情」；详情卡 meta 行标「✅ 当前对话」并同样去掉「继续对话」，纯文本详情也带标记。
    当前会话 id 由命令层经 `ctx.sessions.sessionFor(scope)` 传入（新增 `currentSessionId`
    / `current` 选项），卡片层不碰 store。
  - **每条结果之间加分割线**：两行都是小灰字 + 灰底块，块与块相邻时分不出是两个结果；
    现在每个「有下一条内容」的行尾（下一条结果 / 分页按钮前）各一条 `hr`。
  - **所有按钮对都横排**：分页与详情卡页脚也改为并排 `inlineActions`（此前是
    `actions()`：每个按钮独占一整行）；`inlineActions` 支持按标签长度分配列宽
    （`weight`，默认 1），「下一页（剩 N）」用 1.6 避免在手机上折行。
  - **「完成」按钮下线，分页修好**：`完成`（结果卡分页 + 详情卡页脚）撤掉，
    于是「点完成 → 去掉按钮的结算态」整条链路（`search.done` 分支、`done`/`showButtons`
    参数、`✅ 搜索完成` 头）一并删除。顺带发现**分页本来根本渲染不出来**：`searchSession`
    结果上限是 6、卡片每页也是 6，所以 `remaining` 恒为 0、`上一页/下一页` 永不可达
    （早先样例里能看到分页，是把 8~14 条直接塞进渲染函数、绕过了命令层）。
    现在结果上限提到 `SEARCH_SESSION_LIMIT = 30`（> 每页 6，并加断言把这条契约钉住），
    分页真正可用；另外给翻页加上「offset 必须落在缓存列表内」的守卫，越界不再渲染出
    「第 7-6 个」这种区间文案。
  - **「继续对话 / 详情」移到每行最底部并排**：按钮不再挂在行右侧（`column_set`
    content|buttons）——那让按钮只贴在首行旁边，且每个按钮独占一格；现在每行是自上而下
    「身份 → meta → 灰底命中块 → 并排按钮」，新增 `inlineActions()`（等宽 `weighted`
    列 + `flex_mode:'none'`，与「每按钮占满一行」的 `actions()` 并列，供列表行复用）；
    分页按钮前补一条 `hr`，避免被读成最后一行的操作。
  - **命中内容改用灰底块，且结果列表与详情卡同款**（`panel`/`stackedPanels`，即
    `/context` 与运行卡片里那些圆角灰块）：**每一处命中各占一个灰底块**，多处时块前
    加「第 k 处」标签，两张卡共用同一条渲染路径（`pairBlocks`），列表只是少渲染几处、
    摘要更短而已，样式不会各自漂移。命中块与身份 / meta 的小灰字分开后，行与行之间
    不再需要 `hr`（块边缘本身即分界），「另有 N 处匹配」提示也移出灰块、作为 meta 行。
  - **只有卡片标题是 heading 字号**：行身份降到普通字号（此前 6 行 36 字符的
    session id / 目录路径挤在超大字号里）。
  - 卡片头改为「找到 N 个对话 · M 处匹配 · 第 a-b 个」；侧栏摘要、空结果卡、翻页
    （上一页 / 下一页（剩 N）/ 完成）与原地更新语义不变。
  - **详情卡结构化**：列出该对话**全部**命中（多处时标「第 k 处」，此前只显示最新一处、
    且不带关键词高亮），带完整 session id / 工作区 / 命中数，`完成` 后只去掉按钮。
- **双语 README 恢复「一一对应」**：`README.md` 回到英文（默认文档），`README.zh.md`
  补全为完整中文镜像 —— 此前 `README.zh.md` 是缺 7 个命令、缺大半章节的旧短版，
  而 `README.md` 被写成了中文，与最初 import 时的约定（`README.md` 英文 +
  `README.zh.md` 中文）相反。现在两份章节一一对应（20 章 / 58 个代码块 / 93 行表格 /
  同一组链接与 30 个命令），并新补一节此前两边都没写的 **CLI 子命令**
  （`run`/`start`/`status`/`restart`/`stop`/`unregister`/`release`/`ps`/`kill`/
  `secrets`/`migrate`）；顶部互加语言切换链接。同时修好 9 处**指向已删文档的悬空引用**：
  `docs/CMUX-AGENT-INTERACTION.md` 已重构为 `cmux-agent` skill（`SKILL.md` + 5 个
  references、章节重编号），README 排查表与文档索引现在指到
  `cmux-agent/references/{cli-basics,pi,kimi,cursor,notifications}.md` 的对应小节
  （原文的 §1/§3/§5/§11.x/§12.x/§13/§14 是旧全局编号，已成死链）；顺带把命令表里
  两处裸 `|`（`/timeout [N|off|default]`、`/exit <id|#>`）转义，修好 GFM 表格错列。
- **`/compact` 两张卡合并成一张**：以前「开始压缩」发一张、结束时（成功/失败）再发
  一张，对话里留两条；现在只有一条卡片消息，跑完在**同一张卡**上原地更新
  （🫧 正在压缩 → ✅ 压缩完成 / ❌ 压缩失败），完成后即从崩溃恢复记录里摘掉；若进程
  在压缩期间退出，下次启动会把这条卡补成「❌ 压缩失败（进程在压缩期间退出）」
  （新增托管卡 `kind: 'compact'`），卡片本身发不出去时退回一条纯文本，结果不会丢。
- **持久化单位回到会话本身（`sessions.json` v3）**：`{ v: 3, scopes, titles }` ——
  每个 scope 只记**当前会话**（`sessionId`/`cwd`/`createdAt`/`updatedAt` + `/timeout`
  覆盖），名字按**会话 id** 存在 `titles` 里（换走再换回来名字自然还在，不用搬）。
  v1（chat 级会话）与 v2（工作会话 + 段）文件在加载时就地迁移，迁移前留
  `sessions.json.v<N>.bak`（已存在不覆盖）；v2 的多段摊子在迁移时收敛为「当前段 =
  当前会话」，其余段本来就以会话文件出现在 `/history` 里。
  随之下线一整套死结构：`WorkSession`/`WorkSegment`/`WorkSessionStore`、
  `pickActiveSegment`、`latestSegment`、`deriveWorkSession`、`display.ts` 的
  展示助手、`snapshot`/`importSnapshot`；`/rename auto` 改按**会话 id** 写名字
  （生成期间 `/new`、`/cd`、`/resume` 换掉当前会话也不落到别的会话上）。


- **会话上下文跟着 OMP 会话走，不再跟着聊天窗口走**：cwd 由**会话**携带
  （`WorkSessionStore.currentSession()`），运行前的目录解析统一走
  `resolveConversationCwd()`——有当前会话且其目录还在，就在**它自己的**目录里续它，
  并把聊天窗口的 cwd 同步过去；没有会话才用窗口的 cwd（新对话落在那里）。
  此前运行期用「窗口 cwd + `resumeFor(scope, cwd)` 比对」，两者一旦不一致就静默
  不 resume、另开一段对话（上下文实际交给了窗口）。展示口径（`/history` 默认视图、
  `/ctx`、`/status`、`/diff`）用只读的 `conversationCwd()`，同样会话优先；
  `/status` 的「换会话」提示改为真实信号「当前会话的目录已不存在」；
  `/compact`、`/exec`、`/diff`、文档评论（评论合成 scope）一并切到同一口径。
- **会话模型回正：一个 OMP 会话 = 一个对话**：每次换 OMP 会话都开**新对话**，
  不再往同一「工作会话」里追加段——于是既不需要 `/work`、也不需要手工合并/拆分，
  `/history` 一行就是一个对话（`sessions.json` v3 只记每个 scope 的当前会话，见上）。
- **`/new`（`/reset`）、`/cd`、`/ws use`（含 `/ws undo`）开新对话**：下一条消息
  新建 OMP 会话，旧对话连同它的名字原样留在 `/history` 里；`/release` 重启与
  `/compact` 仍接在同一段里跑。
- **`/history`、`/ctx`、`/status`、`/resume`、`/rename`、`/search` 一律以「对话」
  为单位**：`/rename` 命名当前对话、名字只挂在它自己身上；`/ctx` / `/status`
  只描述这一个会话（id / 标题 / cwd / 时间），不再有「段数 / 当前段 / 工作会话」。
- 旧文件迁移：v1（chat → OMP 会话 + 标题）自动迁移，备份为
  `sessions.json.v1.bak`；含多段的 v2 文件就地规范化成「一段一对话」（标题归到
  原 `currentSegmentId` 那一段），备份为 `sessions.json.v2.bak`。

- **追加批次**：`/release` 进度卡（三步 ✅/⏳/○ 实时状态 + 失败详情，
  `runRelease` 新增 `onStep` 回调）；删除定时任务后自动刷新任务列表卡；
  `/new` `/cd` 卡片在话题群标注「话题独立会话」。
- 发布成功不再为请求会话额外发送独立「🚀 已上线」消息；启动流程识别 `skip`
  marker 后跳过本次全部上线通知 fan-out，最终状态只保留发布进度卡的
  「🚀 已发布上线」。
- **全量 UI 卡片化（UI 优化计划 11 项）**：共享卡片套件（shell/md/panel/
  actions/collapsiblePanel）从 templates.ts 导出复用；`/new` `/cd` 紧凑
  确认卡；`/context` 卡片化（会话/环境/最近内容三面板，与文本版共用
  `collectContextInfo` 取数）；`/diff` 卡片（stat + 折叠正文 + 截断提示）；
  `/exec` 结果卡（结果标题 + 折叠输出）；`/ps` 进程卡（⭐ 当前标记 +
  行内退出按钮）；`/every` 任务列表卡（行内删除 + 空态）；`/compact`
  进度卡（估算/完成/失败）；`/search` 结果卡（相对时间、关键词命中加粗、
  空结果卡、>6 条分页按钮）。
- **思考过程按时序穿插**：思考不再全部堆在卡片顶部，而是作为时序块与
  正文/工具调用按真实发生顺序交错输出（每段一个「🧠 思考中…/思考过程」
  折叠行，默认收起）。分段规则：text/tool 事件关闭当前思考段，后续思考
  开新段。纯文本模式（messageReply: text）维持不输出思考。
- **工具调用分组折叠**：连续的多个工具调用合并为一个「🛠 工具调用 ×N」
  折叠行（有失败时红边并标注「N 失败」）；展开组后，每个调用保持原样的
  单层面板（标题 + 输入输出合并正文），默认收起。
- **修复：卡片 JSON 2.0 不支持 `action` 容器**（飞书 230099/ErrCode 200861），
  按钮行改用 `column_set` 承载——此前迁移到 2.0 的状态 / 帮助 / 工作空间 /
  恢复会话卡片的按钮会被飞书整卡拒收。已实测样例卡片发送成功。
- **运行卡片页脚重排**：运行中状态（🧠/🧰/✍️）与 ⏹ 终止按钮对齐为一行。
- **思考 / 工具面板默认折叠**：卡片里的思考过程（🧠）和每个工具调用面板
  收起为一行标题，右侧 ▸ 箭头点击展开（展开时箭头旋转 90° 变 ▾）；
  不再自动展开「最新一个工具」。OMP 状态 / Widget 交互面板保持展开。
- **会话 UI 样式优化**：`/status`、`/resume`、`/help`、`/ws list` 四张
  会话卡片迁移到卡片 JSON 2.0，与其余卡片渲染管线一致。
  `/status` 重排为「会话 / 环境」双信息面板（标题、短 session id、创建 /
  最近活跃时间、运行状态、cwd、模型、思考强度、探活），新增 🕘 恢复会话
  一键入口；`/resume` 每个会话一行（标题或摘要 + `时间 · cwd · 短 id`），
  右侧一键「恢复」，相对时间来自 session 时间戳；`/help` 按用途分组速查
  （会话管理 / 偏好设置 / 工作空间 / 运行控制 / 进程与诊断），覆盖原有
  全部命令。相对时间 / 时钟 / 探活文案统一为 `src/utils/time.ts` 与
  `formatIdleLine`，`/context` 同步复用（`/context` 的「刚刚」统一为
  「N 秒前」）。

### Removed

- **工作会话/段这一层**：`/work`（含 `merge` / `split` 子命令）、`/history seg`、
  `/history` 行上的「合并 / 拆分」按钮、`bridge migrate work-sessions` 回填命令，
  以及 `src/session/backfill.ts`、`src/card/history-seg-card.ts`。
  `/new`、`/cd`、`/ws use` 现在只把当前会话指针清成「下一条消息开新对话」，
  旧对话留在 `/history` 里由 `/resume` 找回。命令注册表、卡片按钮映射、`/work`
  相关的注释与测试，以及 README / ARCHITECTURE 里「工作会话 = 段的容器」口径的
  全部残留一并清掉。
- 死代码：`src/bot/scope.ts`、`isManaged`、`ChatModeCache.invalidate`、
  未使用的 `senderId` 参数。
- **未使用的导入 / 局部 / 参数（全仓一次扫净）**：`tsc --noUnusedLocals
  --noUnusedParameters` 从 21 处告警扫到 0 —— `bot/batch.ts`（`homedir`/`stat`/
  `RunCard`/`createTableBudget`）、`bot/comments.ts` 与 `commands/lifecycle/exec.ts`
  的 `homedir`、`bot/feishu-host.ts` 的 `viewImageTool(channel)`、`card/managed.ts`
  的 `unlink`、`card/pagination.ts` 的 `RunCard`、`commands/session/*` 合并后遗留的
  `Handler`/`formatAgo`/`codeSpan`/`HISTORY_PAGE_SIZE`、`cli/commands/start.ts` 的
  `updateManagedCard`、`cli/index.ts` 的 `migrate` 绑定、`runtime/registry.ts` 的
  `readFile`/`EMPTY`、`commands/model/{model,thinking}.ts` 三个只被透传、从未读取的
  `current` 参数（连调用方一起改），以及三处测试里的死导入/死局部。

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
