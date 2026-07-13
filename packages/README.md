# Packages（OEM / Workbench Monorepo）

> **状态（2026-07-13）**：根仓库已启用 **npm workspaces**（`packages/*` → `node_modules/@sailfish/*`）。  
> 包内容仍多为 **re-export 骨架**；物理抽包见 [`docs/workbench-monorepo-design.md` §6.0](../docs/workbench-monorepo-design.md) W2+。

## 当前事实

- 源码真相仍在仓库根：`shared/types/`、`src/workbench/`（re-export 指过去）
- `npm install` 会把 `@sailfish/*` 链进 `node_modules`（workspace）
- 设计目标仍是 pnpm；当前用 npm workspaces 过渡（W1 ✅ / W5 待评估）

## 包清单

| 包名 | 状态 | 下一步 |
|---|---|---|
| `@sailfish/shared-types` | ⚠️ re-export → `shared/types` | P-1 物理迁入（W2） |
| `@sailfish/workbench-sdk` | ⚠️ re-export → `src/workbench` | P1 真抽（W6） |
| `@sailfish/workbench-assistant` | ⚠️ re-export | P0 真抽（W3） |
| `@sailfish/workbench-local` | ⚠️ re-export | P1 |
| `@sailfish/workbench-ssh` | ⚠️ re-export | P1 |
| `@sailfish/workbench-companion` | ⚠️ re-export | P1 |

## 使用

```ts
import type { McpServerConfig } from '@sailfish/shared-types'
```

解析顺序：workspace 链接 + 仍保留的 tsconfig/vite alias（兼容过渡）。
