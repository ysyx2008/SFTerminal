# Packages（OEM / Workbench Monorepo）

> **状态（2026-07-13）**：目录与包名已立，**多数仍是 re-export 骨架**；根仓库 **尚未**启用 npm/pnpm workspaces。  
> 完整阶段与勾选 TODO：[`docs/workbench-monorepo-design.md` §6.0](../docs/workbench-monorepo-design.md)。

## 当前事实

- 源码真相仍在仓库根：`shared/types/`、`src/workbench/`
- `@sailfish/*` 通过 **tsconfig / vite alias** 解析到本目录；`npm install` **不会**自动链接这些包
- 设计目标是 pnpm workspace + 物理抽包；近期可先做 **npm workspaces（W1）** 再考虑切 pnpm（W5）

## 包清单

| 包名 | 状态 | 下一步 |
|---|---|---|
| `@sailfish/shared-types` | ⚠️ re-export → `shared/types` | P-1 物理迁入（W2） |
| `@sailfish/workbench-sdk` | ⚠️ re-export → `src/workbench` | P1 真抽（W6） |
| `@sailfish/workbench-assistant` | ⚠️ re-export | P0 真抽（W3） |
| `@sailfish/workbench-local` | ⚠️ re-export | P1 |
| `@sailfish/workbench-ssh` | ⚠️ re-export | P1 |
| `@sailfish/workbench-companion` | ⚠️ re-export | P1 |

## 本地如何「假装」在用这些包

```ts
import type { McpServerConfig } from '@sailfish/shared-types'
// 实际由 paths 指到 packages/shared-types → 再 export shared/types
```

启用 workspaces 并写入根 `dependencies` 之后，才应改为真正的 workspace 依赖解析。
