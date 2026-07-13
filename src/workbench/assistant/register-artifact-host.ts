/**
 * desktop：为助手产出物注册宿主能力（steps / 激活态 / 历史持久化）。
 * 在 workbench registry 加载时调用一次即可。
 */
import { registerArtifactDesktopHost } from '@sailfish/workbench-assistant/artifact'
import { useTerminalStore } from '../../stores/terminal'

let registered = false

export function ensureAssistantArtifactHostRegistered(): void {
  if (registered) return
  registered = true
  registerArtifactDesktopHost({
    getAgentSteps(tabId) {
      return useTerminalStore().getAgentState(tabId)?.steps ?? []
    },
    isTabActive(tabId) {
      return useTerminalStore().activeTabId === tabId
    },
    persistArtifacts(tabId) {
      useTerminalStore().saveArtifactsToHistory(tabId)
    },
  })
}
