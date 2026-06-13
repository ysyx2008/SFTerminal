# Workbench（工作台）子系统 SPEC

> Last verified: 2026-06-09

## 职责

把前端「一个 Tab 的界面形态」抽象为**工作台（Workbench）**：一种工作台 = 一组具名区域的固定组合 + 一套（可选的）专用工具贡献。终端、独立助手都是工作台；未来的浏览器工作台等按同一模型扩充。

核心目标：**新增工作台时无需改动 `App.vue` 的渲染分发逻辑**，只在 registry 登记 + 提供渲染器即可。

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

## 如何新增一个工作台（checklist）

1. **扩类型**：`shared/types` 的 `TerminalType` 加新 kind（如 `'browser'`）。
2. **写渲染器**：
   - 无特殊 chrome → 写组件组合 `WorkbenchShell`（参考 `AssistantWorkbench.vue`）。
   - 有特殊 chrome（如终端的 Terminal Teleport 保命池）→ 走 `renderer` 逃生口，提供专属组件。
3. **登记**：在 `registry.ts` 的 `DESCRIPTORS` 加一条。
4. **创建入口**：在 terminal store 的建 tab 逻辑与欢迎页/菜单加入口。
5. **复查历史分支**：搜索现存 `tab.type === 'assistant'` / `'local'` / `'ssh'` 分支，确认新 kind 是否需要兼顾（文件树、Agent 工具集、批量命令等）。

> 第 1~3 步是工作台模块内成本；第 4~5 步是模块外集成点，是目前抽象尚未完全收敛的部分。

## 内置工作台

| kind | 渲染方式 | 锚点区 | 可隐区 |
|------|---------|--------|--------|
| `local` / `ssh` | `renderer` = `TerminalTabView`（逃生口，含 Teleport 保命池） | 终端区（内含 SplitPane） | AI 侧栏 |
| `assistant` | `AssistantWorkbench`（声明式 → WorkbenchShell） | 聊天（AiPanel） | Artifact 面板（CanvasPanel，多 tab；见 `src/canvas/SPEC.md`） |

## 依赖与边界

- 渲染器组件依赖各自的面板组件（`AiPanel` / `CanvasPanel` / `Terminal` 等）与相关 store（`canvasStore` → `src/canvas/artifact-registry.ts`）。
- **不参与**工作台抽象、保持独立的：`SplitPane` 树（终端分屏，`stores/split-pane-tree.ts`）、后端 Agent mode、`tab.type` 的后端语义。

## 尚未做（刻意留白）

- 区域部件（panel）词汇为宿主内置，**不做可扩展/插件化**——按需再说。
- 声明式 `regions` 尚未由通用壳自动渲染（内置工作台都走 renderer / 手动组合 WorkbenchShell）；待出现「纯声明即可」的工作台时再实现。
- 区域显隐 / 尺寸状态仍分散（终端在 TerminalTabView 局部 ref，助手在 canvasStore）。后续可归一到 workbench store，届时终端命令式 API 可退化为 store action。
