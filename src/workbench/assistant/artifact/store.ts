/**
 * 助手工作台产出物面板 — Pinia 适配层
 *
 * 领域逻辑在 `domain/artifact-registry.ts`（纯函数）；
 * 本 store 只负责 assistant tab 级 state 容器、布局比例与 Agent step 分发。
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { CanvasArtifact, CanvasData } from '@shared/types'
import type { AgentStep } from '@shared/types'
import {
  applyCanvasData,
  clearTabArtifacts,
  createTabArtifactState,
  dismissEmptyPanel,
  enrichCanvasDataFromStep,
  getActiveArtifact,
  getArtifactById,
  getArtifacts,
  hydrateArtifactsFromSteps,
  isArtifactEmptyState,
  isPanelVisible,
  removeArtifact,
  setActiveArtifact,
  updateArtifactContentById,
  type TabArtifactState
} from './domain/artifact-registry'
import {
  findArtifactIdsWithMissingFiles,
  refreshFilePathExistsMap
} from './domain/artifact-file-status'
import { shouldSyncArtifactsAfterStep } from './domain/artifact-disk-sync'

export interface ArtifactDiskSyncEvent {
  tabId: string
  removed: CanvasArtifact[]
  at: number
}

export interface ArtifactSourceJumpRequest {
  tabId: string
  stepId: string
}

export const useAssistantArtifactStore = defineStore('assistantArtifact', () => {
  const tabStates = ref<Map<string, TabArtifactState>>(new Map())
  const splitRatio = ref(0.5)
  const closeTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const lastDiskSync = ref<ArtifactDiskSyncEvent | null>(null)
  const sourceJumpRequest = ref<ArtifactSourceJumpRequest | null>(null)

  function getTabState(tabId: string): TabArtifactState {
    if (!tabStates.value.has(tabId)) {
      tabStates.value.set(tabId, createTabArtifactState())
    }
    return tabStates.value.get(tabId)!
  }

  function commitTabState(tabId: string, next: TabArtifactState) {
    tabStates.value.set(tabId, next)
    tabStates.value = new Map(tabStates.value)
  }

  function mutateTab(tabId: string, reducer: (state: TabArtifactState) => TabArtifactState) {
    commitTabState(tabId, reducer(getTabState(tabId)))
  }

  function isVisible(tabId: string): boolean {
    return isPanelVisible(getTabState(tabId))
  }

  function isEmptyState(tabId: string): boolean {
    return isArtifactEmptyState(getTabState(tabId))
  }

  function getArtifactsForTab(tabId: string): readonly CanvasArtifact[] {
    return getArtifacts(getTabState(tabId))
  }

  function getActiveArtifactForTab(tabId: string): CanvasArtifact | null {
    return getActiveArtifact(getTabState(tabId))
  }

  function getArtifactByIdForTab(tabId: string, artifactId: string): CanvasArtifact | null {
    return getArtifactById(getTabState(tabId), artifactId)
  }

  function setActiveArtifactForTab(tabId: string, artifactId: string) {
    mutateTab(tabId, state => setActiveArtifact(state, artifactId))
  }

  function removeArtifactFromTab(tabId: string, artifactId: string) {
    mutateTab(tabId, state => removeArtifact(state, artifactId))
  }

  function applyCanvasDataForTab(tabId: string, data: CanvasData) {
    cancelPendingClose(tabId)
    mutateTab(tabId, state => applyCanvasData(state, data))
  }

  function open(
    tabId: string,
    data: Omit<CanvasData, 'action'> & { action?: 'open' }
  ) {
    applyCanvasDataForTab(tabId, { action: 'open', ...data })
  }

  function close(tabId: string, artifactId?: string) {
    cancelPendingClose(tabId)
    if (artifactId) {
      removeArtifactFromTab(tabId, artifactId)
      return
    }
    const state = getTabState(tabId)
    if (state.activeArtifactId) {
      removeArtifactFromTab(tabId, state.activeArtifactId)
    } else {
      commitTabState(tabId, clearTabArtifacts(state))
    }
  }

  function closeDelayed(tabId: string, delayMs = 0) {
    if (delayMs <= 0) {
      close(tabId)
      return
    }
    cancelPendingClose(tabId)
    closeTimers.set(tabId, setTimeout(() => {
      close(tabId)
      closeTimers.delete(tabId)
    }, delayMs))
  }

  function cancelPendingClose(tabId: string) {
    const timer = closeTimers.get(tabId)
    if (timer) {
      clearTimeout(timer)
      closeTimers.delete(tabId)
    }
  }

  function updateContent(tabId: string, content: string, artifactId?: string) {
    if (!artifactId) {
      mutateTab(tabId, state => {
        const active = getActiveArtifact(state)
        if (!active) return state
        return updateArtifactContentById(state, active.id, content)
      })
      return
    }
    mutateTab(tabId, state => updateArtifactContentById(state, artifactId, content))
  }

  function hydrateFromSteps(tabId: string, steps: ReadonlyArray<AgentStep>) {
    cancelPendingClose(tabId)
    commitTabState(tabId, hydrateArtifactsFromSteps(steps))
  }

  /** 用 localFs.exists 移除磁盘上已不存在的 filePath 锚点 */
  async function syncArtifactsWithDisk(
    tabId: string,
    options?: { notify?: boolean }
  ): Promise<readonly CanvasArtifact[]> {
    const arts = getArtifactsForTab(tabId)
    if (arts.length === 0) return []

    const map = await refreshFilePathExistsMap(arts)
    const missingIds = findArtifactIdsWithMissingFiles(arts, map)
    if (missingIds.length === 0) return []

    const removed: CanvasArtifact[] = []
    for (const id of missingIds) {
      const artifact = getArtifactByIdForTab(tabId, id)
      if (artifact) removed.push(artifact)
      removeArtifactFromTab(tabId, id)
    }

    if (options?.notify !== false) {
      lastDiskSync.value = { tabId, removed, at: Date.now() }
    }
    return removed
  }

  function handleAgentStep(tabId: string, step: AgentStep, allSteps: readonly AgentStep[] = []) {
    if (step.canvasData) {
      applyCanvasDataForTab(tabId, enrichCanvasDataFromStep(step.canvasData, step, allSteps))
    }
    if (shouldSyncArtifactsAfterStep(step)) {
      void syncArtifactsWithDisk(tabId)
    }
  }

  function handleAgentComplete(_tabId: string) {
    // noop
  }

  function cleanup(tabId: string) {
    cancelPendingClose(tabId)
    tabStates.value.delete(tabId)
    tabStates.value = new Map(tabStates.value)
  }

  function closeOthers(tabId: string, keepArtifactId: string) {
    mutateTab(tabId, (state) => {
      const kept = state.artifacts.filter(a => a.id === keepArtifactId)
      if (kept.length === 0) return state
      return { ...state, artifacts: kept, activeArtifactId: keepArtifactId, visible: true }
    })
  }

  function closeAll(tabId: string) {
    cancelPendingClose(tabId)
    commitTabState(tabId, clearTabArtifacts(getTabState(tabId)))
  }

  function dismissPanel(tabId: string) {
    cancelPendingClose(tabId)
    commitTabState(tabId, dismissEmptyPanel(getTabState(tabId)))
  }

  function requestJumpToSource(tabId: string, stepId: string) {
    sourceJumpRequest.value = { tabId, stepId }
  }

  function clearSourceJumpRequest() {
    sourceJumpRequest.value = null
  }

  function relocateArtifact(
    tabId: string,
    artifactId: string,
    newFilePath: string,
    content?: string
  ) {
    const artifact = getArtifactByIdForTab(tabId, artifactId)
    if (!artifact) return
    removeArtifactFromTab(tabId, artifactId)
    open(tabId, {
      renderer: artifact.renderer,
      title: newFilePath.split(/[/\\]/).pop() || artifact.title,
      content: content ?? artifact.content,
      filePath: newFilePath,
      origin: artifact.origin,
      sourceStepId: artifact.sourceStepId,
      activate: true
    })
  }

  return {
    tabStates,
    splitRatio,
    lastDiskSync,
    sourceJumpRequest,
    isVisible,
    isEmptyState,
    getArtifacts: getArtifactsForTab,
    getActiveArtifact: getActiveArtifactForTab,
    getArtifactById: getArtifactByIdForTab,
    getTabState,
    setActiveArtifact: setActiveArtifactForTab,
    removeArtifact: removeArtifactFromTab,
    open,
    close,
    closeDelayed,
    updateContent,
    applyCanvasData: applyCanvasDataForTab,
    hydrateFromSteps,
    syncArtifactsWithDisk,
    handleAgentStep,
    handleAgentComplete,
    cleanup,
    closeOthers,
    closeAll,
    dismissPanel,
    relocateArtifact,
    requestJumpToSource,
    clearSourceJumpRequest
  }
})

/** @deprecated 使用 useAssistantArtifactStore */
export const useCanvasStore = useAssistantArtifactStore
