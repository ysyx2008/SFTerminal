# Workbench（工作台）子系统 SPEC

> Last verified: 2026-06-18

## 职责

把前端「一个 Tab 的界面形态」抽象为**工作台（Workbench）**：一种工作台 = 一组具名区域的固定组合 + 一套（可选的）专用工具贡献。终端、独立助手都是工作台；未来的浏览器工作台等按同一模型扩充。

核心目标：**新增工作台时无需改动 `App.vue` 的渲染分发逻辑**，只在 registry 登记 + 提供渲染器即可。

## 单助手工作台（Hub 模型，2026-06-18）

本地 `assistant` 类型的 Tab 默认进入 **Hub 模式**：Tab 栏不显示，会话由左侧「最近对话」侧栏管理。

- `terminalStore.hubFocusedAssistantTabId`：当前在 Hub 主区展示的会话 tab id。
- `terminalStore.activeTabId` 为空时显示首页（欢迎页 + 侧栏）；`activeTabId` 为空但 `hubFocusedAssistantTabId` 非空时，首页后叠加 AssistantWorkbench（侧栏始终可见）。
- **提升**：右键「在新标签页中打开」→ `tab.isPromoted = true`，该 tab 进入 Tab 栏，等价于旧版独立助手 tab。关闭 promoted tab 时自动降级（`isPromoted` 清除），可在侧栏重新打开。
- **LRU 回收**：Hub 内非提升会话上限 5 个；焦点切换时淘汰最久未聚焦 & 空闲（不运行、不待确认）的会话（agent.cleanup + tab 移除）。
- **并发软上限**：前端发起的并发 Agent 上限 8 个（`isAtConcurrencyLimit` computed），超出时记录警告，不阻止手动操作。
- **远程助手**（`isRemote = true`）不受 Hub 模型影响，始终在 Tab 栏独立显示。

## 设计原则（不可随意推翻）

- **组合 + 贡献，不是开关 + 枚举**：工作台由区域拼成，不用 `hasFileTree` 之类能力位描述；工具以叠加为主、允许覆盖（核心工具是基线）。
- **布局是固定模板**：区域只显隐 / 拖比例，不带焦点高亮、不带递归分割。带焦点的递归分屏（`SplitPane`）是**终端 panel 私有**实现，不属于工作台抽象。
- **后端不受影响**：工作台是纯前端壳概念。后端 Agent 的 `mode`（local/ssh/assistant）与 `tab.type` 不因工作台抽象而改变。

## 公开契约

### 类型（`src/workbench/types.ts`）

- `WorkbenchKind`：复用 `@shared/types` 的 `TerminalType`，**唯一数据源**，不另立枚举。新增工作台先在 `TerminalType` 扩展。
- `RegionSpec`：区域声明（`id` / `role: anchor|toggle` / `side` / `defaultVisible` / `resizable`）。当前为声明式工作台预留，内置工作台暂未使用。
- `WorkbenchDescriptor`：一种工作台一条。字段：`kind`、`renderer?`（自定义渲染器逃生口）、`regions?`（声明式区域）、`availableInSteam?`。

### Registry（`src/workbench/registry.ts`）

- `getWorkbenchDescriptor(kind)`：取描述。
- `resolveWorkbenchRenderer(kind): Component`：查表返回渲染器组件，供 `App.vue` 的 `<component :is>` 分发。Steam 构建下不可用的工作台（如助手）回退到终端渲染器，复刻原 `v-if/v-else` 行为。

### 渲染器 props 约定（契约）

所有工作台渲染器组件统一接收：

```ts
{ tab: TerminalTab; isActive: boolean }
```

`App.vue` 还会绑定 `ref`（写入 `tabViewRefs`）和 `class="tab-view"`。注意：`tabViewRefs` 的命令式方法（`toggleAiPanel` / `ensureAiPanel`）**仅终端渲染器（TerminalTabView）暴露**，调用侧必须先用 `isTerminalTab()` 过滤，否则在助手等实例上调用会 TypeError。

### 通用布局外壳（`src/components/workbench/WorkbenchShell.vue`）

「常驻锚点区 + 可显隐辅助区 + 可拖分隔条」布局。具名 slot：`#anchor`（常驻）、`#toggle`（可隐）。props：`toggleVisible` / `toggleRatio`(v-model) / `toggleSide` / `minRatio` / `maxRatio`。无特殊 chrome 的工作台都应基于它组合。

## Kind 是什么

`WorkbenchKind` = `TerminalType` = **`tab.type` 的字面值**（`'local' | 'ssh' | 'assistant'`）。不是 UI 壳的别名：local 与 ssh 是两个 kind，但共用 `TerminalTabView` 渲染器。

## 如何新增一个工作台（checklist）

