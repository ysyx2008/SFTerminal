# 用户授权清单（allowlist）

## 职责

持久化用户通过「始终允许」批准的**命令类**工具操作，全局共享、跨重启生效。Agent 无法读写 `{userData}/agent-allowlist.json`（由 `command-audit/userdata-guard` 硬 block）。

## 模块

| 文件 | 说明 |
|---|---|
| `user-allowlist.ts` | 持久化存储、命中检查、重新评估 |
| `key.ts` | 白名单键生成（与 `ToolMeta.idempotencyKey` 一致） |
| `check-persisted.ts` | 命令工具命中封装 |
| `resolve-command-confirm.ts` | exec / execute_command 确认流程 |

## 存储

- 路径：`{userData}/agent-allowlist.json`
- 格式：`{ version: 1, entries: AllowlistEntry[] }`

## 重新评估

命中持久化条目时调用 `reassess()` 比较当前风险与 `riskLevelAtApproval`：

- 当前 = `blocked` → 拒绝并删除条目
- 当前 > 旧 → 重新弹确认
- 否则 → 跳过确认

## 持久化范围

仅 `ToolMeta.persistAllowlist === true` 的工具（`exec` / `execute_command`）。路径类工具仍用 Agent 实例内存 `Set`，关 tab 清。

## IPC（仅用户/UI）

- `allowlist:list` / `allowlist:remove` / `allowlist:clear`

## 依赖

- `command-audit/confirm-policy` — 确认策略
- `tools.ts` — `ToolMeta.persistAllowlist`
- `userdata-guard` — 保护清单文件本身
