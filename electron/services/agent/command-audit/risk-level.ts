import type { RiskLevel } from '@shared/types/agent'

const RISK_ORDER: Record<RiskLevel, number> = {
  safe: 0,
  moderate: 1,
  dangerous: 2,
  blocked: 3,
}

/** 取较高风险等级 */
export function maxRisk(a: RiskLevel, b: RiskLevel): RiskLevel {
  return RISK_ORDER[a] >= RISK_ORDER[b] ? a : b
}

/** 多条结果聚合 */
export function maxRiskAll(levels: RiskLevel[]): RiskLevel {
  let result: RiskLevel = 'safe'
  for (const l of levels) {
    result = maxRisk(result, l)
  }
  return result
}
