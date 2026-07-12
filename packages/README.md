# Packages（OEM / Workbench Monorepo 骨架）

本目录为工作台与共享类型的 **npm 包骨架**。当前阶段：

- 源码仍主要在仓库根 `shared/`、`src/workbench/`
- 各包通过 re-export 暴露 `@sailfish/*` 名称，便于 OEM Fork / 未来物理抽包
- **尚未**强制启用 npm/pnpm workspaces（避免打断现有 `npm install`）；alias 见根 `tsconfig` / `vite.config`

| 包名 | 状态 |
|---|---|
| `@sailfish/shared-types` | 骨架，re-export `shared/types`（含 `McpServerConfig`） |
| `@sailfish/workbench-sdk` | 骨架，re-export `src/workbench` 核心 API |
| `@sailfish/workbench-assistant` | 骨架 |
| `@sailfish/workbench-local` | 骨架 |
| `@sailfish/workbench-ssh` | 骨架 |
| `@sailfish/workbench-companion` | 骨架 |

完整抽包与 workspace 启用见 `docs/workbench-monorepo-design.md`。
