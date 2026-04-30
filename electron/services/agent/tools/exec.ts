/**
 * 轻量命令执行器（基于 child_process）
 * 
 * 用于无终端的 Agent 模式，直接执行 shell 命令并返回结果。
 * 与 PTY 版（command.ts）不同：
 * - 不需要终端会话，不追踪终端状态
 * - 同步等待命令完成（非交互式）
 * - 不支持 sudo、续行检测等终端特有交互
 */
import { exec, execFile } from 'child_process'
import { t } from '../i18n'
import { assessCommandRisk, analyzeCommand } from '../risk-assessor'
import { truncateFromEnd, EXEC_MAX_COMMAND_LENGTH } from './utils'
import { getDefaultShell } from '../../../utils/platform'
import { decodeBuffer } from '../../../utils/encoding'
import type { ToolExecutorConfig, AgentConfig, ToolResult } from './types'

const DEFAULT_TIMEOUT = 60_000
const MAX_TIMEOUT = 600_000
const MAX_BUFFER = 10 * 1024 * 1024  // 10MB

/**
 * 将 stdout/stderr 的 Buffer 解码为字符串。
 *
 * Windows 下编码策略："统一软件和系统的编码"——不强制 chcp 65001（不可靠，
 * 大量 .exe 不尊重控制台代码页），让命令以系统默认 ANSI 编码运行，由
 * decodeBuffer 按"BOM → UTF-8 校验 → 系统编码（chcp 探测）"分层识别。
 */
function decodeOutput(buf: Buffer | string): string {
  if (typeof buf === 'string') return buf
  if (!buf || buf.length === 0) return ''
  return decodeBuffer(buf, true).content
}

export async function executeCommandDirect(
  args: Record<string, unknown>,
  toolCallId: string,
  config: AgentConfig,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const command = args.command as string
  if (!command) {
    return { success: false, output: '', error: t('hint.command_empty') }
  }

  // exec 走 child_process.execFile（argv 传递），不经 PTY line discipline，
  // 上限远高于 PTY 模式，仅做防误用兜底
  const MAX_COMMAND_LENGTH = EXEC_MAX_COMMAND_LENGTH
  if (command.length > MAX_COMMAND_LENGTH) {
    const errorMsg = t('hint.command_too_long', { length: command.length, max: MAX_COMMAND_LENGTH })
    executor.addStep({
      type: 'tool_call',
      content: `🚫 ${command.slice(0, 100)}...`,
      toolName: 'exec',
      toolArgs: { command: command.slice(0, 100) + '...' },
      riskLevel: 'blocked'
    })
    executor.addStep({
      type: 'tool_result',
      content: errorMsg,
      toolName: 'exec',
      toolResult: errorMsg
    })
    return { success: false, output: '', error: errorMsg }
  }

  const handling = analyzeCommand(command)
  if (handling.strategy === 'block') {
    executor.addStep({
      type: 'tool_call',
      content: `🚫 ${command}`,
      toolName: 'exec',
      toolArgs: { command },
      riskLevel: 'blocked'
    })
    const errorMsg = `${t('hint.command_cannot_execute')}: ${handling.reason}。${handling.hint}`
    executor.addStep({
      type: 'tool_result',
      content: errorMsg,
      toolName: 'exec',
      toolResult: errorMsg
    })
    return { success: false, output: '', error: errorMsg }
  }

  const riskLevel = assessCommandRisk(command)
  if (riskLevel === 'blocked') {
    return { success: false, output: '', error: t('hint.security_blocked') }
  }

  let needConfirm = false
  if (config.executionMode === 'strict') {
    needConfirm = true
  } else if (config.executionMode === 'relaxed') {
    needConfirm = riskLevel === 'dangerous'
  }

  executor.addStep({
    type: 'tool_call',
    content: `${t('status.executing')}: ${command}`,
    toolName: 'exec',
    toolArgs: { command },
    riskLevel
  })

  let userApproved = false
  if (needConfirm) {
    const approved = await executor.waitForConfirmation(
      toolCallId, 'exec', { command }, riskLevel
    )
    if (!approved) {
      executor.addStep({
        type: 'tool_result',
        content: `⛔ ${t('status.user_rejected')}`,
        toolName: 'exec',
        toolResult: t('status.user_rejected')
      })
      return { success: false, output: '', error: t('error.user_rejected_command') }
    }
    userApproved = true
  }

  const cwd = (args.cwd as string) || undefined

  // timeout 优先级：工具参数 > config.commandTimeout > DEFAULT_TIMEOUT
  const rawTimeoutSec = args.timeout as number | undefined
  let timeout: number
  if (typeof rawTimeoutSec === 'number' && Number.isFinite(rawTimeoutSec) && rawTimeoutSec > 0) {
    timeout = Math.min(rawTimeoutSec * 1000, MAX_TIMEOUT)
  } else {
    timeout = config.commandTimeout || DEFAULT_TIMEOUT
  }

  return new Promise<ToolResult>((resolve) => {
    // exec 回调用 ExecException、execFile 用 ExecFileException，
    // 两者 code 字段类型不同；这里用 any 接收，运行时统一读 code/signal/killed。
    const execCallback = (error: any, stdoutRaw: Buffer | string, stderrRaw: Buffer | string) => {
      const stdout = decodeOutput(stdoutRaw)
      const stderr = decodeOutput(stderrRaw)
      const combined = [stdout, stderr].filter(Boolean).join('\n').trim()
      const exitCode = error?.code ?? (error ? 1 : 0)

      if (error && (error.signal === 'SIGTERM' || error.killed)) {
        const output = truncateFromEnd(combined, 4000)
        executor.addStep({
          type: 'tool_result',
          content: `⏱️ ${t('status.command_timeout')} (${timeout / 1000}${t('misc.seconds')})`,
          toolName: 'exec',
          toolResult: output
        })
        resolve({
          success: false,
          output,
          error: t('error.command_timeout_with_hint', { suggestion: 'increase timeout or split command' })
        })
        return
      }

      const output = truncateFromEnd(combined, 8000)
      executor.addStep({
        type: 'tool_result',
        content: `${t('status.command_complete')} (exit: ${exitCode})`,
        toolName: 'exec',
        toolResult: output
      })

      const finalOutput = userApproved ? `[${t('status.user_approved')}]\n${output}` : output

      if (exitCode !== 0) {
        resolve({
          success: false,
          output: finalOutput,
          error: `exit code ${exitCode}: ${truncateFromEnd(combined, 500)}`
        })
      } else {
        resolve({ success: true, output: finalOutput })
      }
    }

    const shell = getDefaultShell()
    // encoding: 'buffer' 让 stdout/stderr 返回原始字节，由 decodeOutput 按
    // 系统默认编码（Windows = chcp 探测，其它 = utf-8）解码，避免乱码。
    const opts = { cwd, timeout, maxBuffer: MAX_BUFFER, encoding: 'buffer' as const }
    if (process.platform === 'win32') {
      exec(command, { ...opts, shell }, execCallback)
    } else {
      execFile(shell, ['-l', '-c', command], opts, execCallback)
    }
  })
}
