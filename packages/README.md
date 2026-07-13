# Packages（OEM / Workbench Monorepo）

> **状态（2026-07-13）**：npm workspaces ✅（W5：暂不切 pnpm）；内置工作台包已真抽。  
> 完整 TODO：[`docs/workbench-monorepo-design.md` §6.0](../docs/workbench-monorepo-design.md)。

## 当前事实

| 包名 | 状态 |
|---|---|
| `@sailfish/shared-types` | ✅ 真相源在 `packages/shared-types/src/` |
| `@sailfish/workbench-assistant` | ✅ descriptor / prompt / agent-tools / Vue；AiPanel+artifact 仍 `@/` |
| `@sailfish/workbench-local` / `ssh` | ✅ descriptor / prompt；`TerminalTabView` 仍 desktop（Teleport） |
| `@sailfish/workbench-companion` | ✅ descriptor / prompt / CompanionWorkbench；AiPanel 仍 `@/` |
| `@sailfish/workbench-sample` | ✅ 业务台样例 + bootstrap 单测 |
| `@sailfish/workbench-sdk` | ⚠️ 仍 re-export → `src/workbench`（types/registry 未迁） |

## 导入约定

```ts
import type { TerminalType } from '@sailfish/shared-types'
import { descriptor } from '@sailfish/workbench-local/descriptor'
import { LOCAL_WORKBENCH_AGENT_PROMPT } from '@sailfish/workbench-local/prompt'
```

兼容：`@shared/types`、`@/workbench/<kind>/prompt` 薄 re-export 仍可用。
