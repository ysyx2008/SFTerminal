# Host Profile Service SPEC

> Last verified: 2026-07-12

## 职责

主机环境档案管理。对本地和远程（SSH）主机进行系统探测（OS、Shell、已装工具等），生成结构化主机档案，并为 Agent 提供"当前在哪台机器上"的上下文信息。

本地 Windows Shell 探测与 PTY 共用 `resolveDefaultShell().kind`（不再用 `COMSPEC` / `PSModulePath` 猜测）。Unix 仍读 `$SHELL`。

## 文件 / 规模

单文件：`electron/services/host-profile.service.ts`（~678 行）

## 公开 API

| 方法签名 | 用途 | 主要调用方 |
|---------|------|-----------|
| `generateHostId(type, sshHost?, sshUser?): string` | 生成主机唯一标识 | `main.ts`、SSH 连接时 |
| `getProfile(hostId: string): HostProfile \| null` | 获取主机档案 | Agent 上下文构建 |
| `getAllProfiles(): HostProfile[]` | 返回所有已知主机档案 | `cli/index.ts` |
| `updateProfile(hostId, updates): HostProfile` | 更新主机档案字段 | Agent 学到新信息时 |
| `addNote(hostId, note): void` | 添加主机备注（多行追加） | Agent 记忆 |
| `updateInstalledTools(hostId, tools): void` | 覆盖更新已装工具列表 | 系统探测后 |
| `deleteProfile(hostId): void` | 删除主机档案 | 用户清理 |
| `importProfiles(profiles: HostProfile[]): void` | 批量导入主机档案 | 迁移/导入 |
| `getProbeCommands(os?: string): string[]` | 返回系统探测脚本（按 OS） | SSH 首次连接时 |
| `parseProbeOutput(output, _existingProfile?): ProbeResult` | 解析探测脚本输出 | SSH 连接后 |
| `generateHostContext(hostId: string): string` | 生成 Agent 可用的自然语言主机上下文 | `agent/index.ts` |
| `needsProbe(hostId: string): boolean` | 判断是否需要重新探测 | 连接时检查 |
| `async probeLocal(): Promise<ProbeResult>` | 探测本地系统 | 应用启动 |
| `async probeAndUpdateLocal(): Promise<HostProfile>` | 探测并更新本地档案（一步完成） | `main.ts` |

## 核心类型 / 接口

### ProbeResult
```ts
interface ProbeResult {
  hostname?, username?, os?, osVersion?
  shell?, packageManager?
  installedTools?: string[]
  homeDir?, currentDir?
}
```

`HostProfile` 来自 `@shared/types`，是 `ProbeResult` 的持久化超集（含 hostId、notes、updatedAt 等）。

## 依赖（跨 service）

- `electron/utils/shell.ts`：`resolveDefaultShell`（本地 Windows shell 类型）

## 关键行为 / 数据流

**探测流程（本地主机）**：
1. 首次 Agent run / 手动刷新 → `needsProbe('local')` 为 true 时调用 `probeAndUpdateLocal`
2. Windows：`result.shell = resolveDefaultShell().kind`；Unix：读 `$SHELL` basename
3. 写入档案；`PromptBuilder.buildHostEnvironment` 在 `context.systemInfo.shell` 为空/`unknown` 时兜底读 `profile.shell`

**探测流程（远程主机）**：
1. 首次 SSH 连接 → `needsProbe(hostId)` 返回 true
2. 调用方通过 `getProbeCommands(os)` 获取探测脚本
3. SSH 执行脚本 → 输出传给 `parseProbeOutput`
4. `updateProfile` 写入档案文件

**存储**：每个主机一个 JSON 文件（`{profilesDir}/{hostId}.json`）

## 关键约束

- **探测脚本必须只读**——不得修改远程主机任何文件或配置
- **hostId 必须稳定**（由 `generateHostId` 统一生成，严禁手动拼接）
- **`probeLocal` 不可在渲染进程调用**（依赖 Node.js `os`/`child_process`）
