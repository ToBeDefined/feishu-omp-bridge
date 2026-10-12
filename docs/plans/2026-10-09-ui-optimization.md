# 全量 UI 能力优化 Implementation Plan

> **For Claude:** Use `${SUPERPOWERS_SKILLS_ROOT}/skills/collaboration/executing-plans/SKILL.md` to implement this plan task-by-task.

**Goal:** 把 bridge 剩余所有纯文本/旧式 UI 面（/new、/cd、/context、/diff、/exec、/ps、/every、/compact、/search）统一升级为与 2026-10 会话 UI 同风格的 JSON 2.0 卡片，并补齐 /search 的时间/高亮/翻页能力。

**Architecture:** 所有卡片构建函数保持纯函数（输入数据 → 卡片 JSON object），放在 `src/card/` 下或复用 `src/card/templates.ts` 的共享套件；命令 handler 只负责取数与 `channel.send`。测试全部走结构断言（`JSON.stringify` + 字段匹配），不发真实网络请求；真发验证由人工 `/release` 后抽查。

**Tech Stack:** TypeScript、飞书卡片 JSON 2.0（schema 2.0）、vitest。禁止：`tag:'action'`（2.0 不支持，按钮用 column_set 行，见 2026-10-09 修复）；思考/工具面板 `expanded:false` + ▸ 图标是既定风格。

**通用约定（适用于每个任务）：**

- 共享套件从 `src/card/templates.ts` 导入：`shell`、`md`、`noteMd`、`panel`、`actions`、`button`、`tildePath`、`shortPath`、`escapeMd`、`escapeCode`（Task 1 先导出）。
- 相对时间用 `src/utils/time.ts` 的 `formatAgoOr` / `formatClockOr`；探活文案用 `commands/shared.ts` 的 `formatIdleLine`。
- 用户可控文本一律 `escapeMd`；进 code span 的值用 `escapeCode`。
- 每个任务完成即 commit；全部任务完成后统一 `/release`。

---

### Task 1: 导出共享卡片套件

**Files:**
- Modify: `src/card/templates.ts`（`shell`/`md`/`noteMd`/`panel`/`actions`/`button` 加 `export`）

**Step 1: 写失败测试**

`src/card/templates.test.ts` 追加：

```ts
import { shell, md, panel, actions } from './templates';

describe('shared card kit', () => {
  it('exports the 2.0 kit pieces for other card modules', () => {
    expect(shell('预览', [md('正文')])).toMatchObject({
      schema: '2.0',
      config: { summary: { content: '预览' } },
    });
    expect(md('x', 'notation')).toMatchObject({ text_size: 'notation' });
    expect(panel([md('k')])).toMatchObject({ tag: 'column', background_style: 'grey' });
    expect(actions([{ text: 'go', value: { cmd: 'x' } }]).tag).toBe('column_set');
  });
});
```

**Step 2:** `pnpm vitest run src/card/templates.test.ts` → FAIL（未导出）。
**Step 3:** 给上述 5 个函数加 `export`（`button` 保持私有）。
**Step 4:** `pnpm vitest run src/card/templates.test.ts` → PASS；`pnpm typecheck` → PASS。
**Step 5:** `git commit -m "refactor(card): 导出共享卡片套件供命令卡片复用"`

---

### Task 2: /new 紧凑确认卡

现状：`src/commands/session/new.ts:27` 回复 `ack + renderContext(ctx)` 全量文本，新会话场景大半是「（无）」占位。

**Files:**
- Modify: `src/card/templates.ts`（新增 `newSessionCard`）
- Modify: `src/commands/session/new.ts`（handleNew 改发卡片）
- Test: `src/card/templates.test.ts`

**Step 1: 失败测试**

```ts
import { newSessionCard } from './templates';

describe('newSessionCard', () => {
  it('renders a compact 2.0 confirmation with env panel and no empty fields', () => {
    const card = newSessionCard({
      cwd: '/repo', model: 'p/m', thinking: 'high', idleLine: '全局 30 分钟', wasRunning: true,
    });
    const out = JSON.stringify(card);
    expect(card).toMatchObject({ schema: '2.0' });
    expect(out).toContain('已中断当前任务');
    expect(out).toContain('`/repo`');
    expect(out).toContain('p/m');
    // 不再整段渲染 /context：不应出现「开始对话」「最后对话」占位
    expect(out).not.toContain('开始对话');
    expect(out).not.toContain('最后对话');
  });
});
```

