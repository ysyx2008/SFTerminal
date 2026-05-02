/**
 * SFTP 文件传输工具（SSH 模式专用）
 *
 * sftp_put：本地文件 → 远程；sftp_get：远程文件 → 本地。
 * 与 write_remote_text_file 互补——后者把 AI 生成的文本字面值塞进 tool_args 直接落盘，
 * 适合短脚本/小配置；本工具走 SftpService.upload/download 流式通道，
 * 适合大文件、二进制、以及"远程文件 → 本地 workspace → 本地工具深度分析"的工作流。
 *
 * 注意：
 * - executor.isAborted() 在传输前检查；ssh2-sftp-client 不支持中途真正打断，
 *   只能通过 SftpService.cancelTransfer 标记。这里用一次性 abort 监听调 cancel，
 *   底层 step 回调读到 cancelled 标记后会跳过最终 progress 更新。
 * - 进度推送用节流（>=300ms 一次）避免高频 updateStep 刷屏与 i18n 渲染开销。
 */
import * as fs from 'fs'
import * as path from 'path'
import { t } from '../i18n'
import { formatFileSize } from './utils'
import { getWorkspacePath, isInWorkspace } from './file'
import type { ToolExecutorConfig, AgentConfig, ToolResult } from './types'
import type { TransferProgress } from '../../sftp.service'

/** 传输进度更新节流间隔（ms）——更短意义不大，渲染卡顿，prompt cache 也不喜欢 */
const PROGRESS_THROTTLE_MS = 300

/**
 * 生成临时 transferId，避免与前端 UI 上传任务的 ID 空间冲突。
 * 仅在工具内部使用，不暴露到 IPC，不需要全局唯一。
 */
