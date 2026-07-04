/**
 * 命令执行确认策略
 *
 * relaxed：dangerous 确认 + 未识别命令（hasUnknown）也确认，避免 silent 执行陌生命令。
 * free：不确认（用户自担）。
 */
import type { RiskLevel } from '@shared/types/agent'
import type { CommandRiskAssessment } from './types'

export function commandNeedsConfirm(
  assessment: CommandRiskAssessment,
  executionMode: 'strict' | 'relaxed' | 'free',
): boolean {
  if (executionMode === 'strict') return true
  if (executionMode === 'free') return false
  if (assessment.level === 'blocked' || assessment.level === 'dangerous') return true
  if (assessment.hasUnknown) return true
  return false
}

/** 子 Agent 模式：dangerous 或未知命令均阻止自动执行 */
export function isSubAgentBlocked(
  assessment: CommandRiskAssessment,
): boolean {
  return assessment.level === 'dangerous' || assessment.hasUnknown === true
}

/** 展示用风险等级：未知但 moderate 时仍显示 moderate（非 dangerous） */
export function displayRiskLevel(assessment: CommandRiskAssessment): RiskLevel {
  return assessment.level
}
