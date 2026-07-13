# 助手产出物（Artifact）子系统 SPEC

> Last verified: 2026-07-13

## 职责

**assistant 工作台专属**：右侧产出物工作区，用户可 revisit 的文件类结果（Word / Excel / Markdown / HTML 页面 / PPT 预览；未来的图表、浏览器快照等）。

**定位**：本次助手会话产出的、可 revisit 的文件类成果索引 + 内嵌预览/轻编辑。不是文件管理器，不替代 Finder。

**命名说明**：Agent 协议层仍称 `CanvasData`（`shared/types/canvas.ts`）；前端 UI 域统一称 **artifact**，模块位于 `packages/workbench-assistant/src/artifact/`（`@sailfish/workbench-assistant/artifact`）。

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
  composables/
    useArtifactAgentBridge.ts  # 仅 AssistantWorkbench 挂载
  __tests__/
```

桌面宿主注册：`src/workbench/assistant/register-artifact-host.ts`（经 `ArtifactDesktopHost`）。

对 desktop 的依赖：
- **经宿主契约** `ArtifactDesktopHost`（desktop `registerArtifactDesktopHost`）：steps / 激活态 / 历史持久化 —— **不**直引 terminalStore
- **经 SDK**：`@sailfish/workbench-sdk/toast`、`@sailfish/workbench-sdk/markdown`
- **仍 `@/`（过渡）**：HoverTip、composerQuoteStore
- 溯源跳转：AiPanel.scrollToAgentStep（岗壳接线）
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
| 溯源跳转 | `AiPanel.scrollToAgentStep` + 岗壳 ref 转发 | ArtifactPanel 经 prop 调用 |
| 保存逻辑 | `domain/artifact-actions.ts` | Save / Save As / Save All（查注册表） |
| 编辑桥接 | `domain/artifact-save-bridge.ts` | Markdown draft → 面板级保存 |
| 磁盘同步 | `domain/artifact-file-status.ts` + `artifact-disk-sync.ts` | exists 复检；exec 后触发 |
| 右键菜单 | `domain/artifact-context-menu.ts` | 菜单项可见性（查 editable） |
| 视图 | `components/*` | ArtifactPanel |

## 数据模型（CanvasArtifact）

- `origin`: `'agent' | 'user'` — upsert 时填充，默认 agent
- `editable`: 派生自 renderer 注册表，消除 UI 层 `renderer === 'markdown'` 硬判断
- `sourceStepId`: 产生该产出物的 `AgentStep.id`，仅 UI 溯源，不复制 step 内容
- `hadArtifacts`（Tab 级）：本会话是否曾出现过产出物（内部状态）；面板可见性仅取决于 `artifacts.length > 0`

## 渲染器注册表

新增 renderer 时只改两处：

1. `renderers/registry.ts` — 能力（editable / saveStrategy / defaultExt）
2. `renderers/ui-registry.ts` — 组件 + 图标

`ArtifactPanel` 通过 `<component :is="getRendererComponent(type)">` 动态渲染。

**HTML 渲染器**：`html` 类型用 `HtmlRenderer.vue`，以 iframe `srcdoc` 渲染 `content`（**不用** `blob:` URL——宿主 `index.html` CSP 的 `default-src 'self'` 会拦截 iframe 导航到 `blob:`），`sandbox="allow-scripts allow-popups allow-forms allow-modals"`（不开 `allow-same-origin`，脚本以不透明源运行、无法访问父页面）。预览前会去掉 sandbox 下常失效的外部 CSS `@import`；`content` 为空时组件与 store 均会按 `filePath` 读盘回填。Agent 写入/编辑 `.html`/`.htm` 时由 `tools/file.ts` 自动产出（同 `.md`）；PPT 技能也复用该渲染器（`content` 为内联 HTML，`filePath` 指向 `.pptx`）。不用 `file://` 直载：dev 模式 `webSecurity` 会拦截，且无法覆盖 PPT 场景。

## 头部与交互

- **布局**：左侧当前文件名（≥2 个时为下拉切换）+ 右侧 **「保存」+「打开」+「▾」**（▾ 内：打开所在文件夹、另存为、全部保存）
- **单预览**：同时只展示一个产出物；切换靠标题下拉（含搜索，≥4 项）
- **下拉内右键**：保持列表打开；关闭产出物请用右键菜单（列表行内不设 ×）
- **右键菜单**：标题/路径 → 打开组 → 保存组 → 关闭组（按 editable/dirty/文件是否存在显隐）
- **保存**：editable 且有 path + 在盘 + dirty 才可「保存」；预览类仅「另存为」
- **来源**：`sourceStepId` 指向 UI 可见的 `tool_call`（canvasData 多在隐藏的 `tool_result` 上，入库时按 `toolCallId` 解析）；右键「跳到生成处」滚动对话流并高亮
- **空面板**：全部产出物关闭或磁盘同步移除后，面板自动隐藏；有新产出时再展开
- **磁盘同步**：path 不存在则移除项（含 `exec`/`await_exec` 后复检）。**不会**扫描目录或推断 `mv` 新路径；Shell 改名后须 Agent 用带 canvasData 的工具重新 open

## CanvasData.action

- `open`：upsert artifact（宿主注入 `sourceStepId`）
- `update`：替换 content
- `close`：移除 artifact

## Artifact ID

- 有 `filePath` → `file:${absolutePath}`
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
