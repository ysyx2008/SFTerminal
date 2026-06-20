import { onMounted, ref, type MaybeRefOrGetter, toValue } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  bondTrustAtLeast,
  COMPOSER_PLACEHOLDER_POOL_GATES,
  type BondTrustLevel,
} from '@shared/types/bond'

async function loadBondTrustLevel(): Promise<BondTrustLevel> {
  try {
    const metrics = await window.electronAPI?.bond?.getMetrics?.()
    return metrics?.trustLevel ?? 'stranger'
  } catch {
    return 'stranger'
  }
}

/** 从分池 i18n 对象收集当前羁绊等级可用的 placeholder 文案 */
export function collectEligiblePlaceholders(
  pools: unknown,
  trustLevel: BondTrustLevel
): string[] {
  if (!pools || typeof pools !== 'object') return []
  const eligible: string[] = []
  for (const [poolName, items] of Object.entries(pools as Record<string, unknown>)) {
    if (!Array.isArray(items)) continue
    const minTrust = COMPOSER_PLACEHOLDER_POOL_GATES[poolName] ?? 'stranger'
    if (!bondTrustAtLeast(trustLevel, minTrust)) continue
    for (const item of items) {
      if (typeof item === 'string' && item.trim()) eligible.push(item)
    }
  }
  return eligible
}

/**
 * 按羁绊阶段从多池 i18n 对象随机挑选输入框 placeholder。
 * pools 结构见 ai.inputPlaceholderPools / welcome.chatLeadPools。
 */
export function useRandomPlaceholder(
  poolsKey: MaybeRefOrGetter<string>,
  fallbackKey: MaybeRefOrGetter<string>
) {
  const { t, tm } = useI18n()
  const value = ref('')

  const pick = async () => {
    const trustLevel = await loadBondTrustLevel()
    const eligible = collectEligiblePlaceholders(tm(toValue(poolsKey)), trustLevel)
    const fallback = toValue(fallbackKey)
    if (eligible.length > 0) {
      value.value = eligible[Math.floor(Math.random() * eligible.length)]
    } else {
      value.value = t(fallback)
    }
  }

  onMounted(() => {
    void pick()
  })

  return { value, pick }
}
