/**
 * 解析失败 / 未知命令 的等级选择（按 executionMode + 用户配置的 riskPolicy）
 *
 * 设计：
 * - 等级本身是命令固有属性，但"解析失败"和"未知命令"是兜底场景，
 *   其等级由用户配置决定（默认 strict->dangerous、relaxed->moderate）。
 * - free 模式跟随 relaxed 配置（free 本就不确认，等级仅影响 UI 展示色）。
 * - AuditContext 不带 policy 时回退默认值，保证旧调用方行为不变。
 */
import type { RiskLevel, ExecutionMode, CommandRiskPolicy } from '@shared/types/agent'
import { DEFAULT_COMMAND_RISK_POLICY } from '@shared/types/agent'
import type { AuditContext } from './types'

export type FailClosedKind = 'parseFail' | 'unknownCmd'

/**
 * 按 executionMode + riskPolicy 选档位。
 *
 * - executionMode 缺省 -> 按 'relaxed' 取（向后兼容旧调用方，relaxed 行为更宽容）
 * - riskPolicy 缺省 -> DEFAULT_COMMAND_RISK_POLICY
 */
export function resolveFailClosedLevel(
  kind: FailClosedKind,
  ctx?: AuditContext,
): RiskLevel {
  const mode: ExecutionMode = ctx?.executionMode ?? 'relaxed'
  const policy: CommandRiskPolicy = ctx?.riskPolicy ?? DEFAULT_COMMAND_RISK_POLICY

  // free 跟随 relaxed 配置
  const effMode: ExecutionMode = mode === 'free' ? 'relaxed' : mode

  if (kind === 'parseFail') {
    return effMode === 'strict' ? policy.strictParseFail : policy.relaxedParseFail
  }
  return effMode === 'strict' ? policy.strictUnknownCmd : policy.relaxedUnknownCmd
}
