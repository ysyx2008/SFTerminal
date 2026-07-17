import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { BondMetrics } from '@shared/types/bond'
import { isOemFeatureEnabled } from '@shared/oem-features'
import { collectEligiblePlaceholders } from './useRandomPlaceholder'

function applyBondLineParams(line: string, metrics: BondMetrics | null | undefined): string {
  if (!metrics) return line.replace(/\{days\}/g, '0')
  return line.replace(/\{days\}/g, String(metrics.daysTogether))
}

/** 欢迎页副标题：按羁绊从 subtitlePools 随机一条（Steam 版仍用固定 subtitleSteam） */
export function useWelcomeSubtitle(isSteamBuild: boolean) {
  const { t, tm } = useI18n()
  const value = ref(
    t(isSteamBuild ? 'welcome.subtitleSteam' : 'welcome.subtitle')
  )

  onMounted(() => {
    if (isSteamBuild || !isOemFeatureEnabled('bond')) return
    void (async () => {
      try {
        const metrics = await window.electronAPI?.bond?.getMetrics?.()
        const trustLevel = metrics?.trustLevel ?? 'stranger'
        const eligible = collectEligiblePlaceholders(tm('welcome.subtitlePools'), trustLevel)
        const fallback = t('welcome.subtitle')
        const raw = eligible.length > 0
          ? eligible[Math.floor(Math.random() * eligible.length)]
          : fallback
        value.value = applyBondLineParams(raw, metrics)
      } catch {
        value.value = t('welcome.subtitle')
      }
    })()
  })

  return value
}

export { applyBondLineParams }
