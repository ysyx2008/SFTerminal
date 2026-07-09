# command-audit SPEC

> 命令执行风险审计模块：评估 Agent 要执行的命令是否安全。
> 供 `exec` / `execute_command` 工具调用。

## 职责

1. **风险分级**：safe / moderate / dangerous / blocked
2. **单通道（AST）**：所有命令经 `@questi0nm4rk/shell-ast` 解析为 AST，拆出子命令 + flags + 参数 + 重定向，再走白名单 + 路径分区
3. **路径分区审计**：根据 cwd + 路径所在 zone（free/protected/workspace/outside）调整风险
4. **Fail-Closed**：解析失败 / 未知命令 / 动态路径 -> 至少 moderate；写操作动态路径 -> dangerous

## 模块结构

```
command-audit/
├── types.ts              # AuditedCall / AuditContext / CallRiskAssessment
├── whitelist.ts          # CommandRule + splitArgv + normalizeFlags + 白名单
├── indirection-guard.ts  # 间接执行守卫（命中 -> dangerous）
├── assess-call.ts        # 单条 AuditedCall 评估（guard -> 规则 -> 路径分区）
├── assess-shell.ts       # 审计入口（extractAuditedCalls -> assessAuditedCall）+ defaultAuditContext
├── extract-calls.ts      # shell AST 解析 + unwrap（bash -c 递归）
├── confirm-policy.ts     # executionMode -> 是否需确认（strict/relaxed/free）
├── workspace-guard.ts    # 路径分区 zone 计算 + 系统路径黑名单
├── risk-level.ts         # maxRisk 聚合
└── __tests__/            # 单元测试
```

## 数据流

```
   shell 命令字符串
        │
        ▼
 extractAuditedCalls (AST + unwrap bash -c 递归)
        │
        ▼
  assessAuditedCall
        │
        ▼
 ① indirection-guard   ← 命中标 dangerous（非 blocked）
        │
        ▼
 ② getArgvCommandRule  ← 白名单匹配（命名历史遗留，shell 通道也用）
        │
        ┌──────┴──────┐
        │ 无 rule     │ 有 rule
        ▼             ▼
   assessUnknownCall  assessCommandFlags -> 路径分区
        │             │
        └──────┬──────┘
               ▼
        CallRiskAssessment (level + reasons + pathZones)
               │
               ▼
        ③ 路径守卫（workspace-guard）
               │
               ┌──────┬──────┴──────┐
               │      │             │
               ▼      ▼             ▼
        userData   critical       hardened/其他
        禁区       系统路径
        (读+写)    (写)          
           │        │             │
           ▼        ▼             ▼
        blocked  blocked    dangerous/safe/...
```

## 核心不变量

### 1. 命令拦截是"安全性补充"，主防线是 executionMode

- 真正高风险场景 -> 用户切 strict（全确认）
- 日常使用 -> relaxed（危险命令确认）
- 信任 AI 自主 -> free（自担风险）

guard 把"确实危险的间接执行模式"鉴别出来标 dangerous，让 strict/relaxed 弹确认时理由清楚。**free 模式照常放行**--用户既然选了信任，不该由 guard 越俎代庖硬拦。

### 2. blocked 级别只留给路径守卫

`blocked` 表示"绝对禁止"，不受 executionMode 影响。触发条件：
- 写 **critical 系统路径**（`/`、`/boot`）--不可逆系统灾难
- 访问 **userData 禁区**（读+写都拦）--保护 `credentials.json` 等安全机制文件

写 **hardened 系统路径**（`/etc`、`/dev`、`/sys` 等）标 `dangerous`（弹确认放行），不标 `blocked`。guard 命中的间接执行模式也标 `dangerous`，不标 `blocked`。

### 3. normalizeFlags 只拆合并短 flag

