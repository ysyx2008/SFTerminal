/**
 * 助手岗：把 Agent step 流接到产出物面板（仅 AssistantWorkbench 挂载）。
 *
 * 经 ArtifactDesktopHost 读 steps，不直引 terminalStore。
 * 首次 watch 只建指纹基线、不重放（历史恢复由 desktop 宿主 hydrate）。
 */
import { watch, onUnmounted, toValue, type MaybeRefOrGetter } from 'vue'
import { useAssistantArtifactStore } from '../store'
import { requireArtifactDesktopHost } from '../host'

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
  const artifactStore = useAssistantArtifactStore()
  const host = requireArtifactDesktopHost()

  watch(
    () => {
      const id = toValue(tabId)
      const steps = host.getAgentSteps(id)
      return {
        id,
        steps,
        fingerprints: steps.map(stepArtifactFingerprint),
      }
    },
    (curr, prev) => {
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