**Step 2:** 运行 → FAIL。
**Step 3:** 实现（templates.ts）：

```ts
export interface NewSessionInfo {
  cwd: string; model?: string; thinking?: string;
  idleLine: string; wasRunning: boolean;
}

export function newSessionCard(info: NewSessionInfo): object {
  return shell('✅ 新会话已开始', [
    md(info.wasRunning ? '✅ **已中断当前任务并开始新会话**' : '✅ **已开始新会话**', 'heading'),
    {
      tag: 'column_set', flex_mode: 'stretch', horizontal_spacing: 'small',
      columns: [
        panel([
          md('**🧩 环境**'),
          md(`📁 \`${escapeCode(tildePath(info.cwd))}\``),
          md(`🎛 ${info.model ? `\`${escapeCode(info.model)}\`` : '_跟随默认_'}`),
          md(`💭 ${info.thinking ? `\`${escapeCode(info.thinking)}\`` : '_跟随默认_'}`),
        ]),
        panel([
          md('**⏱ 探活**'),
          md(escapeMd(info.idleLine)),
          md('_直接发消息即可开始，无需其他操作。_', 'notation'),
        ]),
      ],
    },
  ]);
}
```

new.ts 的 handleNew 末尾改为收集 model/thinking/idleLine（与 `status.ts:14-28` 相同的三行取数）并 `await ctx.channel.send(ctx.msg.chatId, { card: newSessionCard({...}) }, { replyTo: ctx.msg.messageId })`。
**Step 4:** `pnpm vitest run src/card/templates.test.ts src/commands/session.test.ts` → PASS（session.test 若断言了 /new 文本，同步更新为断言卡片 JSON 字段）。
**Step 5:** `git commit -m "feat(card): /new 紧凑确认卡替代全量 context 文本"`

---

### Task 3: /cd 成功确认卡

**Files:**
- Modify: `src/card/templates.ts`（`cwdChangedCard`）
- Modify: `src/commands/session/cd.ts`（成功路径发卡）
- Test: `src/card/templates.test.ts`

**卡片规格：** heading `📁 **已切换工作目录**`；note `_session 已重置，下一条消息在新目录开始_`；panel：`📁 新 cwd`（tildePath+code span）；actions：`[📂 工作空间 ws.list] [📊 状态 status]`。

**测试断言：** schema 2.0、含 `已切换工作目录`、含新路径 code span、含 `"cmd":"ws.list"`、不含「已切换 cwd 到」旧文案（防止新旧双发）。

**Steps:** 失败测试 → 实现 → cd.test.ts 中 `sent` 断言改为卡片 JSON 包含「已切换工作目录」（makeCtx 的 fake channel 若只收 markdown，需让它同时记录 card 的 JSON.stringify，参照 `src/commands/session/cd.test.ts` 现有 makeCtx 结构）→ PASS → `git commit -m "feat(card): /cd 确认卡"`

---

### Task 4: /context 卡片化

**Files:**
- Modify: `src/card/templates.ts`（`contextCard(info, summary)`）
- Modify: `src/commands/session/context.ts`（handleContext 发卡；`renderContext` 保留——`resumeSavedCard` 等仍在复用其文本输出）
- Test: `src/card/templates.test.ts`

**卡片规格：** heading `🧾 **会话上下文**`；三个 panel：`🗂 会话`（标题/短 id/开始/最后活跃）、`🧩 环境`（cwd/agent/模型/思考/探活/快捷目录）、`💬 最近内容`（最后消息/最后回复，各 summarizeMd 80 字）；actions `[📊 状态 status] [🕘 恢复会话 resume]`。

**数据：** handler 处复用 `renderContext` 的取数逻辑——把 renderContext 里逐行拼装的取数部分抽为 `collectContextInfo(ctx): ContextInfo` 导出（context.ts 内），`renderContext` 与 `contextCard` 共用，避免两处取数漂移。

**测试断言：** schema 2.0；三个 panel 标题齐；`最后消息` 摘要截断到 80 字加 `…`；无 summary 时 `💬 最近内容` 面板整体不渲染。

**Steps:** 失败测试（`collectContextInfo` 未导出）→ 抽取 + 实现 → PASS → `git commit -m "feat(card): /context 卡片化（三面板）"`

---

### Task 5: /diff 卡片化

