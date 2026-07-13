# Packages（OEM / Workbench Monorepo）

> **状态（2026-07-13）**：npm workspaces ✅；`@sailfish/shared-types` **已物理迁入**。  
> 其余 workbench 包仍多为 re-export。完整 TODO：[`docs/workbench-monorepo-design.md` §6.0](../docs/workbench-monorepo-design.md)。

## 当前事实

| 包名 | 状态 |
|---|---|
| `@sailfish/shared-types` | ✅ 真相源在 `packages/shared-types/src/`；`shared/types/*` 兼容 re-export |
| `@sailfish/workbench-sdk` 等 | ⚠️ 仍 re-export → `src/workbench`（W3+） |

## 导入约定

优先：

```ts
import type { McpServerConfig, TerminalType } from '@sailfish/shared-types'
```

兼容（仍可用）：

```ts
import type { TerminalType } from '@shared/types'
import type { RiskLevel } from '@shared/types/agent'
```
