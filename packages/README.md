# Packages（OEM / Workbench Monorepo）

> **状态（2026-07-13）**：npm workspaces；内置台真抽；**SDK 真核 + AiPanel 正式出口（W7a）**。  
> **加岗请先读**：[`docs/oem-workbench-guide.md`](../docs/oem-workbench-guide.md)。  
> 工程进度：[`docs/workbench-monorepo-design.md` §6.0](../docs/workbench-monorepo-design.md)。

## 当前事实

| 包名 | 状态 |
|---|---|
| `@sailfish/shared-types` | ✅ |
| `@sailfish/workbench-sdk` | ✅ types / registry / prompt / bootstrap；`./ai-panel` 正式出口（实现仍在 desktop） |
| `@sailfish/workbench-*` | ✅ 内置台 + sample；对话经 SDK `ai-panel` |

## 岗位台怎么用同款对话

见操作手册；摘要：

```ts
import { AiPanel } from '@sailfish/workbench-sdk/ai-panel'
import type { WorkbenchDescriptor } from '@sailfish/workbench-sdk'
```

岗位差异只改 descriptor（`agentPrompt` / `skills` / `mcpServers`）。
**不做** AiPanel 实现迁入 SDK / 独立编译发版。
