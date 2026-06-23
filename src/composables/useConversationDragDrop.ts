import { ref, type Ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { AgentRecord } from '@shared/types'
import { useTerminalStore } from '../stores/terminal'
import { toast } from './useToast'

export const CONVERSATION_DRAG_MIME = 'application/x-sailfish-conversation'

export function isConversationDragEvent(event: DragEvent): boolean {
  return !!event.dataTransfer?.types.includes(CONVERSATION_DRAG_MIME)
}

export function beginConversationDrag(event: DragEvent, sessionId: string): void {
  if (!event.dataTransfer) return
  event.dataTransfer.effectAllowed = 'copy'
  event.dataTransfer.setData('text/plain', sessionId)
  event.dataTransfer.setData(CONVERSATION_DRAG_MIME, sessionId)
}

export function readConversationDragId(event: DragEvent): string | null {
  if (!isConversationDragEvent(event)) return null
  return (
    event.dataTransfer?.getData(CONVERSATION_DRAG_MIME) ||
    event.dataTransfer?.getData('text/plain') ||
    null
  )
}

export function useOpenConversationInTab(openingIdRef?: Ref<string | null>) {
  const { t } = useI18n()
  const terminalStore = useTerminalStore()
  const internalOpeningId = ref<string | null>(null)

  async function openConversationInTab(sessionId: string): Promise<boolean> {
    if (openingIdRef?.value || internalOpeningId.value) return false

    const existingTab = terminalStore.findTabByHistoryId(sessionId)
    if (existingTab) {
      terminalStore.promoteConversationToTab(existingTab.id)
      return true
    }

    if (openingIdRef) openingIdRef.value = sessionId
    else internalOpeningId.value = sessionId
    try {
      const fullRecord = (await window.electronAPI.history.getAgentRecordById(sessionId)) as
        | AgentRecord
        | undefined
      if (!fullRecord) {
        toast.error(t('ai.agentWelcome.historyRecordMissing'))
        return false
      }
      const tabId = terminalStore.openHistoryConversation(fullRecord)
      terminalStore.promoteConversationToTab(tabId)
      return true
    } catch (e) {
      console.error('Failed to open conversation in tab:', e)
      toast.error(t('ai.agentWelcome.historyRecordMissing'))
      return false
    } finally {
      if (openingIdRef) openingIdRef.value = null
      else internalOpeningId.value = null
    }
  }

  return { openConversationInTab }
}

export function useConversationDropTarget(onDrop: (sessionId: string) => void | Promise<void>) {
  const isDragOver = ref(false)
  let dragEndListener: (() => void) | null = null

  const clearDragEndListener = () => {
    if (!dragEndListener) return
    document.removeEventListener('dragend', dragEndListener)
    dragEndListener = null
  }

  const resetDragOver = () => {
    isDragOver.value = false
    clearDragEndListener()
  }

  const ensureDragEndListener = () => {
    if (dragEndListener) return
    dragEndListener = () => resetDragOver()
    document.addEventListener('dragend', dragEndListener)
  }

  const handleDragEnter = (event: DragEvent) => {
    if (!isConversationDragEvent(event)) return
    event.preventDefault()
    isDragOver.value = true
    ensureDragEndListener()
  }

  const handleDragOver = (event: DragEvent) => {
    if (!isConversationDragEvent(event)) return
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
    isDragOver.value = true
  }

  const handleDragLeave = (event: DragEvent) => {
    if (!isDragOver.value) return
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
    const { clientX: x, clientY: y } = event
    if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) {
      resetDragOver()
    }
  }

  const handleDrop = async (event: DragEvent) => {
    if (!isConversationDragEvent(event)) return
    event.preventDefault()
    event.stopPropagation()
    resetDragOver()
    const sessionId = readConversationDragId(event)
    if (sessionId) await onDrop(sessionId)
  }

  return {
    isDragOver,
    handleDragEnter,
    handleDragOver,
    handleDragLeave,
    handleDrop,
  }
}
