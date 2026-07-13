# Packages（OEM / Workbench Monorepo）

> **状态（2026-07-13）**：npm workspaces；内置台真抽；**SDK 真核 + AiPanel 正式出口（W7a）**。  
> 完整 TODO：[`docs/workbench-monorepo-design.md` §6.0](../docs/workbench-monorepo-design.md)。

## 当前事实

| 包名 | 状态 |
|---|---|
| `@sailfish/shared-types` | ✅ |
| `@sailfish/workbench-sdk` | ✅ types / registry / prompt / bootstrap；`./ai-panel` 正式出口（实现仍在 desktop） |
| `@sailfish/workbench-*` | ✅ 内置台 + sample；对话经 SDK `ai-panel` |

## 岗位台怎么用同款对话

```ts
import { AiPanel } from '@sailfish/workbench-sdk/ai-panel'
import type { WorkbenchDescriptor } from '@sailfish/workbench-sdk'

export const descriptor: WorkbenchDescriptor = {
  kind: 'my-job',
  renderer: MyWorkbench, // 模板里嵌 <AiPanel :tab-id="tab.id" :tab-active="isActive" />
  agentPrompt: '...岗位说明与工具用法...',
  skills: ['excel'],
  mcpServers: [/* ... */],
}
```

岗位差异只改 descriptor；外观用同款 AiPanel。P2 余量：把 AiPanel 实现迁进 SDK 并去掉对 desktop store 的硬依赖。
