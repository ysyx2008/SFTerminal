# Startup Registry

## 职责

启动期懒加载 **Agent / 终端 / SSH / SFTP** 运行时（含 `node-pty`、`ssh2` 原生模块），避免低配 Windows 在出窗口前同步 LoadLibrary + Defender 扫描。

## 公开 API

- `ensureAgentRuntime(deps)` — 首次调用时 `import()` 并实例化整条链；后续返回同一实例
- `getAgentRuntimeOrNull()` — 未加载时返回 `null`（退出清理、退出确认兜底）
- `disposeAgentRuntimeIfLoaded()` — 释放已加载的 PTY/SSH/SFTP
- `setTerminalEventSender()` / `registerSftpWindowGetter()` — 主进程窗口桥接，runtime 初始化后挂事件

## 约束

- `main.ts` **不得** static import `pty.service` / `ssh.service` / `agent` 等重型模块
- 首屏路径（Config、History 读索引、窗口 IPC）不应调用 `ensureAgentRuntime`
- backend init（`runBackendInit`）或用户首次终端/Agent/侧栏历史 IPC 时才触发加载

## 依赖

传入 `AgentRuntimeDeps`：`aiService`、`configService`、`historyService`、`hostProfileService`、`mcpService`、`pluginRegistry`、`appStartTime`
