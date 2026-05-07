# Terminal State Service SPEC

> Last verified: 2026-05-07

## 职责

终端状态追踪层。监控所有终端会话（本地 PTY / 远程 SSH）的工作目录、空闲状态、命令执行历史，向上层 Agent 暴露"当前在哪、在干什么"的上下文信息。命令执行事件采用全局回调（一次注册，所有会话共享）。

## 文件 / 规模

单文件：`electron/services/terminal-state.service.ts`（~662 行）

## 公开 API（23 个 public 方法）

### 注入 / 生命周期

| 方法签名 | 用途 |
|---------|------|
| `setPtyService(ptyService: PtyService): void` | 注入 PTY 依赖 |
| `setSshService(sshService: SshService): void` | 注入 SSH 依赖 |
| `initTerminal(id: string, type: "local" \| "ssh", initialCwd?: string): void` | 初始化会话状态追踪 |
| `removeTerminal(id: string): void` | 移除会话状态 |

### 状态查询

| 方法签名 | 用途 |
|---------|------|
| `getState(id: string): TerminalState \| undefined` | 获取完整状态 |
| `getCwd(id: string): string` | 获取 CWD（未追踪时返回 home，**不是** `undefined`） |
| `getAllStates(): Map<string, TerminalState>` | 获取所有终端状态 |

### 输入分析与 CWD 追踪

| 方法签名 | 用途 |
|---------|------|
| `analyzeInput(id, input: string): {mayChangeCwd, targetPath?}` | 分析输入是否可能变更目录（**返回判断结果**，非 void） |
| `handleInput(id, input: string): void` | 处理输入流（终端按键回调挂这里） |
| `async refreshCwd(id, trigger?: "command" \| "pwd_check" \| "initial"): Promise<string>` | 主动刷新 CWD |
| `updateCwd(id, newCwd: string, trigger?: "command" \| "pwd_check" \| "initial"): void` | 直接更新 CWD（同步 void，**不是** Promise） |

### 状态更新

| 方法签名 | 用途 |
|---------|------|
| `updateIdleState(id, isIdle: boolean): void` | 更新空闲状态 |
| `updateLastExitCode(id, exitCode: number): void` | 记录最近命令退出码 |

### 命令执行追踪

| 方法签名 | 用途 |
|---------|------|
| `startCommandExecution(id, command, options?: {source?, agentStepId?}): CommandExecution \| null` | 标记命令开始（返回 execution 对象） |
| `appendCommandOutput(id, output: string): void` | 追加输出 |
| `completeCommandExecution(id, exitCode?, status?: "completed"\|"failed"\|"timeout"\|"aborted", error?): CommandExecution \| null` | 标记命令完成 |
| `getCurrentExecution(id): CommandExecution \| undefined` | 获取当前执行中命令 |
| `getExecutionHistory(id, limit?): CommandExecution[]` | 获取执行历史 |
| `getLastExecution(id): CommandExecution \| undefined` | 获取最近一次执行 |
| `clearExecutionHistory(id): void` | 清空执行历史 |

### 事件订阅（全局回调，**不带** sessionId 参数）

| 方法签名 | 用途 |
|---------|------|
| `onCwdChange(callback: (event: CwdChangeEvent) => void): () => void` | 全局监听所有终端的 CWD 变化 |
| `onCommandExecution(callback: (event: CommandExecutionEvent) => void): () => void` | 全局监听所有终端的命令事件 |

### 工具函数

| 方法签名 | 用途 |
|---------|------|
| `resolveCwdPath(currentCwd: string, targetPath: string): string \| null` | 给定当前目录解析相对路径（**纯函数**，签名不含 sessionId） |

## 核心类型 / 接口

```ts
interface TerminalState {
  cwd: string; type: "local" | "ssh"; shell?: string
  isIdle?: boolean; lastExitCode?: number
}

interface CwdChangeEvent {
  sessionId: string; oldCwd: string; newCwd: string
  trigger: "command" | "pwd_check" | "initial"
}

interface CommandExecution {
  id: string; sessionId: string
  command: string; source: "user" | "agent"
  agentStepId?: string
  startTime: number; endTime?: number
  exitCode?: number
  status: "running" | "completed" | "failed" | "timeout" | "aborted"
  output?: string; error?: string
}

interface CommandExecutionEvent {
  type: "started" | "completed"
  execution: CommandExecution
}
```

## 依赖（跨 service）

| 服务 | 关系 | 说明 |
|------|:----:|------|
| `PtyService` | **必需** | 通过 `setPtyService` 注入，监听本地终端 I/O |
| `SshService` | **必需** | 通过 `setSshService` 注入，远程终端 CWD/状态查询 |

## 关键行为 / 数据流

1. `initTerminal(id, type, initialCwd?)` → 创建 `TerminalState{cwd: initialCwd || home}`
2. 用户输入 → `handleInput` 缓冲 → 回车后 `analyzeInput` 判断"可能变更目录" → `startCommandExecution`
3. PTY/SSH 输出流 → `appendCommandOutput` 累积 → 命令结束触发 `completeCommandExecution`
4. CWD 变化（命令执行后或定时检查） → `updateCwd` → 触发 `cwdChangeCallbacks`
5. Agent 查询上下文 → `getCurrentExecution` / `getCwd` / `getLastExecution` → 注入 prompt

## 关键约束

- **`output` 字段最多保留 `MAX_OUTPUT_LENGTH` 字符**（5000），超长截断
- **历史记录上限 `MAX_EXECUTION_HISTORY`**（20）
- **CWD 检查间隔 `CWD_CHECK_INTERVAL`**（5000ms），不得调小到无意义级别
- **`refreshCwd` 不得阻塞命令执行**——异步刷新，失败不抛
- **`removeTerminal` 必须清理状态**——禁止残留 sessionId 引用
- **`onCwdChange` / `onCommandExecution` 是全局回调**——回调内自行按 `event.sessionId` 过滤，不要按 sessionId 注册（API 不支持）
