/**
 * 轻量命令执行器（基于 child_process.spawn）
 *
 * 用于无终端的 Agent 模式（assistant），直接执行 shell 命令并返回结果。
 * 与 PTY 版（command.ts）不同：
 * - 不需要终端会话，不追踪终端状态
 * - 不支持 sudo、续行检测等终端特有交互
 *
 * 同步 vs 后台：
 * - wait_seconds 内结束 → 返回完整结果（同传统 exec 行为）
 * - 仍在跑且 wait_seconds < max_seconds → 转后台，返回 task_id 让 Agent 后续 await_exec
 *
 * 进程托管见 exec-manager.ts。
 */
import { t } from '../i18n'
import { assessCommandRisk, analyzeCommand } from '../risk-assessor'
import { truncateFromEnd, EXEC_MAX_COMMAND_LENGTH } from './utils'
import { getExecManager, MAX_PATTERN_LENGTH } from './exec-manager'
import type { ToolExecutorConfig, AgentConfig, ToolResult } from './types'

const DEFAULT_WAIT_SECONDS = 60
const MAX_WAIT_SECONDS = 600        // 单次同步等待上限（防止 Agent 设置极长 wait 卡住会话）
const DEFAULT_MAX_SECONDS = 3600    // 后台最长允许运行 1 小时（防僵尸进程）
const MAX_MAX_SECONDS = 24 * 3600   // 最长 24 小时（极端长任务硬上限）

const OUTPUT_TRUNCATE = 8000        // 返回给 Agent 的输出截断（与原实现一致）

/**
 * 把后台任务原始输出整理为 Agent 可读形态：先 trim 掉首尾空白（与旧版 exec 行为一致，
 * 避免 LLM 看到无意义的尾部换行），再做 8KB 截断。
 */
function formatTaskOutput(raw: string): string {
  return truncateFromEnd(raw.trim(), OUTPUT_TRUNCATE)
}

/**
 * 解析数字参数，类型不对/越界时回退到默认值
 */
function clampNumber(raw: unknown, fallback: number, min: number, max: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return fallback
  return Math.min(Math.max(raw, min), max)
}

/**
 * 主入口：执行命令，超过 wait_seconds 转后台
 */
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

  // 命令长度防误用（实际限制是 ARG_MAX，给 100KB 足够日常 oneliner）
  if (command.length > EXEC_MAX_COMMAND_LENGTH) {
    const errorMsg = t('hint.command_too_long', { length: command.length, max: EXEC_MAX_COMMAND_LENGTH })
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
        toolResult: t('status.user_rejected'),
        rejected: true
      })
      return { success: false, output: '', error: t('error.user_rejected_command') }
    }
    userApproved = true
  }

  const cwd = (args.cwd as string) || undefined
  const waitSeconds = clampNumber(args.wait_seconds, DEFAULT_WAIT_SECONDS, 1, MAX_WAIT_SECONDS)
  const maxSeconds = clampNumber(args.max_seconds, DEFAULT_MAX_SECONDS, 1, MAX_MAX_SECONDS)

  // 转后台时实际等待时间是 min(wait, max)——max 已经是硬上限，wait > max 没意义
  const effectiveWait = Math.min(waitSeconds, maxSeconds)

  const manager = getExecManager()
  const task = manager.spawn({ command, cwd, maxSeconds })

  const reason = await manager.wait({
    task,
    waitSeconds: effectiveWait,
    isAborted: () => executor.isAborted(),
  })

  const snap = manager.snapshot(task)

  // ============= abort：直接返回，但任务继续在后台跑 =============
  if (reason === 'aborted') {
    const output = formatTaskOutput(snap.output)
    executor.addStep({
      type: 'tool_result',
      content: `⏹️ ${t('status.user_rejected')}`,
      toolName: 'exec',
      toolResult: output
    })
    return {
      success: false,
      output,
      error: t('error.operation_aborted'),
      isRunning: snap.status === 'running',
    }
  }

  // ============= 任务在 wait_seconds 内结束 =============
  if (reason === 'done') {
    const output = formatTaskOutput(snap.output)
    const exitCode = snap.exitCode ?? (snap.signal ? 1 : 0)
    executor.addStep({
      type: 'tool_result',
      content: `${t('status.command_complete')} (exit: ${exitCode})`,
      toolName: 'exec',
      toolResult: output
    })

    const finalOutput = userApproved ? `[${t('status.user_approved')}]\n${output}` : output

    if (snap.status === 'completed') {
      return { success: true, output: finalOutput }
    }
    if (snap.status === 'killed') {
      return {
        success: false,
        output: finalOutput,
        error: t('exec.killed_by_signal', { signal: snap.signal ?? 'unknown' })
      }
    }
    return {
      success: false,
      output: finalOutput,
      error: `exit code ${exitCode}: ${truncateFromEnd(snap.output.trim(), 500)}`
    }
  }

  // ============= 任务仍在跑 → 转后台 =============
  const output = formatTaskOutput(snap.output)
  const header = t('exec.backgrounded', {
    taskId: snap.taskId,
    pid: String(snap.pid ?? 'unknown'),
    waited: effectiveWait,
    max: maxSeconds,
  })
  executor.addStep({
    type: 'tool_result',
    content: `⏳ ${t('exec.backgrounded_short', { taskId: snap.taskId })}`,
    toolName: 'exec',
    toolResult: `${header}\n${output}`
  })
  return {
    success: true,
    output: `${header}\n${output}`,
    isRunning: true,
  }
}

