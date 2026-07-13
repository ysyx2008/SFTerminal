# OEM / 业务工作台开发指南（薄操作手册）

> 读者：要在 Fork 或同仓里**加一个岗位工作台**的同学  
> 产品心智见 [`oem-vision.md`](./oem-vision.md)；工程长文见 [`workbench-monorepo-design.md`](./workbench-monorepo-design.md)  
> 原则：**同款对话壳 + 岗位只改装配**；不要重造 Agent，不要搬 AiPanel 实现

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
import type { TerminalTab } from '@/stores/terminal'
import { AiPanel } from '@sailfish/workbench-sdk/ai-panel'

defineProps<{ tab: TerminalTab; isActive: boolean }>()
</script>

<template>
  <div class="wb">
    <AiPanel :tab-id="tab.id" :tab-active="isActive" />
  </div>
</template>
```

对话必须从 **`@sailfish/workbench-sdk/ai-panel`** 引入（与 local/ssh/assistant/companion 一致）。

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
- [ ] 对话只从 `@sailfish/workbench-sdk/ai-panel` 引入  
- [ ] `createAssistantTab({ workbenchKind })` 能打开且 prompt 符合预期  
- [ ] 需要的 MCP `enabled: true` 且启动日志无 connect 失败（或可接受失败）  
- [ ] 未改 Agent 内核 / AiPanel.vue 本体  

---

## 延伸阅读

- 包一览：[`packages/README.md`](../packages/README.md)  
- 样例源码：`packages/workbench-sample/`  
- SDK API：`packages/workbench-sdk/src/index.ts`、`./ai-panel`  
- OEM 产品说明：[`oem-vision.md`](./oem-vision.md)
