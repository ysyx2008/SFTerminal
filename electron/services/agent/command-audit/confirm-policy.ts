/**
 * 命令执行确认策略
 *
 * relaxed：只确认 dangerous / blocked，陌生命令（hasUnknown）不再确认--
 *          避免给用户造成"中风险也要确认"的噪音，未识别命令静默放行。
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
  return assessment.level === 'blocked' || assessment.level === 'dangerous'
}

/** 子 Agent 模式：与主 Agent relaxed 一致，只阻止 dangerous/blocked */
export function isSubAgentBlocked(
  assessment: CommandRiskAssessment,
): boolean {
  return assessment.level === 'dangerous' || assessment.level === 'blocked'
}

/** 展示用风险等级：未知但 moderate 时仍显示 moderate（非 dangerous） */
export function displayRiskLevel(assessment: CommandRiskAssessment): RiskLevel {
  return assessment.level
}
