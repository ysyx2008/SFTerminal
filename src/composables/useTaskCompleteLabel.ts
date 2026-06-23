import type { ComposerTranslation } from 'vue-i18n'
import { TASK_COMPLETE_FUN_CHANCE } from '@shared/types/ai'
import type { BondTrustLevel } from '@shared/types/bond'
import { collectEligiblePlaceholders } from './useRandomPlaceholder'

/** 从 taskCompletePools 挑选 footer 文案：约 92% default，8% 羁绊分池趣味句 */
export function pickTaskCompleteLabel(
  pools: unknown,
  trustLevel: BondTrustLevel,
  t: ComposerTranslation
): string {
  const poolObj = pools && typeof pools === 'object' ? (pools as Record<string, unknown>) : {}
  const defaultPool = Array.isArray(poolObj.default)
    ? (poolObj.default as string[]).filter(s => typeof s === 'string' && s.trim())
    : []

  if (Math.random() >= TASK_COMPLETE_FUN_CHANCE) {
    if (defaultPool.length > 0) {
      return defaultPool[Math.floor(Math.random() * defaultPool.length)]
    }
    return t('ai.taskComplete')
  }

  const funPools: Record<string, unknown> = { ...poolObj }
  delete funPools.default
  const eligible = collectEligiblePlaceholders(funPools, trustLevel)
  if (eligible.length === 0) {
    if (defaultPool.length > 0) {
      return defaultPool[Math.floor(Math.random() * defaultPool.length)]
    }
    return t('ai.taskComplete')
  }
  return eligible[Math.floor(Math.random() * eligible.length)]
}