function newTransferId(): string {
  return `agent-sftp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * 解析 sftp_get 的 local_path：未指定时落到 agent workspace 根目录，
 * 文件名取自 remote 的 basename。这样 AI 不必关心本地路径细节，
 * 后续 read_file 直接吃到 workspace 内的副本。
 */
function resolveLocalDownloadPath(remotePath: string, localPathArg: string | undefined): string {
  if (localPathArg && localPathArg.trim()) {
    if (path.isAbsolute(localPathArg)) return localPathArg
    return path.join(getWorkspacePath(), localPathArg)
  }
  const base = path.posix.basename(remotePath) || 'remote-file'
  return path.join(getWorkspacePath(), base)
}

/**
 * 确保 SFTP 会话已建立（懒连接）。复用 write_remote_text_file 的同款做法。
 * sshConfig 已在调用方校验过非空，此处直接使用。
 */
async function ensureSftpConnected(
  ptyId: string,
  executor: ToolExecutorConfig,
  toolName: string
): Promise<{ ok: true } | { ok: false; result: ToolResult }> {
  const sftpService = executor.getSftpService?.()
  const sshConfig = executor.getSshConfig?.(ptyId)
  if (!sftpService) {
    return { ok: false, result: { success: false, output: '', error: t('error.sftp_not_initialized') } }
  }
  if (!sshConfig) {
    return { ok: false, result: { success: false, output: '', error: t('error.ssh_config_unavailable') } }
  }
  if (!sftpService.hasSession(ptyId)) {
    executor.addStep({
      type: 'tool_result',
      content: t('file.establishing_sftp'),
      toolName,
      isStreaming: true
    })
    await sftpService.connect(ptyId, {
      host: sshConfig.host,
      port: sshConfig.port,
      username: sshConfig.username,
      password: sshConfig.password,
      privateKey: sshConfig.privateKey,
      privateKeyPath: sshConfig.privateKeyPath,
      passphrase: sshConfig.passphrase
    })
  }
  return { ok: true }
}

/**
 * 上传本地文件到远程主机
 */
export async function sftpPut(
  ptyId: string,
  args: Record<string, unknown>,
  toolCallId: string,
  config: AgentConfig,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const localPath = args.local_path as string
  const remotePath = args.remote_path as string
  const overwrite = args.overwrite === true

  if (!localPath || !remotePath) {
    return { success: false, output: '', error: t('sftp.path_required') }
  }

  // 本地文件预检：必须存在且是文件，否则上传必失败，提前 bail 避免发起无意义连接
  let localStats: fs.Stats
  try {
    localStats = fs.statSync(localPath)
  } catch {
    return { success: false, output: '', error: t('sftp.local_not_exists', { path: localPath }) }
  }
  if (!localStats.isFile()) {
    return { success: false, output: '', error: t('sftp.local_not_file', { path: localPath }) }
  }
  const totalBytes = localStats.size
  const sizeDisplay = formatFileSize(totalBytes)
  const fileName = path.basename(localPath)

  // tool_call 卡：上传是写远程，默认 moderate；overwrite 已存在文件升级到 dangerous（覆盖丢数据）
  // 此处还没问远程是否存在，先按 overwrite=true 谨慎评估为 dangerous，
  // 给确认环节一个最严格的默认；若实际不存在就会落到 create，无非用户多确认一次。
  const riskLevel = overwrite ? 'dangerous' : 'moderate'
  executor.addStep({
    type: 'tool_call',
    content: `${t('sftp.upload')} (${sizeDisplay}): ${fileName} → ${remotePath}`,
    toolName: 'sftp_put',
    toolArgs: { local_path: localPath, remote_path: remotePath, ...(overwrite && { overwrite: true }) },
    riskLevel
  })

  if (riskLevel === 'dangerous' || config.executionMode === 'strict') {
    const approved = await executor.waitForConfirmation(
      toolCallId,
      'sftp_put',
      { local_path: localPath, remote_path: remotePath, overwrite },
      riskLevel
    )
    if (!approved) {
      return { success: false, output: '', error: t('sftp.user_rejected') }
    }
  }

  if (executor.isAborted()) {
    return { success: false, output: '', error: t('sftp.transfer_cancelled') }
  }

  const conn = await ensureSftpConnected(ptyId, executor, 'sftp_put')
  if (!conn.ok) return conn.result
  const sftpService = executor.getSftpService?.()!

  // 远程存在性检查：非 overwrite 模式下命中已存在路径直接报错，避免静默覆盖
  // exists() 返回 false / 'd' / '-' / 'l'；目录命中也报错（put 到目录会失败但报错信息混乱）
  if (!overwrite) {
    try {
      const remoteKind = await sftpService.exists(ptyId, remotePath)
      if (remoteKind !== false) {
        return { success: false, output: '', error: t('sftp.remote_exists_no_overwrite', { path: remotePath }) }
      }
    } catch {
      // exists 检查失败不阻断主流程——可能是父目录权限问题，让 upload 自身报真正的错
    }
  }

  const transferId = newTransferId()
  const progressStep = executor.addStep({
    type: 'tool_result',
    content: `⏫ ${t('sftp.uploading', { name: fileName })} 0%`,
    toolName: 'sftp_put',
    isStreaming: true
  })

  // 节流推送进度：避免每个 chunk 都触发 updateStep 渲染开销
  let lastUpdate = 0
  const onProgress = (p: TransferProgress) => {
    if (p.transferId !== transferId) return
    const now = Date.now()
    if (now - lastUpdate < PROGRESS_THROTTLE_MS) return
    lastUpdate = now
    executor.updateStep(progressStep.id, {
      content: `⏫ ${t('sftp.uploading', { name: fileName })} ${p.percent}% (${formatFileSize(p.transferredBytes)} / ${sizeDisplay})`
    })
  }
  sftpService.on('transfer-progress', onProgress)

  try {
    await sftpService.upload(ptyId, localPath, remotePath, transferId)
    const successMsg = t('sftp.upload_success', { name: fileName, path: remotePath, size: sizeDisplay })
    executor.updateStep(progressStep.id, {
      content: `✅ ${successMsg}`,
      isStreaming: false
    })
    return { success: true, output: successMsg }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : t('sftp.upload_failed')
    executor.updateStep(progressStep.id, {
      content: `❌ ${t('sftp.upload_failed')}: ${errorMsg}`,
      toolResult: errorMsg,
      isStreaming: false
    })
    return { success: false, output: '', error: `${t('sftp.upload_failed')}: ${errorMsg}` }
  } finally {
    sftpService.off('transfer-progress', onProgress)
  }
}

/**
 * 从远程主机下载文件到本地
 */
export async function sftpGet(
  ptyId: string,
  args: Record<string, unknown>,
  toolCallId: string,
  config: AgentConfig,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const remotePath = args.remote_path as string
  const localPathArg = args.local_path as string | undefined

  if (!remotePath) {
    return { success: false, output: '', error: t('sftp.remote_path_required') }
  }

  const localPath = resolveLocalDownloadPath(remotePath, localPathArg)
  const fileName = path.posix.basename(remotePath) || 'remote-file'

  // 风险评估：落点在 workspace 内 = safe（agent 私有空间）；其它路径 = moderate（可能覆盖用户文件）
  const inWorkspace = isInWorkspace(localPath)
  const riskLevel = inWorkspace ? 'safe' : 'moderate'

  executor.addStep({
    type: 'tool_call',
    content: `${t('sftp.download')}: ${remotePath} → ${localPath}`,
    toolName: 'sftp_get',
    toolArgs: { remote_path: remotePath, local_path: localPath },
    riskLevel
  })

  if (!inWorkspace && config.executionMode === 'strict') {
    const approved = await executor.waitForConfirmation(
      toolCallId,
      'sftp_get',
      { remote_path: remotePath, local_path: localPath },
      riskLevel
    )
    if (!approved) {
      return { success: false, output: '', error: t('sftp.user_rejected') }
    }
  }

  if (executor.isAborted()) {
    return { success: false, output: '', error: t('sftp.transfer_cancelled') }
  }

  const conn = await ensureSftpConnected(ptyId, executor, 'sftp_get')
  if (!conn.ok) return conn.result
  const sftpService = executor.getSftpService?.()!

  // 远程存在性 + 大小预检：sftp.download 内部也会 stat，但提前 stat 一次能拿到大小用于进度展示，
  // 也能在文件不存在时给出清晰错误（download 自己的错误信息含 ssh2 协议码不友好）
  let remoteSize = 0
  try {
    const stat = await sftpService.stat(ptyId, remotePath)
    if (!stat) {
      return { success: false, output: '', error: t('sftp.remote_not_exists', { path: remotePath }) }
    }
    remoteSize = stat.size
  } catch {
    return { success: false, output: '', error: t('sftp.remote_not_exists', { path: remotePath }) }
  }
  const sizeDisplay = formatFileSize(remoteSize)

  const transferId = newTransferId()
  const progressStep = executor.addStep({
    type: 'tool_result',
    content: `⏬ ${t('sftp.downloading', { name: fileName })} 0%`,
    toolName: 'sftp_get',
    isStreaming: true
  })

  let lastUpdate = 0
  const onProgress = (p: TransferProgress) => {
    if (p.transferId !== transferId) return
    const now = Date.now()
    if (now - lastUpdate < PROGRESS_THROTTLE_MS) return
    lastUpdate = now
    executor.updateStep(progressStep.id, {
      content: `⏬ ${t('sftp.downloading', { name: fileName })} ${p.percent}% (${formatFileSize(p.transferredBytes)} / ${sizeDisplay})`
    })
  }
  sftpService.on('transfer-progress', onProgress)

  try {
    await sftpService.download(ptyId, remotePath, localPath, transferId)
    const successMsg = t('sftp.download_success', { name: fileName, path: localPath, size: sizeDisplay })
    executor.updateStep(progressStep.id, {
      content: `✅ ${successMsg}`,
      isStreaming: false
    })
    return { success: true, output: successMsg }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : t('sftp.download_failed')
    executor.updateStep(progressStep.id, {
      content: `❌ ${t('sftp.download_failed')}: ${errorMsg}`,
      toolResult: errorMsg,
      isStreaming: false
    })
    return { success: false, output: '', error: `${t('sftp.download_failed')}: ${errorMsg}` }
  } finally {
    sftpService.off('transfer-progress', onProgress)
  }
}