/**
 * await_exec：等待已转后台的任务结束、命中 pattern、或超时返回最新输出
 */
export async function awaitExec(
  args: Record<string, unknown>,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const taskId = typeof args.task_id === 'string' ? args.task_id : ''
  if (!taskId) {
    return { success: false, output: '', error: t('exec.task_id_required') }
  }

  const waitSeconds = clampNumber(args.wait_seconds, 30, 1, MAX_WAIT_SECONDS)

  let pattern: RegExp | undefined
  if (typeof args.pattern === 'string' && args.pattern) {
    if (args.pattern.length > MAX_PATTERN_LENGTH) {
      return {
        success: false,
        output: '',
        error: t('exec.invalid_pattern', { error: `pattern too long (>${MAX_PATTERN_LENGTH} chars)` })
      }
    }
    try {
      pattern = new RegExp(args.pattern, 'm')
    } catch (e) {
      return {
        success: false,
        output: '',
        error: t('exec.invalid_pattern', { error: (e as Error).message })
      }
    }
  }

  const manager = getExecManager()
  const task = manager.get(taskId)
  if (!task) {
    return { success: false, output: '', error: t('exec.task_not_found', { taskId }) }
  }

  executor.addStep({
    type: 'tool_call',
    content: `⏳ ${t('exec.awaiting', { taskId })}`,
    toolName: 'await_exec',
    toolArgs: { task_id: taskId }
  })

  const reason = await manager.wait({
    task,
    waitSeconds,
    pattern,
    isAborted: () => executor.isAborted(),
  })

  const snap = manager.snapshot(task)
  const output = formatTaskOutput(snap.output)

  if (reason === 'aborted') {
    executor.addStep({
      type: 'tool_result',
      content: `⏹️ ${t('status.user_rejected')}`,
      toolName: 'await_exec',
      toolResult: output
    })
    return {
      success: false,
      output,
      error: t('error.operation_aborted'),
      isRunning: snap.status === 'running',
    }
  }

  if (reason === 'done') {
    const exitCode = snap.exitCode ?? (snap.signal ? 1 : 0)
    const header = t('exec.task_done', {
      taskId,
      status: snap.status,
      exitCode: String(exitCode),
    })
    executor.addStep({
      type: 'tool_result',
      content: `${t('status.command_complete')} (${snap.status}, exit: ${exitCode})`,
      toolName: 'await_exec',
      toolResult: `${header}\n${output}`
    })
    if (snap.status === 'completed') {
      return { success: true, output: `${header}\n${output}` }
    }
    return {
      success: false,
      output: `${header}\n${output}`,
      error: snap.status === 'killed'
        ? t('exec.killed_by_signal', { signal: snap.signal ?? 'unknown' })
        : `exit ${exitCode}`
    }
  }

  // pattern 命中 或 timeout：仍在跑
  const header = reason === 'pattern'
    ? t('exec.pattern_matched', { taskId, pid: String(snap.pid ?? 'unknown') })
    : t('exec.still_running', { taskId, pid: String(snap.pid ?? 'unknown'), waited: waitSeconds })

  executor.addStep({
    type: 'tool_result',
    content: `⏳ ${reason === 'pattern' ? t('exec.pattern_matched_short', { taskId }) : t('exec.still_running_short', { taskId })}`,
    toolName: 'await_exec',
    toolResult: `${header}\n${output}`
  })

  return {
    success: true,
    output: `${header}\n${output}`,
    isRunning: true,
  }
}
