# SFTP Service SPEC

> Last verified: 2026-05-07

## 职责

SFTP 文件传输服务。基于 SSH 会话提供文件系统操作——浏览、上传、下载、目录同步、权限管理。支持传输进度追踪和取消。

## 文件 / 规模

单文件：`electron/services/sftp.service.ts`（~610 行）

## 公开 API

| 方法签名 | 用途 | 主要调用方 |
|---------|------|-----------|
| `async connect(sessionId, config): Promise<void>` | 建立 SFTP 连接 | SSH connect 后 |
| `async disconnect(sessionId): Promise<void>` | 断开单个 SFTP 会话 | CLI/UI |
| `async disconnectAll(): Promise<void>` | 断开所有会话 | 生命周期 |
| `hasSession(sessionId): boolean` | 查询会话是否存在 | agent/tools |
| `async list(sessionId, remotePath): Promise<{files[], resolvedPath}>` | 列出远程目录 | agent/tools |
| `async pwd(sessionId): Promise<string>` | 获取远程当前目录 | agent/tools |
| `async stat(sessionId, remotePath): Promise<FileStats \| null>` | 获取远程文件属性 | agent/tools |
| `async exists(sessionId, remotePath): Promise<false \| "d" \| "-" \| "l">` | 检查路径存在及类型 | agent/tools |
| `async upload(sessionId, local, remote, transferId): Promise<void>` | 上传单文件 | agent/tools |
| `async download(sessionId, remote, local, transferId): Promise<void>` | 下载单文件 | agent/tools |
| `async uploadDir(sessionId, localDir, remoteDir): Promise<void>` | 上传整个目录 | agent/tools |
| `async downloadDir(sessionId, remoteDir, localDir): Promise<void>` | 下载整个目录 | agent/tools |
| `async mkdir(sessionId, remotePath, recursive?): Promise<void>` | 创建远程目录 | agent/tools |
| `async delete(sessionId, remotePath): Promise<void>` | 删除远程文件 | agent/tools |
| `async rmdir(sessionId, remotePath, recursive?): Promise<void>` | 删除远程目录 | agent/tools |
| `async rename(sessionId, oldPath, newPath): Promise<void>` | 重命名远程文件/目录 | agent/tools |
| `async chmod(sessionId, remotePath, mode): Promise<void>` | 修改远程文件权限 | agent/tools |
| `async getSize(sessionId, remotePath): Promise<number>` | 获取远程文件大小 | agent/tools |
| `async readFile(sessionId, remotePath): Promise<string>` | 读取远程文本文件 | agent/tools |
| `async writeFile(sessionId, remotePath, content): Promise<void>` | 写入远程文本文件 | agent/tools |
| `getTransfers(): TransferProgress[]` | 获取所有传输任务进度 | UI/仪表盘 |
| `cancelTransfer(transferId): boolean` | 取消指定传输 | UI |
| `isTransferCancelled(transferId): boolean` | 查询传输是否已取消 | 传输循环 |
| `clearCancelledTransfer(transferId): void` | 清除取消标记 | 传输结束 |

## 核心类型 / 接口

```ts
interface SftpFileInfo {
  name: string; path: string; size: number
  modifyTime: number; accessTime: number
  isDirectory: boolean; isSymlink: boolean
  permissions: { user: string; group: string; other: string }
  owner: number; group: number
}
interface TransferProgress {
  transferId: string; filename: string
  localPath: string; remotePath: string
  direction: "upload" | "download"
  totalBytes: number; transferredBytes: number; percent: number
  status: "pending" | "transferring" | "completed" | "failed" | "cancelled"
  error?: string; startTime: number
}
```

## 依赖（跨 service）

| 服务 | 关系 | 说明 |
|------|:----:|------|
| `ssh-error.ts` | 必需 | SSH 错误信息国际化（`getSshErrorMessage`） |

## 关键行为 / 数据流

1. SSH 连接建立 → `connect(sessionId, config)` → 复用 SSH 隧道的 SFTP 子通道
2. 文件操作（list/get/put...）→ 直接调用 `ssh2-sftp-client` → 结果解析
3. 传输任务 → `upload/download` 注册到 `transfers` Map → 进度回调更新 `TransferProgress.percent`
4. 取消传输 → `cancelTransfer(transferId)` → 写入 `cancelledTransfers` Set → 传输循环检测到后 `abort`

## 关键约束

- **SFTP 会话绑定 SSH 会话生命周期**——SSH 断开时必须 `disconnect(sessionId)`
- **目录同步清空后再传**——`uploadDir` / `downloadDir` 不得增量（避免远程残留脏文件）
- **取消传输仅标记**——传输循环必须主动检查 `isTransferCancelled`，不得依赖 `abort`
- **readFile 仅适用于文本文件**——二进制文件必须走 `download`
