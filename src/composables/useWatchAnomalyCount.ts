import { ref, onMounted, onUnmounted } from 'vue'

/** 内置心跳 Watch，不计入用户可见的异常数 */
const BUILTIN_WATCH_IDS = new Set(['__wakeup__', '__daily_patrol__'])

/**
 * 轻量 composable：维护当前异常（failed / timeout）关切数量。
 *
 * - mount 时从后端拉取一次全量数据
 * - 每次 watch:task-completed 事件触发后刷新，确保徽章实时更新
 * - 忽略内置心跳（__wakeup__ / __daily_patrol__）
 */
export function useWatchAnomalyCount() {
  const anomalyCount = ref(0)
  let cleanupCompleted: (() => void) | null = null

  const refresh = async () => {
    try {
      const watches = await window.electronAPI.watch.getAll()
      anomalyCount.value = watches.filter(
        w =>
          !BUILTIN_WATCH_IDS.has(w.id) &&
          w.enabled &&
          (w.lastRun?.status === 'failed' || w.lastRun?.status === 'timeout'),
      ).length
    } catch {
      // 静默忽略：WelcomePage 里的角标不影响主功能
    }
  }

  onMounted(async () => {
    await refresh()
    cleanupCompleted =
      window.electronAPI.watch.onTaskCompleted?.(() => {
        refresh()
      }) ?? null
  })

  onUnmounted(() => {
    cleanupCompleted?.()
  })

  return { anomalyCount }
}
