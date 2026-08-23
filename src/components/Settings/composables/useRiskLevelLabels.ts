/**
 * 风险等级的显示文案与配色标记。
 *
 * 「命令规则」页（规则表里的等级标签、新建规则的等级下拉）和「风险策略」页
 * （处置矩阵里可选的等级）都要把同一批等级显示给用户。两页各写一份的话，
 * 同一个 dangerous 迟早在一页叫「危险」、在另一页叫别的。
 */
import { useI18n } from 'vue-i18n'
import type { RiskLevel } from '@shared/types/agent'

/** 策略矩阵里允许指定的处置档位——safe 不作为处置结果出现 */
export const POLICY_ALLOWED_LEVELS: RiskLevel[] = ['moderate', 'dangerous', 'blocked']

export function useRiskLevelLabels() {
  const { t } = useI18n()

  function riskLabel(level: RiskLevel): string {
    if (level === 'blocked') return t('settings.security.builtinRules.groupBlocked')
    if (level === 'dangerous') return t('ai.highRisk')
    if (level === 'moderate') return t('ai.mediumRisk')
    return t('ai.lowRisk')
  }

  function riskClass(level: RiskLevel): string {
    return `risk-${level}`
  }

  return { riskLabel, riskClass }
}
