/**
 * argv 通道命令执行（assistant 模式）
 *
 * spawn(cmd, args, { shell: false }) — 不经 shell 解释，配合 command-audit 白名单审计。
 * 需要管道 / && / 重定向时使用 legacy exec(command) 工具。
 */
import { t } from '../i18n'
import { getScratchPath } from './file'
import {
  assessArgvRisk,
  argvNeedsConfirm,
  defaultAuditContext,
  isArgvBlocked,
  type ArgvInput,
} from '../command-audit'
import { isSubAgentBlocked } from '../command-audit/confirm-policy'
import { formatTaskOutput } from './exec'
import { getExecManager } from './exec-manager'
import { getSkillEnvMap, mapSkillEnvToDeclaredCase } from '../../../services/credential.service'
import { getUserSkillService } from '../../../services/user-skill.service'
import { truncateFromEnd, EXEC_MAX_COMMAND_LENGTH } from './utils'
import type { ToolExecutorConfig, AgentConfig, ToolResult } from './types'

const DEFAULT_WAIT_SECONDS = 60
const MAX_WAIT_SECONDS = 600
const DEFAULT_MAX_SECONDS = 3600
const MAX_MAX_SECONDS = 24 * 3600

function clampNumber(raw: unknown, fallback: number, min: number, max: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return fallback
  return Math.min(Math.max(raw, min), max)
}

function normalizeArgvArgs(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null
  const out: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') return null
    out.push(item)
  }
  return out
}

/**
 * exec_argv 主入口
 */
export async function executeArgvDirect(
  args: Record<string, unknown>,
  toolCallId: string,
  config: AgentConfig,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const cmd = typeof args.cmd === 'string' ? args.cmd.trim() : ''
  if (!cmd) {
    return { success: false, output: '', error: t('hint.command_empty') }
  }

  const argvArgs = normalizeArgvArgs(args.args)
  if (argvArgs === null) {
    return { success: false, output: '', error: 'exec_argv: args 必须是字符串数组' }
  }

  const display = [cmd, ...argvArgs].join(' ')
  if (display.length > EXEC_MAX_COMMAND_LENGTH) {
    const errorMsg = t('hint.command_too_long', { length: display.length, max: EXEC_MAX_COMMAND_LENGTH })
    return { success: false, output: '', error: errorMsg }
  }

  const cwd = (typeof args.cwd === 'string' && args.cwd) ? args.cwd : getScratchPath()
  const argvInput: ArgvInput = { cmd, args: argvArgs, cwd }
  const assessment = assessArgvRisk(argvInput, defaultAuditContext(cwd))
  const riskLevel = assessment.level

  if (isArgvBlocked(riskLevel)) {
    const reason = assessment.calls[0]?.reasons.join('；') ?? t('hint.security_blocked')
    executor.addStep({
      type: 'tool_call',
      content: `🚫 ${display}`,
      toolName: 'exec_argv',
      toolArgs: { cmd, args: argvArgs },
      riskLevel: 'blocked',
    })
    executor.addStep({
      type: 'tool_result',
      content: reason,
      toolName: 'exec_argv',
      toolResult: reason,
    })
    return { success: false, output: '', error: reason }
  }

  if (isSubAgentBlocked(assessment) && executor.isSubAgent) {
    return { success: false, output: '', error: '高危或未识别命令在子任务模式下被系统自动阻止。' }
  }

  const needConfirm = argvNeedsConfirm(assessment, config.executionMode)

  executor.addStep({
    type: 'tool_call',
    content: `${t('status.executing')}: ${display}`,
    toolName: 'exec_argv',
    toolArgs: { cmd, args: argvArgs, cwd },
    riskLevel,
  })

  let userApproved = false
  if (needConfirm) {
    const approved = await executor.waitForConfirmation(
      toolCallId,
      'exec_argv',
      { cmd, args: argvArgs, cwd },
      riskLevel,
    )
    if (!approved) {
      executor.addStep({
        type: 'tool_result',
        content: `⛔ ${t('status.user_rejected')}`,
        toolName: 'exec_argv',
        toolResult: t('status.user_rejected'),
        rejected: true,
      })
      return { success: false, output: '', error: t('error.user_rejected_command') }
    }
    userApproved = true
  }

  const skillId = (args.skill_id as string) || undefined
  const waitSeconds = clampNumber(args.wait_seconds, DEFAULT_WAIT_SECONDS, 1, MAX_WAIT_SECONDS)
  const maxSeconds = clampNumber(args.max_seconds, DEFAULT_MAX_SECONDS, 1, MAX_MAX_SECONDS)
  const effectiveWait = Math.min(waitSeconds, maxSeconds)

  let skillEnv: Record<string, string> | undefined
  if (skillId) {
    const envMap = await getSkillEnvMap(skillId)
    if (Object.keys(envMap).length > 0) {
      const declaredEnvs = getUserSkillService().getSkill(skillId)?.requires?.env ?? []
      skillEnv = mapSkillEnvToDeclaredCase(envMap, declaredEnvs)
    }
  }

  const manager = getExecManager()
  const task = manager.spawnArgv({ cmd, args: argvArgs, cwd, maxSeconds, env: skillEnv })

  const reason = await manager.wait({
    task,
    waitSeconds: effectiveWait,
    isAborted: () => executor.isAborted(),
  })

  const snap = manager.snapshot(task)

  if (reason === 'aborted') {
    const output = formatTaskOutput(snap.output, executor)
    executor.addStep({
      type: 'tool_result',
      content: `⏹️ ${t('status.user_rejected')}`,
      toolName: 'exec_argv',
      toolResult: output,
    })
    return {
      success: false,
      output,
      error: t('error.operation_aborted'),
      isRunning: snap.status === 'running',
    }
  }

  if (reason === 'done') {
    const rawOutput = userApproved
      ? `[${t('status.user_approved')}]\n${snap.output}`
      : snap.output
    const output = formatTaskOutput(rawOutput, executor)
    const exitCode = snap.exitCode ?? (snap.signal ? 1 : 0)
    executor.addStep({
      type: 'tool_result',
      content: `${t('status.command_complete')} (exit: ${exitCode})`,
      toolName: 'exec_argv',
      toolResult: output,
    })

    if (snap.status === 'completed') {
      return { success: true, output }
    }
    if (snap.status === 'killed') {
      return {
        success: false,
        output,
        error: t('exec.killed_by_signal', { signal: snap.signal ?? 'unknown' }),
      }
    }
    return {
      success: false,
      output,
      error: `exit code ${exitCode}: ${truncateFromEnd(snap.output.trim(), 500)}`,
    }
  }

  const output = formatTaskOutput(snap.output, executor)
  const header = t('exec.backgrounded', {
    taskId: snap.taskId,
    pid: String(snap.pid ?? 'unknown'),
    waited: effectiveWait,
    max: maxSeconds,
  })
  executor.addStep({
    type: 'tool_result',
    content: `⏳ ${t('exec.backgrounded_short', { taskId: snap.taskId })}`,
    toolName: 'exec_argv',
    toolResult: `${header}\n${output}`,
  })
  return {
    success: true,
    output: `${header}\n${output}`,
    isRunning: true,
  }
}
