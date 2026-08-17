# 助手产出物（Artifact）子系统 SPEC

> Last verified: 2026-08-17

## 职责

**assistant 工作台专属**：右侧产出物工作区，用户可 revisit 的文件类结果（Word / Excel / Markdown / HTML 页面 / PPT 预览；未来的图表、浏览器快照等）。

**定位**：本次助手会话产出的、可 revisit 的文件类成果索引 + 内嵌预览/轻编辑。不是文件管理器，不替代 Finder。

**HTML 产出物的浏览器形态**（2026-08-04 确认）：HTML 类产出物的预览不是静态图片式的「看结果」，而是应用内浏览器——可刷新、可访问助手启动的本地开发服务（live URL）、可把渲染结果截图连同用户意见回传给助手修改，形成「看效果 → 提意见 → 助手改 → 再看」的闭环。明确不做：页面内圈选/区域级评论（一期为整页截图 + 文字意见）；面板预览与用户真实浏览器无关，不接入 browser-bridge；一个产出物一个预览实例，不做多标签浏览器。

**产出物交付（「发送到手机」，2026-08-04 确认设计，待实现）**：产出物面板提供「发送」入口，把产出物文件经 IM 渠道直发到用户手机，补上「秘书写好报告 → 递出去」的最后一环。渠道弹窗列出全部内置渠道（钉钉/飞书/企微/微信/Slack/Telegram），**可直发的渠道排在最前、已连接的次之、未连接垫底**：已连接且持有会话上下文的渠道可点击直发——发到**渠道默认会话**（bot 与用户的私聊、或 bot 所在的群），选中即发、结果即时反馈，与「保存 / 打开」同为面板文件操作，不经助手；**未连接的渠道灰色禁用**，悬浮提示去设置页连接；**已连接但尚无会话上下文的渠道同样禁用**，提示先在该渠道与助手对话一次。渠道状态随连接变化实时刷新（如启动后渠道稍晚连上，弹窗内自动转为可用）。明确不做：邮件发送（留待联系人结构化后再议）；IM「发到哪个群 / 哪个会话」选择（只到渠道默认会话）；独立交付日志。纯内容未落盘的产出物须先另存为文件才能发送。

**命名说明**：Agent 协议层仍称 `CanvasData`（`shared/types/canvas.ts`）；前端 UI 域统一称 **artifact**，模块位于 `packages/workbench-assistant/src/artifact/`（`@sailfish/workbench-assistant/artifact`）。

## 设计目标

**人机双写（Markdown 产出物，2026-08-04 确认）**：Markdown 产出物是用户和助手**共用的一块画布**——用户选中一段就能让助手只改这段（选区即作用域），助手改完会简述改了哪里方便核对。行为承诺：

- **磁盘文件是双方共同的唯一真相**：助手经文件工具改盘、面板是文件的编辑器，不做绕过磁盘的写入通道
- **选区即作用域**：用户带着选区发修改指令时，助手只动选区范围；选区行号精确时按行改，不精确时以选中原文为锚；除非用户明确要求，不动范围外的内容，确需联动修改先说明再动手
- **用户的未保存修改对助手可感知**：助手能看到面板里哪个文件有未保存修改；改盘后发现与用户编辑冲突时，会在回复中告知
- **冲突时永远保护用户侧**：助手的磁盘改动与用户未保存的草稿冲突时，草稿不被冲掉，面板明确提示并由用户显式选择——载入助手版本，或保留自己的修改（随后保存即覆盖助手版本）
- **选中就能发指令**：选中后直接在下方输入框写要求即可。文档里保留选区高亮方便确认范围；**不出现引用胶囊，聊天气泡也不展示选区脚手架**——气泡只留用户写下的话，选区原文经工作台上下文旁路交给助手。右键快捷指令只预填输入框文案。助手仍须只改选区范围（内容锚定）

**编辑器形态（2026-08-04 确认）**：Markdown 产出物的编辑面是**真 WYSIWYG**（Typora 式：表格/代码块/数学公式可视化编辑，无语法符号、无编辑/预览模式切换）。由此产生两条行为承诺：

- **保存即规范化**：所见即所得编辑器以自己的标准格式写回文件——用户未触碰部分的排版风格（列表符号、标题写法、空行等）在保存时可能被重排为规范形式；内容语义不变
- **选区引用无行号**：从可视化编辑器选区引用的摘录以选中原文为锚（内容匹配），不携带精确文件行号

明确不做（一期）：改前 diff 逐条确认；预览选区的精确行号；Excel/PPT 双写。

**面板收起（2026-08-17 确认）**：产出物面板的收起与历史对话侧栏同一套手感——收起后整栏消失，不留一条图标窄栏。开关钉在工作台右上角，开合时不跟着面板跑；有产出物时始终在，图标随开合换向。助手再产出新东西时，面板会自动打开。开合是抽屉推拉：整栏滑入滑出，不是整块闪没或闪现。

## 目录