**Files:**
- Modify: `src/card/templates.ts`（`diffCard(stat, diff, truncated)`）
- Modify: `src/commands/session/diff.ts`（成功路径发卡；`renderDiffBody` 保留给纯文本回退）
- Test: `src/card/templates.test.ts` + `src/commands/session/diff.test.ts`

**卡片规格：** heading `📦 **git diff**` + note `_cwd_`；stat 块原样 code fence（通常 <10 行）；正文 diff 折叠进 `▸ 📄 改动内容` collapsible_panel（`expanded:false`，`body` 为现有 renderDiffBody 的 diff 部分）；截断时底部 note `⚠️ diff 已截断`。

**测试断言：** schema 2.0；stat 与 diff 都在；diff 位于 `collapsible_panel` 内（`expanded:false`）；超长 diff（9000 字符）触发截断 note。

**注意：** 现有 `diff.test.ts` 对 `renderDiffBody` 的 3 个用例保留不动（纯文本回退仍在用）。
**Steps:** 失败测试 → 实现 → PASS → `git commit -m "feat(card): /diff 卡片化（stat + 折叠正文）"`

---

### Task 6: /exec 输出卡

**Files:**
- Modify: `src/card/templates.ts`（`execResultCard(cmd, exitCode, output, timedOut)`）
- Modify: `src/commands/lifecycle/exec.ts`（四个 reply 分支改发一张卡）
- Test: `src/card/templates.test.ts` + `src/commands/lifecycle/exec.test.ts`

**卡片规格：** heading：`✅ **命令执行完成**` / `❌ **命令执行失败**`（退出码非 0）/ `⏱ **执行超时**`；note：`` `$ {escapeMd(cmd)}` ``；输出 collapsible（空输出显示 `_（无输出）_`）；无输出且成功时正文只有 note。

**测试断言：** 三种 heading 分支；输出在 collapsible 内；`exit=124` 超时分支 heading 为 ⏱。

**Steps:** 失败测试（exec.test.ts 的 `sent` 断言改为卡片字段）→ 实现 → PASS → `git commit -m "feat(card): /exec 结果卡（退出码 + 折叠输出）"`

---

### Task 7: /ps 卡片化（含行内退出按钮）

**Files:**
- Modify: `src/card/templates.ts`（`psCard(rows: PsRow[], currentId)`，`PsRow = { id, appId, botName?, startedAgo, isCurrent }`）
- Modify: `src/commands/lifecycle/ps.ts`（改发卡；行数据构造就地）
- Test: `src/card/templates.test.ts` + `src/commands/lifecycle/ps.test.ts`（若无则新建最小 ctx 测试）

**卡片规格：** heading `🖥 **Bot 进程** ×N`；每行 column_set：左 weighted（`**#1** ${botName} · _appId_` + note `${ago} 启动${isCurrent ? ' ← 当前正在回复' : ''}`），右 auto「退出」danger 按钮 `value {cmd:'exit', arg:id}`（admin 门由 dispatcher 现有 `denyIfUnauthorized` 处理，无需新代码）。无其他 bot 时显示 `_只有当前进程在跑。_`

**测试断言：** 行数、当前标记、每行 `value.arg === id`、admin 之外不额外放行（dispatcher 测试已有覆盖，不重复）。

**Steps:** 失败测试 → 实现 → PASS → `git commit -m "feat(card): /ps 进程卡（当前标记 + 行内退出）"`

---

### Task 8: /every 定时任务列表卡

**Files:**
- Modify: `src/card/templates.ts`（`everyCard(tasks: EveryRow[])`，`EveryRow = { id, prompt, schedule }`）
- Modify: `src/commands/lifecycle/every.ts`（list 分支发卡）
- Test: `src/card/templates.test.ts`

**卡片规格：** heading `📅 **定时任务** ×N`；每任务 collapsible（标题 `${schedule} — ${summarizeMd(prompt, 40)}`，body：完整 prompt code fence + 「删除」danger 按钮 `value {cmd:'every.rm', arg:id}`）；空列表显示 `_暂无定时任务。发 /every <cron|every> <提示> 添加。_`（以 every.ts 现有用法提示为准，实现时核对）。

**测试断言：** 行数/删除按钮 arg/空态文案。
**Steps:** 失败测试 → 实现 → PASS → `git commit -m "feat(card): /every 任务列表卡（行内删除）"`

---

### Task 9: /compact 进度卡

