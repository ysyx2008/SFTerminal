# 产出物人机双写（Markdown 先行）设计方案

> 2026-08-04。**已完成。** 触发：WorkBuddy「人机双写」体验评估后的落地决策——不做全套 Office 双写（编辑器成本 80% 在腾讯文档肩上），先做 markdown 闭环。协议结论：旗鱼双许可（AGPL+商业），第三方 AGPL 编辑器（PPTist/SuperDoc）会污染商业版分发，故一律不引依赖，基于现有产出物面板自建。

## 目标

让 assistant 工作台里的 Markdown 产出物成为「人和 AI 共用的一块画布」：

1. **选区即作用域**：用户选中一段 → 一句话指令 → AI 只改这段，其余不动
2. **AI 能看见正在发生的工作**：用户在面板的编辑（含未保存状态）对 AI 可感知
3. **用户的输入永远不被 AI 冲掉**：AI 改盘与用户未保存草稿冲突时，保护用户侧
4. **AI 的改动用户可感知**：改了哪里、改没改完，在面板里有明确信号

## 设计原则

- **磁盘文件是唯一真相源**。面板是文件的编辑器，AI 通过文件工具改盘，双方在同一真相源上汇合。不做「面板内绕过磁盘的双通道写入」
- **冲突时保护人**。AI 的改动可随时重放（再跑一次工具即可），用户未保存的输入不可再生
- **作用域靠「行号 + 内容」双锚定**，不靠关键词匹配式的脆弱定位
- **一期不做 diff 确认视图**（tracked changes 式逐条接受/拒绝留给二期，配合 SuperDoc/Univer 评估）

## 现状盘点（已验证）

已有（比预想完整）：

- 选区引用：预览（window 选区，无行号）/ 编辑（textarea 选区，精确行号）双模式；右键菜单 + Cmd/Ctrl+L
- 发送时附完整摘录：绝对路径 + 起止行号 + 行号正文 + 准确性声明（`AiComposer.formatQuotesAppendix`）
- AI 改盘 → 面板刷新：`edit_file` / `write_text_file` 对 `.md/.html` 自动发 canvasData（`previewCanvasDataForPath`）
- 精确行范围编辑工具已存在：`write_text_file` 的 `replace_lines` 模式（start_line/end_line）
- 面板 dirty 跟踪：`artifact-save-bridge`（组件作用域）

缺口：

| 缺口 | 现状 |
|---|---|
| 作用域约束 | 消息里有行号，但没有任何规则告诉 AI「只能动这段」 |
| 快捷指令 | 右键菜单只有「引用到 Composer」，指哪打哪的体感差一步 |
| dirty 语义 | = 草稿 ≠ store.content，而 store.content 会被 flush 写成草稿值——**不等于「与磁盘不同」**，冲突检测会误判 |
| 冲突保护 | 无。AI 改盘 → `watch artifact.content` 直接覆盖草稿，用户未保存修改静默丢失 |
| AI 感知 dirty | `list_workbench_artifacts` 快照无 dirty 字段；AI 改盘时不知道用户有未保存编辑 |

## 方案

### 1. 磁盘基线与 dirty 语义修正（前端 store，一切的地基）

引入**磁盘基线**（session 级，不持久化）：每个 artifact 记录「最近一次确认的磁盘内容」。

- 基线更新点（三处）：读盘回填（`reloadArtifactContent`/hydration）、Agent canvasData 推送（`contentFromFile` 时 content 即磁盘内容）、面板保存成功
- **dirty 重定义为 `草稿 ≠ 磁盘基线`**（取代现在的 `草稿 ≠ store.content`）
- dirty 状态从 saveBridge 组件作用域**提升到 artifact store**（tab 级 side-table，不进历史持久化），saveBridge 的 `setDirty` 写穿到 store——这样渲染进程的 `workbench-handler`（desktop 层）也能读到

### 2. 冲突保护（MarkdownRenderer）

外部内容更新（Agent 推送 / 磁盘回填）到达时按 dirty 分流：

- 草稿**未偏离**旧基线（含完全没动过）→ 直接接受新版本（现状行为）
- 草稿**已偏离** → 保留用户草稿不动，新版本存入 `deferredExternal`，工具栏出现横幅：

> 「AI 已更新磁盘上的版本，你有未保存的修改」 ［载入 AI 版本］［保留我的修改］

- 「载入 AI 版本」：草稿 ←  deferred 版本，基线同步，dirty 清除
- 「保留我的修改」：横幅关闭，草稿不动；之后 Cmd+S 保存即覆盖磁盘（含 AI 版本）——这是用户的显式选择，允许
- 横幅在下次外部更新时刷新为最新版本；切换产出物/卸载组件时 deferred 随草稿一起经 saveBridge flush 保全

纯函数决策逻辑落 `domain/coedit-conflict.ts`（输入：草稿/旧基线/新外部版本，输出：accept | defer），组件只做接线——可单测。

### 3. 选区快捷指令（MarkdownRenderer 右键菜单）

右键菜单从 1 项扩为两组：

