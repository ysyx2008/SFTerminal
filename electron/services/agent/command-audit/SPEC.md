# command-audit SPEC

> 命令执行风险审计模块：评估 Agent 要执行的命令是否安全。
> 供 `exec_argv` / `exec` / `execute_command` 工具调用。

## 职责

1. **风险分级**：safe / moderate / dangerous / blocked
2. **双通道共用**：argv 通道（`spawn(cmd, args, { shell: false })`）和 shell 通道（shell 字符串经 AST 解析）
3. **路径分区审计**：根据 cwd + 路径所在 zone（free/protected/workspace/outside）调整风险
4. **Fail-Closed**：解析失败 / 未知命令 / 动态路径 → 至少 moderate；写操作动态路径 → dangerous

## 模块结构

```
command-audit/
├── types.ts              # AuditedCall / AuditContext / CallRiskAssessment
├── whitelist.ts          # argv 白名单 + CommandRule + splitArgv + normalizeFlags
├── indirection-guard.ts  # 间接执行守卫（通道无关，命中 → blocked）
├── assess-call.ts        # 单条 AuditedCall 评估（guard → 规则 → 路径分区）
├── assess-argv.ts        # argv 通道入口（buildAuditedCall → assessAuditedCall）
├── assess-shell.ts       # shell 通道入口（extractAuditedCalls → assessAuditedCall）
├── extract-calls.ts      # shell AST 解析 + unwrap（bash -c 递归）
├── confirm-policy.ts     # executionMode → 是否需确认（strict/relaxed/free）
├── workspace-guard.ts    # 路径分区 zone 计算 + 系统路径黑名单
├── risk-level.ts         # maxRisk 聚合
└── __tests__/            # 单元测试
```

## 数据流

```
argv 通道                          shell 通道
   │                                  │
   ▼                                  ▼
buildAuditedCall               extractAuditedCalls (AST + unwrap)
   │                                  │
   └──────────┬───────────────────────┘
              ▼
       assessAuditedCall
              │
              ▼
       ① indirection-guard   ← 通道无关，命中标 dangerous（非 blocked）
              │
              ▼
       ② getArgvCommandRule  ← 白名单匹配
              │
       ┌──────┴──────┐
       │ 无 rule     │ 有 rule
       ▼             ▼
   assessUnknownCall  assessCommandFlags → 路径分区
       │             │
       └──────┬──────┘
              ▼
       CallRiskAssessment (level + reasons + pathZones)
              │
              ▼
       ③ 路径守卫（workspace-guard）
              │
       ┌──────┴──────┐
       │ 写系统路径   │ 其他
       ▼             ▼
   blocked        dangerous/safe/...
```

## 核心不变量

### 1. 命令拦截是"安全性补充"，主防线是 executionMode

- 真正高风险场景 → 用户切 strict（全确认）
- 日常使用 → relaxed（危险命令确认）
- 信任 AI 自主 → free（自担风险）

guard 把"确实危险的间接执行模式"鉴别出来标 dangerous，让 strict/relaxed 弹确认时理由清楚。**free 模式照常放行**——用户既然选了信任，不该由 guard 越俎代庖硬拦。

### 2. blocked 级别只留给路径守卫

`blocked` 表示"绝对禁止"（写 `/etc`、`/`、`/System` 等系统路径），不受 executionMode 影响。guard 命中的间接执行模式标 `dangerous`，不标 `blocked`——这是风险等级，不是硬墙。

### 3. exec_argv 通道偏好 Direct 命令

`cmd` 应该是最终干活的程序。凡是通过 shell wrapper、解释器内联代码、包装器、调度器转手执行的，由 indirection-guard 标记为 dangerous。但这是建议性约束，不强制 blocked。

### 4. normalizeFlags 只拆合并短 flag

`normalizeFlags` 只拆长度 ≤ 4 的短 flag 合并（`-rf` → `-r -f` + 保留原 `-rf`），保留 `-print`/`-exec`/`-delete` 等多字母长 flag 不被误拆。`assessCommandFlags` 对未知 flag 回退检查"是否由已知单字符 flag 组合而成"（`-lart` 不误报）。

### 5. argv 通道对未知命令也拆 flags

`buildAuditedCall` 在 rule 不存在时用 fallback rule 拆 flags，确保 indirection-guard 能拿到 `-c`/`-e`/`-exec` 等 flag。

## 风险等级

| 等级 | 含义 | strict | relaxed | free |
|---|---|---|---|---|
| safe | 只读，工作区内 | 确认 | 放行 | 放行 |
| moderate | 轻度副作用或未知命令 | 确认 | 确认 | 放行 |
| dangerous | 写工作区外 / 间接执行 / 结构性 flag 命中 | 确认 | 确认 | 放行 |
| **blocked** | 写系统路径（/etc / / /System 等） | **拒绝** | **拒绝** | **拒绝** |

注意：blocked 是硬墙（路径守卫），dangerous 是风险标记（guard 命中）。

## 依赖

- `@shared/types/agent` —— RiskLevel / ExecutionMode
- `@questi0nm4rk/shell-ast` —— shell 通道 AST 解析（含 unwrap bash -c）
- `../tools/file` —— getScratchPath / getWorkspacePath

## 测试

```bash
npx vitest run electron/services/agent/command-audit/__tests__/
```

覆盖：
- argv 白名单（safe/moderate/dangerous）
- 路径分区（free/protected/workspace/outside/system）
- indirection-guard（解释器内联 / 包装器 / 调度器 / 结构性 flag）
- shell 通道 unwrap + 递归审计
- confirm-policy 三种模式

## 变更历史

- 2026-07-07：新增 indirection-guard，修 node -e / python -c / env bash -c 漏洞
- 2026-07-07：guard 返回值从 blocked 调整为 dangerous（命令拦截是安全性补充，
  主防线是 executionMode；blocked 只留给路径守卫）
