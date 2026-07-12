import type { ComposerTranslation } from 'vue-i18n'
import {
  isBondMilestoneId,
  type BondMetrics,
  type BondMilestoneId,
} from '@shared/types/bond'
import { toast } from './useToast'

const TOAST_DURATION_MS = 5000
const STAGGER_MS = 400

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export function formatBondMilestoneToast(
  t: ComposerTranslation,
  id: BondMilestoneId,
  metrics: Pick<BondMetrics, 'daysTogether' | 'level'>
): string {
  const title = t(`bond.milestone.${id}.title`)
  const body = t(`bond.milestone.${id}.body`, {
    days: metrics.daysTogether,
    level: metrics.level,
  })
  return `${title} — ${body}`
}

/** 依次弹出羁绊里程碑 toast（多条时间错开，避免叠在一起） */
export async function showBondMilestoneToasts(
  t: ComposerTranslation,
  milestoneIds: string[],
  metrics: Pick<BondMetrics, 'daysTogether' | 'level'>
): Promise<void> {
  const unique = [...new Set(milestoneIds)].filter(isBondMilestoneId)
  for (let i = 0; i < unique.length; i++) {
    if (i > 0) await sleep(STAGGER_MS)
    toast.success(formatBondMilestoneToast(t, unique[i], metrics), TOAST_DURATION_MS)
  }
}

/** 启动时检查是否有新解锁的里程碑（main 进程不再抢先 recalculate，由前端统一展示） */
export async function checkBondMilestonesOnStartup(
  t: ComposerTranslation
): Promise<void> {
  try {
    const result = await window.electronAPI?.bond?.recalculate?.()
    if (!result?.newMilestones?.length || !result.metrics) return
    await showBondMilestoneToasts(t, result.newMilestones, result.metrics)
  } catch {
    // 非 Electron / CLI 环境下忽略
  }
}
