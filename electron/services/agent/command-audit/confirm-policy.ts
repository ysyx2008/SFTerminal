/**
 * 风险等级 × 执行模式 确认策略
 *
 * 工具/技能只负责评估出 RiskLevel，是否弹窗统一走本模块：
 * - riskNeedsConfirm：通用工具策略（safe 永不确认）
 * - commandNeedsConfirm：命令路径（strict 下连 safe 也确认）
 *
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
 * - safe：永不确认（留给明确无害的操作，如工作区自动放行路径）
 * - strict：凡非 safe 均确认
 * - free：不确认
 * - relaxed：dangerous / blocked；可选 moderate
 */
export function riskNeedsConfirm(
  level: RiskLevel,
  executionMode: ExecutionMode,
  policy?: CommandRiskPolicy | null,
): boolean {
  if (level === 'safe') return false
  if (executionMode === 'strict') return true
  if (executionMode === 'free') return false
  if (level === 'blocked' || level === 'dangerous') return true
  if (level === 'moderate' && policy?.relaxedConfirmModerate) return true
  return false
}

/**
 * 命令执行确认策略。
 * strict 下连评估为 safe 的读命令也确认（与 riskNeedsConfirm 的唯一差异）。
 */
export function commandNeedsConfirm(
  assessment: CommandRiskAssessment,
  executionMode: ExecutionMode,
  policy?: CommandRiskPolicy | null,
): boolean {
  if (executionMode === 'strict') return true
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
