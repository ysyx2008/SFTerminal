/**
 * 待办逾期数量（TabBar 注意力点缀）
 */
import { ref, onMounted, onUnmounted } from 'vue'

export function useTodoOverdueCount() {
  const overdueCount = ref(0)
  let cleanup: (() => void) | null = null

  const refresh = async () => {
    try {
      overdueCount.value = await window.electronAPI.todo.countOverdue()
    } catch {
      // 角标失败不影响主功能
    }
  }

  onMounted(async () => {
    await refresh()
    cleanup = window.electronAPI.todo.onChanged(() => {
      void refresh()
    })
  })

  onUnmounted(() => {
    cleanup?.()
  })

  return { overdueCount, refresh }
}
