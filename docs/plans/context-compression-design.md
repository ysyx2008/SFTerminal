# 上下文压缩完善设计方案

> 起因：批量解析数十个 PDF 的任务中，AI 已主动压缩仍报超限失败，用户重试却成功——
> 自动压缩层只会「砍轮次 + 死模板占位」，砍不动最近几轮里的大块工具原文，也留不住任务进度。
> 设计取舍已落 `electron/services/agent/SPEC.md`「上下文压缩完善（2026-08-06 设计）」，本文是实现方案。

## 1. 核心设计决策（待用户确认）

| 决策点 | 方案 | 理由 |
|---|---|---|
| 真摘要触发点 | 复用现有 proactive 触发（上一轮真实 `prompt_tokens` 超阈值），触发后**先发起一次 AI 摘要小请求**，产出摘要交给压缩；摘要调用失败才回退现有固定模板 | 窗口将满、API 还可用时摘要质量最高；失败有确定性兜底 |
| 触发阈值 | `PROACTIVE_THRESHOLD` 0.95 → **0.90** | 摘要调用本身要占一次请求的余量，95% 太贴边 |
| 摘要请求装配 | 只带待归档消息中的：用户消息、assistant 文本、工具名 + 指针；**tool 原文已在磁盘的不重复送**。仍超摘要预算（窗口 30%）时分段摘要再合并；再失败回退模板 | 落盘先行后消息里本就没有大块原文，摘要输入自然小；map-reduce 是旧数据/未改造路径的保险 |
| 长输出落盘 | 新增共享 helper：输出 > 当前单次预算 → 全文写 `scratch/tool-outputs/<runId>/<tool>-<ts>.txt`，返回「指针 notice（路径 + 总字符数）+ 简短摘录」（文件类给头部、命令/执行类给尾部，与子 Agent 结果回收约定一致）；≤ 预算原样返回 | 与 read_file / 子 Agent 同一心智；预算即长短分界，短输出零打扰 |
| 落盘失败 | 工具返回**明确错误**（说明输出过大且落盘失败，建议分段读取/缩小范围），不返回残文 | SPEC：任何路径都不做硬截断 |
| emergency 路径 | **不变**（确定性模板 + keepRecent 2→1） | 落盘普及后 messages 里无大块原文，emergency 自然恢复有效；API 已报错时不指望模型读全文 |
| 摘要所用模型 | 与上下文预算同一 profile（`resolveContextBudgetProfileId` 路径） | 预算/调用同源，避免按主模型算预算打到视觉模型 |

## 2. 改动详设

### 2.1 落盘 helper（新）

`electron/services/agent/tool-output-externalize.ts`（与 `tool-output-budget.ts` 并列）：

```ts
// 返回 null 表示无需落盘（预算内）；否则返回替换后的指针文本
externalizeToolOutput(opts: {
  output: string
  budget: ToolOutputBudget
  toolName: string
  runId: string
  excerpt: 'head' | 'tail'   // 文件类 head，命令/执行类 tail
}): string | null
```

- 目录：`scratch/tool-outputs/<runId>/`，受 scratch 既有过期自动清理管辖（默认 7 天）
- 指针 notice 文案（i18n 中英）：`[完整输出已保存: <path>，共 N 字符。以下为摘录，需要完整内容请用 read_file 读取]`
- 落盘异常 → 返回工具错误（`success: false`），文案建议分段/缩小范围重试

### 2.2 消费方改造（截断 → 落盘）

| 文件 | 现状 | 改为 |
|---|---|---|
| `tools/file.ts` `applyReadFileOutputBudget` | 超预算截断 | 调 helper，excerpt=head；`maxChars ≤ 0` 的「仅返回摘要」路径同样改为落盘 |
| `tools/exec.ts` `formatTaskOutput` | 预算收紧 + 16KB 截断 | 调 helper，excerpt=tail |
| `tools/command.ts` `applyCommandOutputBudget` | 同上 | 调 helper，excerpt=tail |

`executeTimedCommand` / `executeFireAndForget` 固定 500/300 字符且量小，维持现状。

### 2.3 proactive 真摘要（`context-window.ts` + `agent.ts`）

