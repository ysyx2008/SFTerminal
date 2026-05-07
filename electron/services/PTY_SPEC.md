# PTY Service SPEC

> Last verified: 2026-05-07

## 职责

本地终端伪终端（PTY）管理。基于 Node.js `node-pty` 创建和管理多个终端实例，提供写入、读取回调、命令注入执行、窗口调整等功能，以及跨平台系统探测（Shell 列表、进程状态）。

## 文件 / 规模

单文件：`electron/services/pty.service.ts`（~1265 行）

## 公开 API

| 方法签名 | 用途 | 主要调用方 |
|---------|------|-----------|
| `create(options?: PtyOptions): string` | 创建 PTY 终端实例，返回终端 ID | `main.ts`、`unified-terminal.service.ts` |
| `write(id: string, data: string): boolean` | 向终端写入数据 | 前端终端组件、`agent/index.ts` |
| `resize(id: string, cols: number, rows: number): void` | 调整终端尺寸 | 前端终端组件 |
| `onData(id: string, callback: (data: string) => void): () => void` | 注册终端输出回调，返回取消注册函数 | `main.ts`、`scheduler.service.ts` |
| `dispose(id: string): void` | 销毁单个终端实例 | 前端关闭标签 |
| `disposeAll(): void` | 销毁所有终端实例 | 应用退出 |
| `hasInstance(id: string): boolean` | 检查终端实例是否存在 | `agent/index.ts` |
| `executeCommand(id: string, command: string, timeout?: number): Promise<CommandResult>` | Agent 模式注入命令并等待完成（标记机制） | `agent/index.ts` |
| `abortCommand(id: string): boolean` | ��止正在执行的注入命令 | `agent/index.ts` |
| `isCommandPending(id: string): boolean` | 检查是否有待处理的注入命令 | `agent/index.ts` |
| `executeInTerminal(id: string, command: string, timeout?: number): Promise<ExecuteInTerminalResult>` | 非 Agent 模式执行命令（简单执行） | `terminal-state.service.ts` |
| `getPid(id: string): number \| undefined` | 获取终端 Shell 进程 PID | 进程监控模块 |
| `async getCwd(id: string): Promise<string \| null>` | 获取终端当前工作目录 | `terminal-awareness/` |
| `async getTerminalStatus(id: string): Promise<TerminalStatus>` | 获取终端空闲/运行状态（含进程信息） | Watch 事件检测 |
| `async getAvailableShells(): Promise<{label, value, icon}[]>` | 返回系统可用 Shell 列表 | 设置 UI |

## 核心类型 / 接口

### PtyOptions
```ts
interface PtyOptions {
  shell?: string          // 覆盖默认 Shell
  cwd?: string            // 初始工作目录
  cols?: number           // 列数
  rows?: number           // 行数
  env?: Record<string, string>
  encoding?: string       // 字符编码（默认 locale 自动检测）
}
```

### CommandResult / ExecuteInTerminalResult
注入命令执行返回结构。`ExecuteInTerminalResult` 包含 `{ output: string; exitCode?: number }`；`CommandResult` 额外含 `{ outputStart, outputEnd }`。

### TerminalStatus
```ts
interface TerminalStatus {
  isIdle: boolean
  shellPid?: number
  foregroundPid?: number
  foregroundProcess?: string
  stateDescription?: string
}
```

## 依赖（跨 service）

无跨 service 依赖。仅依赖 Node.js `node-pty` 和内置模块。

## 关键行为 / 数据流

**Agent 命令注入（executeCommand）**：

1. 生成唯一 marker 包裹命令（`⟦AGENT:<uuid>⟧ ... ⟦AGENT:<uuid>⟧`）
2. `write(id, wrappedCommand)` 写入终端
3. 监控输出流——等待 marker 回显后收集实际命令输出
4. 结束后剥离 marker 包装，返回纯净结果

**并发安全**：同一终端同时只能有一个待处理命令（`pendingCommands` map 防重入）。

## 关键约束

- **严禁将 `executeCommand` 用于用户可见的终端交互**——该方法是 Agent 专用暗通道
- **PTY 实例生命周期由调用方自行管理**，`disposeAll` 仅在应用退出时使用
- **命令 marker 格式 `⟦AGENT:<id>⟧` 不得修改**（Agent 解析依赖于此格式）
- **跨平台 Shell 探测不得硬编码路径**（macOS / Linux / Windows 各自实现）
