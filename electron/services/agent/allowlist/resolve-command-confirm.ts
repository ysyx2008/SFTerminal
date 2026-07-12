/**
 * 命令类工具确认决策（会话内存「本次允许」由 waitForConfirmation 内查 allowedTools）
 */
import type { RiskLevel } from '@shared/types/agent'
import type { AgentConfig } from '../types'
import type { ToolExecutorConfig, ToolResult } from '../tools/types'
import { commandNeedsConfirm } from '../command-audit/confirm-policy'
import type { CommandRiskAssessment } from '../command-audit/types'
import { t } from '../i18n'

export type CommandConfirmDecision =
  | { proceed: true; userApproved: boolean }
  | { proceed: false; result: ToolResult }

/**
 * 收集触发最终风险等级的原因（去重）。
 *
 * 只取 level 等于整体 riskLevel 的子命令的 reasons，
 * 让确认卡片聚焦于"为什么是这个等级"，避免低风险子命令的噪声。
 */
function collectTriggerReasons(
  assessment: CommandRiskAssessment,
  riskLevel: RiskLevel,
): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const call of assessment.calls) {
    if (call.level === riskLevel) {
      for (const r of call.reasons) {
        if (!seen.has(r)) {
          seen.add(r)
          result.push(r)
        }
      }
    }
  }
  return result
}

export async function resolveCommandToolConfirmation(
  toolName: string,
  toolArgs: Record<string, unknown>,
  assessment: CommandRiskAssessment,
  config: AgentConfig,
  toolCallId: string,
  riskLevel: RiskLevel,
  executor: ToolExecutorConfig,
): Promise<CommandConfirmDecision> {
  const needConfirm = commandNeedsConfirm(assessment, config.executionMode, config.commandRiskPolicy)
  if (!needConfirm) {
    return { proceed: true, userApproved: false }
  }

  // 只收集「等级等于最终 riskLevel」的子命令的原因（去重），
  // 让用户看到"为什么是高风险"而不是所有子命令的噪声。
  const reasons = collectTriggerReasons(assessment, riskLevel)

  const approved = await executor.waitForConfirmation(
    toolCallId,
    toolName,
    toolArgs,
    riskLevel,
    undefined,
    reasons,
  )
  if (!approved) {
    return {
      proceed: false,
      result: {
        success: false,
        output: '',
        error: t('error.user_rejected_command'),
      },
    }
  }
  return { proceed: true, userApproved: true }
}
