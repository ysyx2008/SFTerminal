# CLI（无头模式）

> Last verified: 2026-07-13

## 职责

提供无头 Agent / 运维命令入口。开发态与打包态共用命令面（`runCli`）。

## 入口

| 入口 | 场景 |
|------|------|
| `electron/cli/main.js` | 开发：`npm run sailfish`（`sft`/`cli` 为别名；tsx + electron-shim） |
| `electron/cli/cli.ts` → `dist-electron/cli.js` | 打包：`ELECTRON_RUN_AS_NODE=1 SailFish.app/.../SailFish cli.js` |
| `~/.local/bin/sailfish` | 薄壳（设置页安装或 `npm run install:cli`） |

## 数据

- **默认**：与桌面共用 userData
- **`--sandbox`**：`{userData}/cli-sandbox` + 借用 AI Profiles / credentials
- Agent 默认 **`--mode relaxed`**；`--free` 跳过确认
- 命令结束后 **`process.exit(0)`**（`main.js` / `cli.ts`）；`agent:run` 另调 `AiService.dispose()` 关掉 keep-alive，避免空转十几秒才退出

## 命令面（摘要）

- `sailfish "任务"` / `--task` / `agent:run` → Agent
- `models` / `history list` / `watch list` / …
- 冒号内部命令仍可用
- 对外命令名：`SFT_CLI_NAME`（默认 / 薄壳均为 `sailfish`）

装机薄壳见 `electron/services/SHELL_CLI_SPEC.md`。
