/**
 * 风险等级 × 执行模式 确认策略
 *
 * 工具/技能只负责评估出 RiskLevel，是否弹窗统一走本模块：
 * - riskNeedsConfirm：通用工具 / 命令共用策略
 * - commandNeedsConfirm：对 assessment 的薄封装（委托 riskNeedsConfirm）
 *
 * strict：全部确认（含 safe）
 * relaxed：默认只确认 dangerous / blocked；
 *          若 riskPolicy.relaxedConfirmModerate=true，则 moderate 也确认。
 * free：不确认（用户自担）。
 */
import type { RiskLevel, ExecutionMode, CommandRiskPolicy } from '@shared/types/agent'
import type { CommandRiskAssessment } from './types'
import { resolveSubAgentBlockDangerous } from './fail-closed-policy'

/**
 * 通用确认策略：工具先评估 riskLevel，再据此 + executionMode 决定是否弹窗。
 *
 * - strict：全部确认（含 safe）
 * - free：不确认
 * - relaxed：dangerous / blocked；可选 moderate；safe 不确认
 */
export function riskNeedsConfirm(
  level: RiskLevel,
  executionMode: ExecutionMode,
  policy?: CommandRiskPolicy | null,
): boolean {
  if (executionMode === 'strict') return true
  if (executionMode === 'free') return false
  if (level === 'blocked' || level === 'dangerous') return true
  if (level === 'moderate' && policy?.relaxedConfirmModerate) return true
  return false
}

/** 命令执行确认策略（委托 riskNeedsConfirm）。 */
export function commandNeedsConfirm(
  assessment: CommandRiskAssessment,
  executionMode: ExecutionMode,
  policy?: CommandRiskPolicy | null,
): boolean {
  return riskNeedsConfirm(assessment.level, executionMode, policy)
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
