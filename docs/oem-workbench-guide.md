# OEM / 业务工作台开发指南（薄操作手册）

> 读者：要在 Fork 或同仓里**加一个岗位工作台**的同学  
> 产品心智见 [`oem-vision.md`](./oem-vision.md)；工程长文见 [`workbench-monorepo-design.md`](./workbench-monorepo-design.md)  
> 原则：**同款对话壳 + 岗位只改装配**；不要重造 Agent，不要搬 AiPanel 实现

---

## 复用规则：只经 SDK

`packages/workbench-*` **禁止**直引桌面实现：

- ❌ `import … from '@/components/…'`
- ❌ `import … from '@/stores/…'`（类型也不要）
- ❌ 互相 `import` 其它业务岗包

需要复用的 UI / 类型，**只**从 `@sailfish/workbench-sdk`（及子路径）拿。实现可以仍在 `src/`，但门牌必须在 SDK。缺门牌 → 先给 SDK 加一层薄壳 re-export，再引用。

### 允许列表（当前）

| 用途 | 从哪引进 |
|---|---|
| 类型 / 注册 / prompt / bootstrap | `@sailfish/workbench-sdk` |
| 同款对话 | `@sailfish/workbench-sdk/ai-panel` |
| 终端 Tab 壳（local/ssh 共用） | `@sailfish/workbench-sdk/terminal-tab-view` |
| 锚点 + 可隐区布局 | `@sailfish/workbench-sdk/workbench-shell` |
| 桌面通知 | `@sailfish/workbench-sdk/toast` |
| Markdown 渲染 | `@sailfish/workbench-sdk/markdown` |
| 上述汇总 | `@sailfish/workbench-sdk/platform` |
| 共享协议类型 | `@sailfish/shared-types` |

渲染器 props 用 SDK 的 `WorkbenchRendererProps`，不要用 `@/stores/terminal` 的 `TerminalTab`。

### 平台专属例外（内置岗，业务岗不要抄）

仅 **`workbench-assistant`** 带产出物（`@sailfish/workbench-assistant/artifact`）。与 desktop 经 `ArtifactDesktopHost` 契约交互（不直引 terminalStore）；toast / markdown 走 SDK。仍 `@/` 的仅 HoverTip / composerQuote（过渡）。业务岗抄 sample，**不要**依赖 artifact。

### 视觉：CSS token 名契约（值在 desktop 主题）

岗包**不要**硬编码 hex / 自造一套色名。统一视觉靠 **CSS 变量名**；具体色值由 desktop 主题（`src/styles/main.css` + `src/themes/ui-themes.ts`）注入。

岗包样式里写：

```css
background: var(--bg-surface);
color: var(--text-primary);
border: 1px solid var(--border-color);
```

#### 推荐使用的 token 名（岗包常用）

| 层 | 变量名 |
|---|---|
| 结构背景 | `--bg-primary` / `--bg-secondary` / `--bg-tertiary` / `--bg-surface` / `--bg-hover` |
| 文字 | `--text-primary` / `--text-secondary` / `--text-muted` |
| 边框 / 圆角 | `--border-color` / `--border-radius` |
| 强调 | `--accent-primary` / `--accent-secondary` / `--accent-contrast` |
| 语义反馈 | `--color-success` / `--color-warning` / `--color-error` / `--color-info`（半透明用配套 `*-rgb`） |
| 字体 | `--font-family` / `--font-mono` |

对话区用户气泡等专用 token（`--chat-user-bubble-*`）一般只在 AiPanel 内用，业务岗不必碰。

完整分层说明与主题维护约定见 `src/styles/main.css` 文件头。缺某个语义时：**先在 desktop 主题补变量**，再在岗包引用，不要在岗包里写死颜色。

---

## 你能改什么

| 改什么 | 怎么改 |
|---|---|
| **换皮** | 编辑 `shared/oem.config.ts` 的 `brand`（从 `oem.config.template.ts` 复制而来） |
| **换能力集** | 同一文件的 `features`（关觉醒/SSH/助手等） |
| **换岗 / 加岗** | 新建 `packages/workbench-<你的岗>/`，声明 descriptor，注册进桌面 |

不要改：`electron/services/agent/` 内核、`src/components/AiPanel.vue` 实现、独立 npm 发版流程。

---

## 最小岗：抄 sample

参考包：`packages/workbench-sample/`。

岗位差异几乎只在 descriptor 三件套：

