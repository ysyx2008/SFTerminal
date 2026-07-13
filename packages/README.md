# Packages（OEM / Workbench Monorepo）

> **状态（2026-07-13）**：npm workspaces；内置台真抽；**SDK 真核 + 平台壳薄壳出口**；**岗包复用只经 SDK**。  
> **加岗请先读**：[`docs/oem-workbench-guide.md`](../docs/oem-workbench-guide.md)（含允许列表）。  
> 工程进度：[`docs/workbench-monorepo-design.md` §6.0](../docs/workbench-monorepo-design.md)。

## 当前事实

| 包名 | 状态 |
|---|---|
| `@sailfish/shared-types` | ✅ |
| `@sailfish/workbench-sdk` | ✅ types / registry / prompt / bootstrap；壳出口见下 |
| `@sailfish/workbench-*` | ✅ 内置台 + sample；**禁止直引 `@/components`**；assistant 含 artifact 子系统 |

## 复用只经 SDK

```ts
import type { WorkbenchDescriptor, WorkbenchRendererProps } from '@sailfish/workbench-sdk'
import { AiPanel } from '@sailfish/workbench-sdk/ai-panel'
import { useToast } from '@sailfish/workbench-sdk/toast'
import { useMarkdown } from '@sailfish/workbench-sdk/markdown'
import { TerminalTabView } from '@sailfish/workbench-sdk/terminal-tab-view'
import { WorkbenchShell } from '@sailfish/workbench-sdk/workbench-shell'
// 或汇总：import { AiPanel, TerminalTabView, WorkbenchShell, useToast, useMarkdown } from '@sailfish/workbench-sdk/platform'
```

岗位差异只改 descriptor（`agentPrompt` / `skills` / `mcpServers`）。  
**不做** AiPanel 实现迁入 SDK / 独立编译发版；缺门牌先加薄壳。
