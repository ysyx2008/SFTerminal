import type { WorkbenchArtifactSnapshot } from '@shared/types'
import {
  getActiveArtifact,
  getArtifacts,
  isPanelVisible,
  type TabArtifactState
} from '@sailfish/workbench-assistant/artifact'

export function buildAssistantArtifactSnapshot(
  tabId: string,
  state: TabArtifactState,
  dirtyOf: (artifactId: string) => boolean = () => false
): WorkbenchArtifactSnapshot {
  const artifacts = getArtifacts(state)
  const active = getActiveArtifact(state)
  return {
    workbenchKind: 'assistant',
    tabId,
    panelVisible: isPanelVisible(state),
    activeArtifactId: active?.id ?? null,
    artifacts: artifacts.map(a => ({
      id: a.id,
      title: a.title,
      renderer: a.renderer,
      filePath: a.filePath ?? null,
      updatedAt: a.updatedAt,
      dirty: dirtyOf(a.id)
    }))
  }
}