- 引用到 Composer（现有，Cmd/Ctrl+L 不变）
- **让 AI 处理这段**（子项：改写 / 润色 / 纠错校对 / 翻译为英文 / 扩写）

每个快捷指令 = 引用选区（复用现有 `pushQuoteSnippet`）+ 把指令模板填入 composer 草稿（复用 AssistantWorkbench 已暴露的 `setComposerDraft` 链路，新增 provide key）。用户可继续编辑指令再发送——**指令模板只是省打字，不剥夺控制权**。

预览模式选区同样可用（无精确行号，Agent 退化为内容锚定）。

### 4. 作用域约束（Agent prompt）

`packages/workbench-assistant/src/prompt.ts` 增加「人机双写」规则（自然语言行为契约，不写实现名）：

- 用户消息中带行号的引用摘录 = 用户**指着这段说话**；修改类指令的作用域就是该范围
- 行号精确时：优先用 `write_text_file` 的 `replace_lines` 按范围改；行号不精确（预览选区）时：用 `edit_file` 以摘录原文为锚
- 除非用户明确要求，**不动引用范围之外的内容**；确需联动修改（如改了标题要同步目录）先在回复里说明再动手
- 改完后在回复里简述改了哪些行，方便用户核对

### 5. AI 感知 dirty + 改盘提醒（后端）

- `WorkbenchArtifactSnapshot.artifacts[]` 增加 `dirty: boolean`（shared/types + snapshot.ts + workbench-handler 读 store）
- `edit_file` / `write_text_file` 成功写入 `.md/.html` 后：经 workbench-bridge 查该 filePath 在面板是否 dirty（复用 `list_artifacts` op，错误即非助手场景，静默跳过）；dirty 则在工具输出**追加提醒**（不阻断、不额外确认）：

> 「注意：该文件在产出物面板中有用户未保存的修改，你的改动已写入磁盘但不会出现在用户当前编辑视图中。建议在回复中提醒用户。」

- prompt 中同步一条：改面板中打开的文件前，如担心与用户编辑冲突，可先 `list_workbench_artifacts` 看 dirty

### 6. i18n

新增键中英同步（`canvas.coedit*` / 工具提醒文案），涉及 `src/i18n/locales/zh-CN|en-US/` 对应域文件 + agent i18n。

## 明确不做（一期）

- diff 确认 / tracked changes 式逐条接受拒绝（二期，依赖编辑器选型）
- 预览选区 → 源文件行号映射（渲染 HTML 与源文无稳定映射，投入产出不值）
- Excel / PPT 双写（等 Univer Slides 成熟或另评估；协议结论见顶部）
- 多人 + AI 协作的权限规则（文章自己都说业界没答案）
- AI 改动的面板内高亮闪烁（一期靠对话流 edit 卡片行号 + 回复说明）

## 任务拆解（原子任务 + 验收）

| # | 任务 | 状态 | 文件 | 验收 |
|---|---|---|---|---|
| 1 | SPEC 写入设计目标 | ✅ | `packages/workbench-assistant/src/artifact/SPEC.md` | 每句话用户可验收，无实现名 |
| 2 | 磁盘基线 + dirty 提升进 store | ✅ | `artifact/store.ts`、`domain/`（新 pure 模块）、`artifact-save-bridge.ts` 写穿 | 单测：三处基线更新点、dirty 重定义 |
| 3 | 冲突保护 | ✅ | `domain/coedit-conflict.ts`（新）、`MarkdownRenderer.vue` | 单测 accept/defer 全分支；手测：面板改字不保存 → AI 改盘 → 草稿保留 + 横幅两动作 |
| 4 | 快照 dirty + Agent 提醒 | ✅ | `shared/types`、`snapshot.ts`、`workbench-handler.ts`、`tools/file.ts` | 单测快照字段；CLI 手测 dirty 提醒输出 |
| 5 | 快捷指令菜单 | ✅ | `MarkdownRenderer.vue`、`composer-quote.ts`（新 provide）、`ArtifactPanel.vue`、i18n | 手测五个指令 = 引用 + 模板填入 |
| 6 | prompt 双写规则 | ✅ | `packages/workbench-assistant/src/prompt.ts` | CLI 跑一个「改这段」任务验证作用域行为 |
| 7 | 回归 + 审查 | ✅ | — | `test-cli.sh --no-ai` 绿；claude-review 问题清零 |

commit 粒度：任务 2-3 一个（前端地基+保护）、4 一个（后端感知）、5 一个（UX）、6 一个（prompt），SPEC 随首个代码 commit。

## 风险

- **dirty 语义切换的回归**：现有「未保存」提示、保存按钮可用态都挂在旧语义上，需全量过一遍 `isDirty` 调用点
- **bridge 查询增加时延**：每次 edit_file 多一次主→渲染 IPC（毫秒级，非助手场景快速失败）；CLI 模式无窗口直接跳过
- **横幅打扰**：AI 连续多次改盘时横幅反复出现——用 deferred 版本随更新刷新、用户明确选择前不重复弹的方式压住