```ts
import type { WorkbenchDescriptor } from '@sailfish/workbench-sdk'
import { AiPanel } from '@sailfish/workbench-sdk/ai-panel' // 在 .vue 里用

export const descriptor: WorkbenchDescriptor = {
  kind: 'finance',                    // 自定，勿与内置冲突
  renderer: FinanceWorkbench,         // 下面模板组件
  availableInSteam: false,
  agentPrompt: `...岗位说明 + 工具用法...`,  // → system prompt 的 workbench 章节
  skills: ['excel'],                  // 声明依赖的核心 skill id
  mcpServers: [/* 见下 */],
}
```

### 界面模板（同款对话，不定制外观）

```vue
<script setup lang="ts">
import type { WorkbenchRendererProps } from '@sailfish/workbench-sdk'
import { AiPanel } from '@sailfish/workbench-sdk/ai-panel'

defineProps<WorkbenchRendererProps>()
</script>

<template>
  <div class="wb">
    <AiPanel :tab-id="tab.id" :tab-active="isActive" />
  </div>
</template>
```

### MCP

```ts
import type { McpServerConfig } from '@sailfish/shared-types'

const mcp: McpServerConfig = {
  id: 'my-erp',
  name: 'ERP',
  enabled: true,              // false 则 bootstrap 跳过
  transport: 'stdio',         // 或 'http' / 'sse'
  command: 'npx',
  args: ['-y', 'my-mcp-server'],
}
```

启动时 `bootstrapWorkbenchCapabilities()` 会遍历已注册 descriptor 并 `connect`（`enabled: true` 的项）。

### Skills

- `skills: string[]`：声明依赖；当前以装配日志/校验为主，内置 skill 仍由 Agent 侧注册。  
- 包内自带 skill：按项目惯例 side-effect `registerSkill`（见 agent skills 目录），并在 descriptor 里写上 id。

---

## 注册进桌面

1. 根 `package.json` 的 `dependencies` 增加 `"@sailfish/workbench-finance": "*"`（包名自定）。  
2. `npm install`（workspaces 会链上）。  
3. 在 `src/workbench/registry.ts` 增加：

```ts
import { descriptor as financeDescriptor } from '@sailfish/workbench-finance/descriptor'
// …
registerWorkbench(financeDescriptor)
```

4. （可选）若该岗要受 `features` 开关控制，在同文件 `KIND_FEATURE` 里挂上对应 `OemFeatureKey`（或先不加，注册即可用）。

`tsconfig` / `vite` 对 `@sailfish/*` 已有 alias 模式；新包按现有 `workbench-sample` 抄 `package.json` + `exports` 即可。

---

## 怎么打开这个岗

`tab.type` 仍用 `'assistant'`（共享助手会话形态），用 **`workbenchKind`** 区分外观/装配：

```ts
terminalStore.createAssistantTab({
  title: '金融分析',
  workbenchKind: 'finance',  // = descriptor.kind
  isPromoted: true,
  activate: true,
})
```

`resolveWorkbenchKind(tab)` 会优先读 `tab.workbenchKind`，再渲染对应 `renderer`、注入该岗的 `agentPrompt`。

入口按钮：在 Welcome / 菜单里自己加一行调用即可；**sample 默认不进 Welcome**，避免干扰开源日常 UI。

---

## 内置岗 vs 业务岗

| | 说明 |
|---|---|
| **内置正式岗** | `local` / `ssh` / `assistant` / `companion` — 产品自带，已在用 |
| **业务 / OEM 岗** | 抄 sample 新建包；差异在 descriptor |

---

## 自检清单

- [ ] 包在 `packages/workbench-*`，且已写入根 `package.json` workspaces 依赖  
- [ ] `registry.ts` 已 `registerWorkbench`  
- [ ] **复用只经 SDK**（无 `@/components`、无 `@/stores`；对话用 `…/ai-panel`；通知用 `…/toast`；正文渲染用 `…/markdown`）  
- [ ] 样式只用上文「CSS token 名」表中的变量，无硬编码色值  
- [ ] props 用 `WorkbenchRendererProps`  
- [ ] `createAssistantTab({ workbenchKind })` 能打开且 prompt 符合预期  
- [ ] 需要的 MCP `enabled: true` 且启动日志无 connect 失败（或可接受失败）  
- [ ] 未改 Agent 内核 / AiPanel.vue 本体  

---

## 延伸阅读

- 包一览：[`packages/README.md`](../packages/README.md)  
- 样例源码：`packages/workbench-sample/`  
- SDK 门牌：`packages/workbench-sdk/src/platform.ts`、`./ai-panel` 等  
- OEM 产品说明：[`oem-vision.md`](./oem-vision.md)