**Files:**
- Modify: `src/card/templates.ts`（`compactCard(phase, opts)`，phase: 'started'|'done'|'failed'，opts: `{ tokens?, mb?, etaSeconds?, error? }`）
- Modify: `src/commands/lifecycle/compact.ts`（三处 reply 改发卡；`fmtDuration` 逻辑保留）
- Test: `src/card/templates.test.ts`

**卡片规格：** started：heading `🫧 **正在压缩会话上下文**` + note `📏 会话 ≈Nk token / X MB · 预计 ≈T（上限 U）`；done：`✅ 压缩完成，下条消息生效`；failed：`❌ 压缩失败` + error code fence。

**测试断言：** 三 phase 的 heading/字段；estimate 缺失时不出现 token 行。
**Steps:** 失败测试 → 实现 → PASS → `git commit -m "feat(card): /compact 进度卡"`

---

### Task 10: /search 结果卡优化

**Files:**
- Modify: `src/card/search-card.ts`
- Modify: `src/commands/session/search.ts`（分页参数 + timestamp 来源）
- Test: `src/card/search-card.test.ts`

**子项：**

a. **相对时间**：`SearchContext` 增加可选 `timestamp?: number`（search.ts 构造 context 时取会话文件 `stat.mtimeMs`）；结果 meta 行追加 `· N 前`（`formatAgoOr`）。
b. **关键词高亮**：`renderSearchContext(context, mode, keyword?)` — 在 escape 后的文本与片段上，对 `escapeMd(keyword)` 做不区分大小写的 `**$&**` 包裹（两侧同经 escapeMd，元字符一致，可安全匹配）。
c. **空结果**：0 命中时不再走 reply 文本，发一张居中 note 卡 `_未找到包含 "kw" 的消息。换个关键词试试。_`
d. **翻页**：结果 >6 时底部 actions `↓ 更多结果`（`value {cmd:'search.page', arg:offset+6}`）；search.ts 新增 `search.page` 分支按 offset 渲染下一页（复用现有 queryId → contexts 缓存结构，实现时核对该缓存的存活期）。

**Step 1 失败测试（search-card.test.ts）：**

```ts
it('annotates results with relative time and highlights the keyword', () => {
  const ctx = { ...sampleContext(), timestamp: Date.now() - 5 * 60_000 };
  const out = JSON.stringify(searchResultsCard('kw', [ctx], 'q1', false));
  expect(out).toContain('5 分钟前');
  const detail = renderSearchContext(ctx, 'default', 'kw');
  expect(detail).toContain('**kw**'); // 命中处加粗（大小写不敏感）
});
```

**Step 2:** FAIL → **Step 3:** 按子项实现 → **Step 4:** `pnpm vitest run src/card/search-card.test.ts src/commands/session/search.test.ts` → PASS → **Step 5:** `git commit -m "feat(card): /search 相对时间/关键词高亮/空态/翻页"`

---

### Task 11: 全量回归 + 文案巡检 + 发布

**Steps:**

1. `pnpm typecheck && pnpm test` → 全绿。
2. `grep -rn "tag: 'action'" src/` → 0 结果（2.0 禁用项防回归）。
3. `grep -rn '🧰' src/` → 0 结果（emoji 统一巡检）。
4. CHANGELOG `[Unreleased]` 追加本计划所有条目。
5. `git push`；发 `/release`（会自动发上线通知）；抽查 `/status` `/context` `/diff` `/ps` `/every` `/search` 各一张。

---

## 执行方式（二选一）

1. **Subagent-Driven（本会话）**：每个任务派发独立子代理实现，我在任务间做 review，迭代快。
2. **人工顺序执行**：按任务序号直接做，每个任务独立提交。

选定后开始执行 Task 1。

---

## 状态：已执行完成（2026-10-11 结项）

Task 1–11 均已落地：`src/card/templates.ts` 导出共享套件，`/new` `/cd` `/context`
`/diff` `/exec` `/ps` `/every` `/compact` `/search` 的 handler 全部改为卡片输出
（各命令文件均引用 `src/card/`），同步记录在 CHANGELOG `[Unreleased]`。

同日增量（已在 main）：
- `/history`（别名 `/sessions`）对话历史清单卡：每行「继续对话」按钮，
  当前会话行标 `✅ 当前`（紧跟行号）
- 修复 `/history` 每行身份被渲染两遍（残留的顶层 `elements.push`）

**UI 改造到此暂停**（用户决定，后续是否继续另行确认）。发布（`/release`）尚未执行，
运行中的 bridge 仍是改动前的 `dist`。