- `proactiveCompress` 拆为两步：先经回调向 AI 发起摘要请求（新增 dep，如 `summarizeMessages(messages): Promise<string | null>`，由 `agent.ts` 注入，内部走 `aiService.chat` 非流式、不带工具），拿到摘要后走现有 `compressAggressively(run, summary)`；返回 null/抛错则用现有 `buildProactiveSummary()` 模板
- 摘要请求**只带文字**：用户消息、assistant 文本、工具名 + 指针；图片/工具原文不重复送（AI 此前的分析已在对话文字里）
- 摘要 = 压缩本身：AI 写出小结后直接替换被归档的早期对话，继续执行，没有第二道工序；最近 1–2 轮保留原文不动
- 同一 run 只压一次的 `_proactiveCompressedThisRun` 标记不变

**摘要提示词（已确认，i18n 中英双份）**：

```text
你的对话历史即将超出上下文窗口，早期部分将被移除，由你写的这份小结替代。
这份小结是写给之后的你自己看的：你将基于它和最近的对话继续完成任务，
被移除的原文无法再查看。

请输出结构化小结，包含以下部分：

【任务目标】用户最初要求做什么，一句话。
【当前进度】已完成哪些步骤、进行到哪一步。有次序的必须写清数字
  （如"已评审 30/57 份，第 31 份进行中"）。
【关键结论】到目前为止的结论、发现、重要数据。评审/分析类任务逐项保留
  结论要点；涉及的文件保留完整路径。
【进行中的状态】正在编辑/打开的文件、写到哪、未完成的改动。
【下一步】接下来要立即执行的动作。
【注意事项】用户表达过的偏好、限制、待确认事项。

要求：
- 只保留对完成任务有用的信息；工具原始输出、重复内容、试错过程一律不写
  （除非是需要避免重犯的坑）。
- 已保存到文件的指针（路径）必须原样保留，不得改写。
- 全文控制在 {预算} 字以内。
```

### 2.4 `compress_context` 工具描述强化（`tools.ts` + i18n）

description 明确摘要必须包含：任务目标、已完成进度、关键结论/数据/路径、下一步。中英同步。

## 3. 任务拆解

| # | 任务 | 验收 |
|---|---|---|
| C1 | `tool-output-externalize.ts` helper + 目录约定 + i18n 文案 | 单测：预算内返回 null、超预算落盘且指针含路径/字符数/摘录、落盘失败返回错误 |
| C2 | `file.ts` 接入（read_file / 文档解析），删除截断逻辑 | 单测 + CLI 读大文件/PDF：返回指针，read_file 指针路径可读回全文 |
| C3 | `exec.ts` / `command.ts` 接入 | CLI 跑大输出命令：返回指针 + 尾部摘录，全文可读回 |
| C4 | proactive 真摘要：摘要回调注入 + 装配/分段/回退 + 阈值 0.90 | 单测（mock 摘要回调）：成功用 AI 摘要、失败回退模板、分段合并路径；CLI 构造长上下文验证 |
| C5 | `compress_context` 描述强化 + i18n 中英 | 描述含四要素；中英键同步 |
| C6 | 回归：`bash electron/cli/test-cli.sh --no-ai` + agent 相关单测全绿 | 全绿 |

执行顺序：C1–C3 先行（落盘普及后摘要输入才足够小），C4 依赖 C1；C5 可与 C4 同 commit 或独立。

## 4. 风险与注意

- **阈值提前到 0.90** 会更早触发压缩，prompt cache 前缀失效略提前——用真实 `prompt_tokens` 触发，影响可控
- **摘要调用成本**：每次 proactive 多一次小请求；同一 run 只一次，可接受
- **旧数据/未改造路径**仍可能让摘要输入过大 → 分段合并兜底，再失败回退模板，不会比现状更差
- `web_fetch` / excel / word 技能等大输出路径本期不动，落盘 helper 就绪后它们接入是一行调用的事，列为后续候选

## 5. 明确不做

- 不做跨会话压缩归档取回通道（SPEC 已定：摘要自含进度，原文靠历史检索 + 落盘文件兜底）
- 不保留任何形式的硬截断（落盘失败 = 明确报错，不返回残文）
- 不改 emergency 的确定性模板策略（API 已报错时不依赖模型）
- 不做 UI 侧的压缩可视化改动（context ring 类，本期纯后端）
