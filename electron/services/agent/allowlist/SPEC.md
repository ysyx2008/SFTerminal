# 工具确认白名单（allowlist）

## 职责

为「本次允许」提供**键生成**与命令类工具的**确认编排**。批准结果只存在 Agent 实例内存 `allowedTools`（跨 Run；关 tab / 进程重启清空），**不落盘**。

> 若要给命令名定风险等级（如收录 `rg`），请用 `command-audit/user-command-rules`，不是本模块。

## 模块

| 文件 | 说明 |
|---|---|
| `key.ts` | 白名单键生成（与 `ToolMeta.idempotencyKey` 一致；exec ↔ execute_command 互认） |
| `resolve-command-confirm.ts` | exec / execute_command 是否需确认 + 调 `waitForConfirmation` |

公开导出：`buildAllowlistKey` / `buildAllowlistKeyCandidates` / `resolveCommandToolConfirmation`。

## 会话内存命中

- 写入 / 查询均用 `buildAllowlistKeyCandidates`（shell 工具同时覆盖 `exec` 与 `execute_command`）
- 路径类等工具同样走 Agent `allowedTools`，无跨重启持久化

## IPC

- `allowlist:getBuiltInRules` — 设置页「命令规则」只读视图（实现见 `command-audit/built-in-rules-view`）

## 依赖

- `command-audit/confirm-policy` — 确认策略
- `Agent.allowedTools` — 会话内存白名单
