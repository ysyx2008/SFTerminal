/**
 * 助手岗：把 Agent step 流接到产出物面板（仅 AssistantWorkbench 挂载）。
 *
 * 从 useAgentMode / AiPanel 解耦：对话壳不再认识 artifactStore。
 * 首次 watch 只建指纹基线、不重放（历史恢复由 terminal 宿主 hydrate，避免双写/多余 I/O）。
 */
import { watch, onUnmounted, toValue, type MaybeRefOrGetter } from 'vue'
import { useTerminalStore } from '@/stores/terminal'
import { useAssistantArtifactStore } from '../store'

function stepArtifactFingerprint(step: {
  id: string
  type: string
  toolName?: string
  canvasData?: unknown
}): string {
  return [
    step.id,
    step.type,
    step.toolName ?? '',
    step.canvasData ? JSON.stringify(step.canvasData) : '',
  ].join('\0')
}

export function useArtifactAgentBridge(tabId: MaybeRefOrGetter<string>) {
  const terminalStore = useTerminalStore()
  const artifactStore = useAssistantArtifactStore()

  watch(
    () => {
      const id = toValue(tabId)
      const tab = terminalStore.tabs.find(t => t.id === id)
      const steps = tab?.agentState?.steps ?? []
      return {
        id,
        steps,
        fingerprints: steps.map(stepArtifactFingerprint),
      }
    },
    (curr, prev) => {
      // 首触：只建立基线。hydrate/restore 已由 desktop 宿主完成。
      if (!prev) return
      for (let i = 0; i < curr.fingerprints.length; i++) {
        if (curr.fingerprints[i] !== prev.fingerprints[i]) {
          artifactStore.handleAgentStep(curr.id, curr.steps[i], curr.steps)
        }
      }
    },
  )

  onUnmounted(() => {
    artifactStore.cleanup(toValue(tabId))
  })
}
