import { ref, type ComputedRef, type Ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useConfigStore, type SshSession, type SessionGroup } from '../stores/config'
import type { GroupedSessions } from './useSessionList'

export function useSessionDragDrop(
  groupedSessions: ComputedRef<GroupedSessions>,
  collapsedGroups: Ref<Set<string>>
) {
  const { t } = useI18n()
  const configStore = useConfigStore()

  // 拖拽前保存的折叠状态
  const savedCollapsedState = ref<Set<string> | null>(null)

  const draggingSession = ref<SshSession | null>(null)
  const dragOverGroupName = ref<string | null>(null)
  const dragOverSessionId = ref<string | null>(null)
  const dragOverPosition = ref<'before' | 'after'>('before')
  const draggingGroupName = ref<string | null>(null)
  const dragOverTargetGroupName = ref<string | null>(null)

  const handleDragStart = (session: SshSession, event: DragEvent) => {
    draggingSession.value = session
    draggingGroupName.value = null
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move'
      event.dataTransfer.setData('text/plain', session.id)
      event.dataTransfer.setData('application/x-session', 'true')
    }
    const target = event.target as HTMLElement
    setTimeout(() => { target.classList.add('dragging') }, 0)
  }

  const handleGroupDragStart = (groupName: string, event: DragEvent) => {
    draggingGroupName.value = groupName
    draggingSession.value = null

    // dataTransfer 必须在 dragstart 同步阶段设置，否则浏览器可能当作无效拖拽直接取消
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move'
      event.dataTransfer.setData('text/plain', groupName)
      event.dataTransfer.setData('application/x-group', 'true')
    }

    // 折叠所有分组是为了方便用户对齐目标位置，但如果在 dragstart 同步阶段改 DOM，
    // 上方分组回缩导致被拖元素视觉位置偏移，Chromium 会中断拖拽（除第一个分组外都拖不动）。
    // 因此延后到下一个宏任务，等 dragstart 完全进入拖拽会话再折叠。
    savedCollapsedState.value = new Set(collapsedGroups.value)
    const allGroupNames = Object.keys(groupedSessions.value)
    const target = event.target as HTMLElement
    setTimeout(() => {
      allGroupNames.forEach(name => { collapsedGroups.value.add(name) })
      target.classList.add('dragging')
    }, 0)
  }

  const handleDragEnd = async (event: DragEvent) => {
    // 落点在非有效 drop 区域（如 session-list 空白处、窗口边缘）时，浏览器不触发 drop 事件，
    // 但用户预期的落点其实在最后显示的指示线位置。这里用最后一次落点指示位置作为兜底。
    if (draggingGroupName.value && dragOverTargetGroupName.value) {
      await applyGroupReorder(dragOverTargetGroupName.value, dragOverPosition.value)
    }

    if (savedCollapsedState.value !== null) {
      collapsedGroups.value = new Set(savedCollapsedState.value)
      savedCollapsedState.value = null
    }

    draggingSession.value = null
    draggingGroupName.value = null
    dragOverGroupName.value = null
    dragOverSessionId.value = null
    dragOverTargetGroupName.value = null
    const target = event.target as HTMLElement
    target.classList.remove('dragging')
  }

  const handleDragOverGroup = (groupName: string, event: DragEvent) => {
    event.preventDefault()
    if (event.dataTransfer) { event.dataTransfer.dropEffect = 'move' }
    dragOverGroupName.value = groupName
  }

  const handleDragOverSession = (sessionId: string, event: DragEvent) => {
    event.preventDefault()
    event.stopPropagation()
    if (event.dataTransfer) { event.dataTransfer.dropEffect = 'move' }
    dragOverSessionId.value = sessionId

    const target = event.currentTarget as HTMLElement
    const rect = target.getBoundingClientRect()
    const mouseY = event.clientY
    const threshold = rect.top + rect.height / 2
    dragOverPosition.value = mouseY < threshold ? 'before' : 'after'
  }

  const handleDragLeaveGroup = () => {
    dragOverGroupName.value = null
  }

  const handleDragOverGroupHeader = (targetGroupName: string, event: DragEvent) => {
    event.preventDefault()
    if (event.dataTransfer) { event.dataTransfer.dropEffect = 'move' }

    if (draggingGroupName.value) {
      event.stopPropagation()
      dragOverTargetGroupName.value = targetGroupName
      const target = event.currentTarget as HTMLElement
      const rect = target.getBoundingClientRect()
      dragOverPosition.value = event.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
    } else if (draggingSession.value) {
      dragOverGroupName.value = targetGroupName
    }
  }

  const applyGroupReorder = async (targetGroupName: string, position: 'before' | 'after') => {
    if (!draggingGroupName.value) return
    if (draggingGroupName.value === targetGroupName) {
      draggingGroupName.value = null
      return
    }

    const defaultGroupName = t('session.defaultGroup')
    const defaultGroupOrder = configStore.defaultGroupSortOrder

    type SortItem = { name: string; order: number; group: SessionGroup | null }
    const sortItems: SortItem[] = []

    const sortedGroupList = [...configStore.sessionGroups].sort((a, b) =>
      (a.sortOrder ?? Infinity) - (b.sortOrder ?? Infinity)
    )
    sortedGroupList.forEach(g => {
      sortItems.push({ name: g.name, order: g.sortOrder ?? Infinity, group: g })
    })

    sortItems.push({
      name: defaultGroupName,
      order: defaultGroupOrder === -1 ? Infinity : defaultGroupOrder,
      group: null
    })

    sortItems.sort((a, b) => a.order - b.order)

    const dragIndex = sortItems.findIndex(item => item.name === draggingGroupName.value)
    const dropIndex = sortItems.findIndex(item => item.name === targetGroupName)

    if (dragIndex === -1 || dropIndex === -1) {
      draggingGroupName.value = null
      return
    }

    const [movedItem] = sortItems.splice(dragIndex, 1)
    // splice 前目标位置 dropIndex；若 drag 原本在目标之前，splice 删除后
    // 目标现在在 dropIndex-1，插入 before 用 dropIndex-1、after 用 dropIndex。
    const afterAdjust = dragIndex < dropIndex ? -1 : 0
    const insertIndex = dropIndex + afterAdjust + (position === 'after' ? 1 : 0)
    sortItems.splice(insertIndex, 0, movedItem)

    const updates: { id: string; sortOrder: number }[] = []
    let newDefaultGroupOrder = -1

    sortItems.forEach((item, index) => {
      if (item.group) {
        updates.push({ id: item.group.id, sortOrder: index })
      } else if (item.name === defaultGroupName) {
        newDefaultGroupOrder = index
      }
    })

    if (updates.length > 0) {
      await configStore.updateGroupsSortOrder(updates)
    }

    if (newDefaultGroupOrder !== configStore.defaultGroupSortOrder) {
      await configStore.setDefaultGroupSortOrder(newDefaultGroupOrder)
    }

    draggingGroupName.value = null
  }

  const handleDropToGroupHeader = async (targetGroupName: string, event: DragEvent) => {
    event.preventDefault()
    dragOverTargetGroupName.value = null

    if (!draggingGroupName.value) {
      if (draggingSession.value) {
        await handleDropToGroup(targetGroupName, event)
      }
      return
    }

    event.stopPropagation()
    await applyGroupReorder(targetGroupName, dragOverPosition.value)
  }

  const handleDropToSession = async (targetSessionId: string, groupName: string, event: DragEvent) => {
    event.preventDefault()
    event.stopPropagation()
    dragOverSessionId.value = null
    dragOverGroupName.value = null

    if (!draggingSession.value || draggingSession.value.id === targetSessionId) {
      return
    }

    if (configStore.sessionSortBy !== 'custom') {
      await configStore.setSessionSortBy('custom')
    }

    const groupData = groupedSessions.value[groupName]
    if (!groupData) return

    const targetGroupId = groupData.group?.id
    const sourceGroupId = draggingSession.value.groupId
    const isCrossGroup = sourceGroupId !== targetGroupId
    const draggedSessionId = draggingSession.value.id

    const targetGroupSessions = configStore.sshSessions.filter(s => {
      if (s.id === draggedSessionId) return false
      const gId = s.groupId
      return gId === targetGroupId || (!gId && !targetGroupId)
    })

    const sortedSessions = [...targetGroupSessions].sort((a, b) =>
      (a.sortOrder ?? Infinity) - (b.sortOrder ?? Infinity)
    )

    const dropIndex = sortedSessions.findIndex(s => s.id === targetSessionId)
    if (dropIndex === -1) return

    const insertIndex = dragOverPosition.value === 'before' ? dropIndex : dropIndex + 1

    const newOrder: string[] = sortedSessions.map(s => s.id)
    newOrder.splice(insertIndex, 0, draggedSessionId)

    if (isCrossGroup) {
      await configStore.updateSshSession({
        ...draggingSession.value,
        groupId: targetGroupId,
        group: undefined,
        sortOrder: dropIndex
      })
    }

    const updates: { id: string; sortOrder: number }[] = newOrder.map((id, index) => ({
      id,
      sortOrder: index
    }))

    await configStore.updateSessionsSortOrder(updates)
  }

  const handleDropToGroup = async (groupName: string, event: DragEvent) => {
    event.preventDefault()
    dragOverGroupName.value = null

    if (draggingGroupName.value) return
    if (!draggingSession.value) return

    const session = draggingSession.value
    const groupData = groupedSessions.value[groupName]

    let targetGroupId: string | undefined = undefined
    if (groupData?.group) {
      targetGroupId = groupData.group.id
    }

    const currentGroupId = session.groupId || undefined
    if (currentGroupId === targetGroupId) {
      draggingSession.value = null
      return
    }

    const targetGroupSessions = configStore.sshSessions.filter(s => s.groupId === targetGroupId)
    const maxOrder = Math.max(...targetGroupSessions.map(s => s.sortOrder ?? 0), -1)

    await configStore.updateSshSession({
      ...session,
      groupId: targetGroupId,
      group: undefined,
      sortOrder: maxOrder + 1
    })

    draggingSession.value = null
  }

  return {
    draggingSession,
    dragOverGroupName,
    dragOverSessionId,
    dragOverPosition,
    draggingGroupName,
    dragOverTargetGroupName,
    handleDragStart,
    handleGroupDragStart,
    handleDragEnd,
    handleDragOverGroup,
    handleDragOverSession,
    handleDragLeaveGroup,
    handleDragOverGroupHeader,
    handleDropToGroupHeader,
    handleDropToSession,
    handleDropToGroup,
  }
}