1. **扩类型**：`shared/types` 的 `TerminalType` 加新 kind（如 `'browser'`）。
2. **建目录**：`src/workbench/<kind>/`（与类型字面量同名）。
3. **descriptor**：`<kind>/descriptor.ts` 导出 `WorkbenchDescriptor`（renderer、availableInSteam 等）。
4. **渲染器**：无特殊 chrome → `WorkbenchShell` 组合（参考 `AssistantWorkbench.vue`）；有特殊 chrome → 专属组件（参考 `TerminalTabView`）。
5. **登记**：`registry.ts` import 该 descriptor 写入 `DESCRIPTORS`。
6. **（可选）Agent UI 描述**：`<kind>/prompt.ts` + 在 `resolve-workbench-agent-prompt.ts` 注册。
7. **创建入口**：terminal store 建 tab + 欢迎页/菜单入口。
8. **复查分支**：搜索 `tab.type === '…'` 硬编码，确认新 kind 是否需要兼顾。

> 第 1~5 步是 workbench 模块内成本；第 7~8 步是模块外集成点。

## 内置工作台

| kind | 目录 | 渲染方式 | 锚点区 | 可隐区 |
|------|------|---------|--------|--------|
| `local` | `local/` | `TerminalTabView` | 终端区 | AI 侧栏 |
| `ssh` | `ssh/` | `TerminalTabView`（同 local） | 终端区 | AI 侧栏 |
| `assistant` | `assistant/` | `AssistantWorkbench` | 聊天 | Artifact（见 `assistant/artifact/SPEC.md`） |

## 目录约定

```
src/workbench/
  SPEC.md
  index.ts
  types.ts
  registry.ts                        # 聚合各 kind 的 descriptor
  resolve-workbench-agent-prompt.ts  # 按 kind 路由 prompt
  local/
    descriptor.ts
  ssh/
    descriptor.ts
  assistant/
    descriptor.ts
    prompt.ts
    agent-tools.ts
    snapshot.ts
    artifact/                  # 产出物面板（原 src/canvas + components/Canvas）
      SPEC.md
      index.ts
      store.ts
      domain/
      renderers/
      components/
  __tests__/
```

Vue 渲染器暂仍在 `src/components/`（`TerminalTabView`、`AssistantWorkbench`）；descriptor 引用之。**与 kind 绑定的契约**（descriptor、prompt）放在同名子目录。

## Agent 工作台提示词

- 文案：`<kind>/prompt.ts`（目前仅 `assistant/`）
- 路由：`resolve-workbench-agent-prompt.ts` → `workbenchPrompt`
- 注入：桌面 App 内**非 remote** 的 assistant tab → `AgentContext.workbenchPrompt`；`PromptBuilder` 原样插入 system prompt（同 session cache 路径沿用首条 system，仍含该段）
- 文案须与真实 UI 一致：产出物面板**按需出现**（有文件类 artifact 才展开）；全部关闭后**自动隐藏**；一次只预览一个，多个时标题下拉切换；chart 仅在对话流展示，不注册 artifact
- **来源**：artifact 携带 `sourceStepId`，右键菜单「跳到生成处」滚动对话流

## Agent 工作台工具

- 定义：`assistant/agent-tools.ts`（assistant 模式由 `getAgentTools` 注册）
- 执行：`electron/services/agent/tools/workbench.ts`
- `list_workbench_artifacts`（只读、可并行）— 经 `workbench-bridge` → `src/services/workbench-handler.ts` 读 `artifactStore` 真值；查询前先 `syncArtifactsWithDisk`（静默），再返回快照（`shared/types/workbench.ts`）
- `manage_workbench_artifacts`（`action: open | close`）— 不走 bridge，而是读盘后发 `canvasData` step（同文件写入工具链路），随历史持久化、重开会话可恢复。`open` 仅支持 `.md`/`.html` 等可直接预览文本；其余类型走各自专用工具

## 依赖与边界

- 渲染器组件依赖各自的面板组件（`AiPanel` / `ArtifactPanel` / `Terminal` 等）与相关 store（`useAssistantArtifactStore` → `artifact/domain/artifact-registry.ts`）。
- **不参与**工作台抽象、保持独立的：`SplitPane` 树（终端分屏，`stores/split-pane-tree.ts`）、后端 Agent mode、`tab.type` 的后端语义。

## 尚未做（刻意留白）

- 区域部件（panel）词汇为宿主内置，**不做可扩展/插件化**——按需再说。
- 声明式 `regions` 尚未由通用壳自动渲染（内置工作台都走 renderer / 手动组合 WorkbenchShell）；待出现「纯声明即可」的工作台时再实现。
- 区域显隐 / 尺寸状态仍分散（终端在 TerminalTabView 局部 ref，助手在 artifactStore）。后续可归一到 workbench store，届时终端命令式 API 可退化为 store action。
