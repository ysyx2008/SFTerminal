# 用户命令规则

## 职责

允许用户给命令指定默认风险档，供审计与内置规则合并查找。

## 设计目标

- **可以加严，不能放松**：还不认识的命令可以设安全 / 中危 / 危险 / 硬拒。已经认识的命令只能升成硬拒，不能改成更松的档，也关不掉内置硬墙。
- **秘书改不了**：这份名单在应用数据里，秘书读不了、也改不了；确认时「允许并记住」只能记成中危，不能写成硬拒或改掉硬拒。

## 约束

- 未收录命令：可设 `safe` / `moderate` / `dangerous` / `blocked`
- 内置命令：只允许升成 `blocked`；其它档仍拒绝
- 查找：用户把某条标成硬拒时，硬拒优先；否则仍用内置，没有内置再看用户规则
- Agent 不可读写 `{userData}/agent-command-rules.json`（userData 禁区）

## 查找顺序

`getArgvCommandRule`：用户硬拒覆盖 → 内置 → 其它用户规则 → 未知（Fail-Closed）

## 存储

- 路径：`{userData}/agent-command-rules.json`
- 格式：`{ version: 1, rules: UserCommandRuleRecord[] }`

## IPC

- `commandRules:list` / `commandRules:upsert` / `commandRules:remove` / `commandRules:clear`
- `upsert` 错误码：`empty_cmd` / `builtin_conflict` / `invalid_level` / `fixed_path_mode_unsupported`
- 内置命令写非 `blocked` → `builtin_conflict`
- v1 `pathMode` 仅 `all` | `none`（不支持 `fixed`，缺 `pathArgIndices`）

## 确认弹窗快捷入口

对**解析成功、恰好一条未知子命令、非 blocked** 的命令确认，后端附带 `PendingConfirmation.trustCommandOffer`：

- 前端展示「加入规则并允许」→ 二次确认 → `commandRules.upsert`（固定 `baseLevel=moderate`，`writesTo` 来自审计推断）→ 再 `agent.confirm(approved)`
- 不覆盖内置；复合命令 / 间接执行 / 已有规则（非 unknown）不出现
- 判定：`trust-command-offer.ts` 的 `resolveTrustCommandOffer`

## 模块

| 文件 | 说明 |
|---|---|
| `user-command-rules.ts` | 持久化 + CRUD + sync lookup |
| `resolve-argv-rule.ts` | 合并查找入口 |
| `trust-command-offer.ts` | 确认弹窗「加入规则」资格 |
