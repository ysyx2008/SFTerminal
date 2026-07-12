/**
 * 命令执行确认策略
 *
 * relaxed：默认只确认 dangerous / blocked；
 *          若 riskPolicy.relaxedConfirmModerate=true，则 moderate 也确认。
 * free：不确认（用户自担）。
 */
import type { RiskLevel, CommandRiskPolicy } from '@shared/types/agent'
import type { CommandRiskAssessment } from './types'
import { resolveSubAgentBlockDangerous } from './fail-closed-policy'

export function commandNeedsConfirm(
  assessment: CommandRiskAssessment,
  executionMode: 'strict' | 'relaxed' | 'free',
  policy?: CommandRiskPolicy | null,
): boolean {
  if (executionMode === 'strict') return true
  if (executionMode === 'free') return false
  if (assessment.level === 'blocked' || assessment.level === 'dangerous') return true
  if (assessment.level === 'moderate' && policy?.relaxedConfirmModerate) return true
  return false
}

/**
 * 子 Agent 模式：默认阻止 dangerous/blocked。
 * 若 policy.subAgentBlockDangerous=false，仅阻止 blocked。
 */
export function isSubAgentBlocked(
  assessment: CommandRiskAssessment,
  policy?: CommandRiskPolicy | null,
): boolean {
  if (assessment.level === 'blocked') return true
  if (assessment.level === 'dangerous' && resolveSubAgentBlockDangerous(policy)) return true
  return false
}

/** 展示用风险等级 */
export function displayRiskLevel(assessment: CommandRiskAssessment): RiskLevel {
  return assessment.level
}