`normalizeFlags` 只拆长度 ≤ 4 的短 flag 合并（`-rf` -> `-r -f` + 保留原 `-rf`），保留 `-print`/`-exec`/`-delete` 等多字母长 flag 不被误拆。`assessCommandFlags` 对未知 flag 回退检查"是否由已知单字符 flag 组合而成"（`-lart` 不误报）。

## 风险等级

| 等级 | 含义 | strict | relaxed | free |
|---|---|---|---|---|
| safe | 只读，工作区内 | 确认 | 放行 | 放行 |
| moderate | 轻度副作用或未知命令 | 确认 | 确认 | 放行 |
| dangerous | 写工作区外 / 间接执行 / 结构性 flag 命中 / 写 hardened 系统路径 | 确认 | 确认 | 放行 |
| **blocked** | 写 critical 系统路径（/ /boot）或 userData 禁区 | **拒绝** | **拒绝** | **拒绝** |

注意：blocked 是硬墙（路径守卫），dangerous 是风险标记（guard 命中 / hardened 系统路径）。

### 系统路径分级（仅对写操作生效）

| severity | 路径 | 写操作 | 说明 |
|---|---|---|---|
| critical | `/`、`/boot` | blocked | 不可逆系统灾难；整串规则已对 `rm -rf /`、`dd of=/dev/sdX` 等做兜底 |
| hardened | `/etc`、`/dev`、`/sys`、`/proc`、`/System`、`/Library`、`/root` 等 | dangerous | 有风险但可恢复，或存在合法操作（如 `dd of=/dev/sdX` 烧录） |

**黑洞设备豁免**：`/dev/null`、`/dev/stdout`、`/dev/stderr` 作为写重定向目标时直接判 safe（写它们等于丢弃或重定向输出）。命令参数中的 `/dev/null` 不受此豁免影响。

**userData 禁区**：userData 下除 `agent-workspace/`、`skills/`、`excel-styles.json`、`word-styles.json` 外的路径，读+写都 blocked（保护 `credentials.json`、`agent-allowlist.json` 等安全机制文件）。

## 依赖

- `@shared/types/agent` -- RiskLevel / ExecutionMode
- `@questi0nm4rk/shell-ast` -- shell 通道 AST 解析（含 unwrap bash -c）
- `../tools/file` -- getScratchPath / getWorkspacePath

## 测试

```bash
npx vitest run electron/services/agent/command-audit/__tests__/
```

覆盖：
- 白名单匹配（safe/moderate/dangerous）
- 路径分区（free/protected/workspace/outside/system）
- indirection-guard（解释器内联 / 包装器 / 调度器 / 结构性 flag）
- shell 通道 unwrap + 递归审计
- confirm-policy 三种模式

## 变更历史

- 2026-07-09：系统路径分级。引入 `severity: critical | hardened` 字段，`/`、`/boot` 保持 blocked（critical），`/etc`、`/dev`、`/sys` 等降为 dangerous（hardened，弹确认放行）。新增 `DEV_NULL_EXEMPTIONS` 豁免 `/dev/null`、`/dev/stdout`、`/dev/stderr`（写重定向到黑洞设备直接 safe）。修复只读命令带写重定向时命令参数被误判为写路径的 bug（`find /tmp 2>/dev/null` 不再被拦）。修复 `whitelist.ts` 重复 `env` key 警告
- 2026-07-09：收口为单通道（AST）。砍掉 argv 通道入口（`assess-argv.ts` / `exec_argv` 工具 / `spawnArgv`），`defaultAuditContext` 移至 `assess-shell.ts`。理由：shell 通道已 AST 化，审计精度与 argv 通道趋同；Agent 场景无不可信输入注入，`shell:false` 的注入面优势不成立；双工具增加 AI 选择负担且 shell 通道是 bug 温床
- 2026-07-07：新增 indirection-guard，修 node -e / python -c / env bash -c 漏洞
- 2026-07-07：guard 返回值从 blocked 调整为 dangerous（命令拦截是安全性补充，
  主防线是 executionMode；blocked 只留给路径守卫）
