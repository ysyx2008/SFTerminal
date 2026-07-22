/**
 * 待办逾期注意力（TabBar 点缀）
 *
 * - 有「尚未看过」的逾期项时闪烁
 * - 打开待办面即确认当前逾期集合；之后仅当出现新的逾期 id 再闪
 * - 持续忽视由 AI 秘书关切/心跳主动通知兜底，Tab 不必一直闪
 */
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { useTerminalStore } from '../stores/terminal'

export function useTodoOverdueCount() {
  const terminalStore = useTerminalStore()
  const overdueIds = ref<string[]>([])
  /** 上次打开待办时确认过的逾期 id */
  const acknowledgedIds = ref<Set<string>>(new Set())
  let cleanup: (() => void) | null = null

  const overdueCount = computed(() => overdueIds.value.length)

  const hasUnseenOverdue = computed(() =>
    overdueIds.value.some(id => !acknowledgedIds.value.has(id))
  )

  function acknowledgeOverdue() {
    acknowledgedIds.value = new Set(overdueIds.value)
  }

  const refresh = async () => {
    try {
      // 与后端 countOverdue 同口径：活跃 + dueDate 早于当前时刻
      const list = await window.electronAPI.todo.list({})
      const iso = new Date().toISOString()
      overdueIds.value = list
        .filter(t => !!t.dueDate && t.dueDate < iso)
        .map(t => t.id)
    } catch {
      // 角标失败不影响主功能
    }
  }

  /** 打开待办面：先拉最新逾期再确认；停留在待办面期间逾期集合变化也视为已看 */
  watch(
    () => terminalStore.todosActive,
    async active => {
      if (!active) return
      await refresh()
      acknowledgeOverdue()
    }
  )

  watch(overdueIds, () => {
    if (terminalStore.todosActive) acknowledgeOverdue()
  })

  onMounted(async () => {
    await refresh()
    cleanup = window.electronAPI.todo.onChanged(() => {
      void refresh()
    })
  })

  onUnmounted(() => {
    cleanup?.()
  })

  return { overdueCount, hasUnseenOverdue, acknowledgeOverdue, refresh }
}
