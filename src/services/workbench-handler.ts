/**
 * 工作台反向 IPC 处理器（渲染进程）
 */
import { useTerminalStore } from '../stores/terminal'
import { useCanvasStore } from '../stores/canvas'
import { buildAssistantArtifactSnapshot } from '../workbench/assistant/snapshot'
import { createLogger } from '../utils/logger'

const log = createLogger('WorkbenchHandler')

type WorkbenchOp = { type: 'list_artifacts' }

let unsubscribe: (() => void) | null = null

function resolveTabId(store: ReturnType<typeof useTerminalStore>, ownerAgentKey?: string): string | undefined {
  if (ownerAgentKey) {
    const byAgent = store.findTabIdByAgentId(ownerAgentKey)
    if (byAgent) return byAgent
    const byPty = store.findTabIdByPtyId(ownerAgentKey)
    if (byPty) return byPty
    return undefined
  }
  return store.activeTab?.id
}

export function initWorkbenchHandler(): void {
  if (unsubscribe) return
  if (!window.electronAPI?.workbench?.onExec) {
    log.warn('electronAPI.workbench unavailable, skip init')
    return
  }

  log.info('workbench handler initialized')
  unsubscribe = window.electronAPI.workbench.onExec((id, op, ownerAgentKey) => {
    void (async () => {
      let result: { ok: boolean; data?: unknown; error?: string }
      try {
        const terminalStore = useTerminalStore()
        const tabId = resolveTabId(terminalStore, ownerAgentKey)
        if (!tabId) {
          result = { ok: false, error: `No tab found for agentKey=${ownerAgentKey || 'active'}` }
        } else {
          const tab = terminalStore.tabs.find(t => t.id === tabId)
          if (!tab || tab.type !== 'assistant') {
            result = { ok: false, error: 'list_workbench_artifacts 仅适用于独立助手工作台 tab' }
          } else {
            const canvasStore = useCanvasStore()
            const state = canvasStore.getTabState(tabId)
            result = {
              ok: true,
              data: buildAssistantArtifactSnapshot(tabId, state)
            }
          }
        }
      } catch (e) {
        result = { ok: false, error: e instanceof Error ? e.message : String(e) }
      }

      try {
        window.electronAPI.workbench.sendResult(id, result)
      } catch (e) {
        log.error(`sendResult failed id=${id}`, e)
      }
    })()
  })
}

export function disposeWorkbenchHandler(): void {
  unsubscribe?.()
  unsubscribe = null
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    disposeWorkbenchHandler()
  })
}
