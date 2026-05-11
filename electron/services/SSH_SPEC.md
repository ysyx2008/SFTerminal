# SSH Service SPEC

> Last verified: 2026-05-07

## 职责

SSH 远程连接管理。建立、维持多路 SSH 会话，支持跳板机直连和跳板机 Shell 两种级联模式，提供终端 I/O、远程命令执行、终端状态查询、工作目录和进程探测。

## 文件 / 规模

单文件：`electron/services/ssh.service.ts`（~943 行）

## 公开 API

| 方法签名 | 用途 | 主要调用方 |
|---------|------|-----------|
| `async connect(config): Promise<string>` | 建立 SSH 连接，返回 session ID | main.ts, CLI |
| `write(id, data): boolean` | 向终端写入数据 | PtyService |
| `resize(id, cols, rows): void` | 调整终端窗口大小 | PtyService |
| `onData(id, callback): () => void` | 注册终端数据回调，返回取消函数 | PtyService |
| `hasInstance(id): boolean` | 查询 session 是否存活 | tool/ssh |
| `getActiveInstanceCount(): number` | 当前活跃 SSH 会话数（退出确认主进程兜底） | `main.ts` |
| `onDisconnect(id, callback): () => void` | 注册断连回调 | PtyService |
| `disconnect(id): void` | 断开单个会话 | CLI, UI |
| `disposeAll(): void` | 断开所有会话 | 生命周期 |
| `async probe(id, timeout?): Promise<string>` | 执行探测命令（来自 host-profile） | HostProfileService |
| `getConfig(id): SshConfig \| null` | 获取会话原始配置 | UI |
| `executeInTerminal(id, cmd, timeout?): Promise<ExecuteInTerminalResult>` | 在远程终端执行命令并返回结果 | agent/tools |
| `async getTerminalStatus(id): Promise<TerminalStatus>` | 查询终端空闲状态和前/后台进程 | TerminalStateService |
| `async getRemoteCwd(id): Promise<string \| null>` | 获取远程当前工作目录 | TerminalStateService |
| `async getRemoteProcesses(id): Promise<{shellPid?, children[]}>` | 探测远程 Shell 进程树 | TerminalStateService |

## 核心类型 / 接口

```ts
interface TerminalStatus {
  isIdle: boolean; shellPid?: number
  foregroundPid?: number; foregroundProcess?: string
  stateDescription?: string
}
interface SshDisconnectEvent {
  id: string; reason: "closed" | "error" | "stream_closed" | "jump_host_closed"
  error?: Error
}
```

内部类型（不对外暴露）：
```ts
interface SshInstance {
  client: Client; jumpClient?: Client; stream: ClientChannel | null
  dataCallbacks: ((data: string) => void)[]; config: SshConfig; encoding: string
}
```

## 依赖（跨 service）

| 服务 | 关系 | 说明 |
|------|:----:|------|
| `HostProfileService` | 可选 | `probe()` 获取探测命令模板（`getUnixProbeCommands`） |
| `PtyService` | 可选 | 仅 `ExecuteInTerminalResult` 类型引用 |
| `ssh-error.ts` | 必需 | 错误信息国际化映射 |

## 关键行为 / 数据流

**三种连接模式**：
1. **直连**：SSH→目标主机
2. **跳板机直连**（`directConnect`）：SSH→跳板机→forwardOut→目标主机
3. **跳板机 Shell**（`connectViaJumpServerShell`）：SSH→跳板机→Shell 执行 `ssh` 命令→目标主机

**断连处理**：`on('close')` → 清理 `dataCallbacks` → `emitDisconnect(event)` → 通知所有监听者

**终端探测**：`getTerminalStatus` / `getRemoteCwd` / `getRemoteProcesses` 均通过 `execCommand` 在远程执行 Shell 命令并解析输出

## 关键约束

- **跳板机 Shell 模式不得泄露跳板机密码**——配置中的 `jumpServerPassword` 不出现在日志
- **断连后必须清理回调**——`instances` Map 和 `disconnectCallbacks` Map 同步清理，防止内存泄漏
- **连���超时需有上限**——`connect_config.timeout` 默认可配置，不得无限制等待