```
packages/workbench-assistant/src/artifact/
  SPEC.md
  index.ts                 # 对外统一导出
  store.ts                 # Pinia：useAssistantArtifactStore
  domain/                  # 纯函数领域逻辑
  renderers/
    registry.ts            # 能力元数据
    ui-registry.ts         # Vue 组件 + 图标
  components/
    ArtifactPanel.vue      # 主面板
    *Renderer.vue
  ui/
    useHoverTip.ts         # 包内悬浮提示（不经 SDK）
    HoverTipOverlay.vue
  composer-quote.ts        # 引用到 Composer 的类型 + inject key
  composables/
    useArtifactAgentBridge.ts  # 仅 AssistantWorkbench 挂载
  __tests__/
```

桌面宿主注册：`src/workbench/assistant/register-artifact-host.ts`（经 `ArtifactDesktopHost`）。

对 desktop 的依赖：
- **经宿主契约** `ArtifactDesktopHost`（desktop `registerArtifactDesktopHost`）：steps / 激活态 / 历史持久化 —— **不**直引 terminalStore
- **经 SDK**：`@sailfish/workbench-sdk/toast`、`@sailfish/workbench-sdk/markdown`
- **岗壳接线**（AiPanel defineExpose）：`scrollToAgentStep`、`addComposerQuote` —— **不**直引 composerQuoteStore
- **包内 UI**：`ui/useHoverTip` + `HoverTipOverlay`（不经 SDK，不直引 `@/`）
## 分层

| 层 | 路径 | 职责 |
|---|---|---|
| 协议类型 | `shared/types/canvas.ts` | `CanvasData` / `CanvasArtifact` / ID 推导 |
| 渲染器能力 | `renderers/registry.ts` | editable / saveStrategy / defaultExt（纯函数） |
| 渲染器 UI | `renderers/ui-registry.ts` | Vue 组件 + 图标映射 |
| 领域逻辑 | `domain/artifact-registry.ts` | 纯函数 registry |
| UI 适配 | `store.ts` | Pinia tab 容器 + 布局比例 |
| Agent 接线 | `composables/useArtifactAgentBridge.ts` | **仅 AssistantWorkbench 挂载**：经 ArtifactDesktopHost 读 steps → handleAgentStep |
| 桌面宿主 | `host.ts` + desktop `register-artifact-host.ts` | getAgentSteps / isTabActive / persistArtifacts |
| 溯源 / 引用 | `AiPanel.scrollToAgentStep` / `addComposerQuote` + 岗壳转发 | ArtifactPanel prop → provide；Markdown inject |
| 保存逻辑 | `domain/artifact-actions.ts` | Save / Save As / Save All（查注册表） |
| 编辑桥接 | `domain/artifact-save-bridge.ts` | Markdown draft → 面板级保存 |
| 磁盘同步 | `domain/artifact-file-status.ts` + `artifact-disk-sync.ts` | exists 复检；exec 后触发 |
| 右键菜单 | `domain/artifact-context-menu.ts` | 菜单项可见性（查 editable） |
| 视图 | `components/*` | ArtifactPanel |

## 数据模型（CanvasArtifact）

- `origin`: `'agent' | 'user'` — upsert 时填充，默认 agent
- `editable`: 派生自 renderer 注册表，消除 UI 层 `renderer === 'markdown'` 硬判断
- `sourceStepId`: 产生该产出物的 `AgentStep.id`，仅 UI 溯源，不复制 step 内容
- `url`（可选）: URL 型产出物的目标地址（`browser` renderer）；与 `content`/`filePath` 互斥
- `hadArtifacts`（Tab 级）：本会话是否曾出现过产出物（内部状态）；面板可见性仅取决于 `artifacts.length > 0`

## 渲染器注册表

新增 renderer 时只改两处：

1. `renderers/registry.ts` — 能力（editable / saveStrategy / defaultExt）
2. `renderers/ui-registry.ts` — 组件 + 图标

`ArtifactPanel` 通过 `<component :is="getRendererComponent(type)">` 动态渲染。

**HTML 渲染器**：`html` 类型用 `HtmlRenderer.vue`，以应用内嵌浏览器（`<webview>` 独立渲染进程）渲染，而非 iframe——iframe 的 `srcdoc`/sandbox 形态无法支持视觉截图（跨域画不出）与 live URL 导航。内容经自定义协议 `sailfish-artifact://` 供给（主进程按产出物实时供内容，内容更新即刷新；相对路径资源受限映射到产出物文件所在目录，防目录穿越）。**不用** `blob:`/`file://` 直载的理由同前（宿主 CSP、dev 模式 `webSecurity` 拦截）。预览前会去掉失效的外部 CSS `@import`；`content` 为空时组件与 store 均会按 `filePath` 读盘回填。Agent 写入/编辑 `.html`/`.htm` 时由 `tools/file.ts` 自动产出（同 `.md`）；PPT 技能也复用该渲染器（`content` 为内联 HTML，`filePath` 指向 `.pptx`）。

