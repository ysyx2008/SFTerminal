# 用户命令规则

## 职责

允许用户**追加**未收录命令的 `CommandRule`（命令名 + 基础风险 + 写盘/路径模式 + 安全 flags），供审计与内置 `ARGV_COMMAND_RULES` 合并查找。

## 约束

- **只追加**：不可覆盖 / 删除内置命令
- **不可自建 blocked**（仅 `safe` / `moderate` / `dangerous`）
- Agent 不可读写 `{userData}/agent-command-rules.json`（userData 禁区）

## 查找顺序

`getArgvCommandRule`（`resolve-argv-rule.ts`）：内置 → 用户规则 → `undefined`（未知命令 Fail-Closed）

## 存储

- 路径：`{userData}/agent-command-rules.json`
- 格式：`{ version: 1, rules: UserCommandRuleRecord[] }`

## IPC

- `commandRules:list` / `commandRules:upsert` / `commandRules:remove` / `commandRules:clear`
- `upsert` 错误码：`empty_cmd` / `builtin_conflict` / `invalid_level` / `fixed_path_mode_unsupported`
- v1 `pathMode` 仅 `all` | `none`（不支持 `fixed`，缺 `pathArgIndices`）

## 模块

| 文件 | 说明 |
|---|---|
| `user-command-rules.ts` | 持久化 + CRUD + sync lookup |
| `resolve-argv-rule.ts` | 合并查找入口 |