**URL 型产出物**：`browser` 渲染器承载「指向某个 URL 的实时预览」（典型：助手启动的本地 dev server），由 `CanvasData.url` 显式声明（不做内容嗅探）。工具栏带可编辑地址栏；无 `filePath`，保存/发送等文件类入口对其隐藏。

## 头部与交互

- **布局**：左侧当前产出物名称（≥2 个时为下拉切换）+ 右侧 **「保存」+「打开」+「▾」+「发送」**（▾ 内：打开所在文件夹、另存为、全部保存；「发送」见上方「产出物交付」）
- **名称语义化**：面板标题、另存为默认名、发送到手机的文件名一律使用产出物的语义标题，仅在无标题时退化为物理文件名；时间戳、随机 ID 等机器标识不得出现在用户可见名称中（Agent 侧在命名引导中约束）
- **单预览**：同时只展示一个产出物；切换靠标题下拉（含搜索，≥4 项）
- **下拉内右键**：保持列表打开；关闭产出物请用右键菜单（列表行内不设 ×）
- **右键菜单**：标题/路径 → 打开组 → 保存组 → 关闭组（按 editable/dirty/文件是否存在显隐）
- **保存**：editable 且有 path + 在盘 + dirty 才可「保存」；预览类仅「另存为」
- **来源**：`sourceStepId` 指向 UI 可见的 `tool_call`（canvasData 多在隐藏的 `tool_result` 上，入库时按 `toolCallId` 解析）；右键「跳到生成处」滚动对话流并高亮
- **收起**：整栏消失，不留窄栏；开关钉在工作台右上角，开合时位置不动。助手再产出新东西时自动打开
- **空面板**：全部产出物关闭或磁盘同步移除后，面板自动隐藏；有新产出时再展开
- **磁盘同步**：path 不存在则移除项（含 `exec`/`await_exec` 后复检）。**不会**扫描目录或推断 `mv` 新路径；Shell 改名后须 Agent 用带 canvasData 的工具重新 open

## CanvasData.action

- `open`：upsert artifact（宿主注入 `sourceStepId`）；URL 型产出物经 `url` 字段声明
- `update`：替换 content（URL 型可替换 url）
- `close`：移除 artifact

## Artifact ID

- 有 `filePath` → `file:${absolutePath}`
- 有 `url` → `url:${url}`
- 否则 → `ephemeral:${renderer}:${title}`

## 兼容导出

- `src/canvas/index.ts`、`src/stores/canvas.ts` 保留 `@deprecated` re-export，供旧 import 路径过渡。

## 测试

- `src/stores/__tests__/artifact-registry.test.ts`
- `src/stores/__tests__/artifact-tab-layout.test.ts`
- `__tests__/artifact-actions.test.ts`
- `__tests__/artifact-file-status.test.ts`
- `__tests__/artifact-disk-sync.test.ts`
- `__tests__/artifact-context-menu.test.ts`
- `__tests__/renderer-registry.test.ts`
- `__tests__/artifact-source.test.ts`

## 历史恢复

- `AgentStepRecord.canvasData` 随会话持久化；`restoreAgentHistory` 调用 `hydrateFromSteps` 重放 steps 中的 canvasData，并从 `step.id` 回填 `sourceStepId`。
- 升级前已保存的历史无 canvasData 字段，Artifact 面板无法恢复（需重新生成产出物）。
- **content 外化**：`contentFromFile` 为真的产出物（md/html，content 即磁盘文件内容）持久化时由 `history.service.stripRederivableCanvasContent` 剥离 content（克隆后删，不动实时会话的共享对象），避免大文件（内联数据的 HTML dashboard）撑爆历史记录与 IPC。恢复后 `hydrateFromSteps` / `handleAgentStep(open)` 调用 `reloadArtifactContent`：`md/html` 读盘回填，`document`/`spreadsheet` 经 `localFs:previewArtifact` 从磁盘重建预览 HTML。读盘与 step 到达存在竞态时会退避重试（400ms / 1200ms）；切换产出物、展开面板、渲染器挂载时也会再次触发回填。

## Agent 认知

- 工作台 UI 描述见 `../prompt.ts`；实时状态用 `list_workbench_artifacts`（见 `src/workbench/SPEC.md`）。
- 主动维护面板用 `manage_workbench_artifacts`（assistant 模式专属，执行器在 `electron/services/agent/tools/workbench.ts`）：
  - `action:'open'` — 把已有本地文件打开进面板，仅支持可直接预览的文本类（`.md`/`.markdown`/`.html`/`.htm`）；`.docx`/`.xlsx`/PPT 各走专用工具。读盘后发 `canvasData{action:'open', contentFromFile:true}`，与文件写入工具同链路，随历史持久化、重开会话可恢复。
  - `action:'close'` — 按 `filePath` 发 `canvasData{action:'close'}` 移除面板项。
  - 路径解析：`expandTilde` + 相对路径按 `getTerminalStateService().getCwd(ptyId)` 解析。
