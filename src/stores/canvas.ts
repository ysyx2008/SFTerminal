/**
 * Canvas Artifact 面板 — Pinia 适配层
 *
 * 领域逻辑在 `src/canvas/artifact-registry.ts`（纯函数）；
 * 本 store 只负责 tab 级 state 容器、布局比例与 Agent step 分发。
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { CanvasArtifact, CanvasData } from '@shared/types'
import type { AgentStep } from '@shared/types'
import {
  applyCanvasData,
  clearTabArtifacts,
  createTabArtifactState,
  getActiveArtifact,
  getArtifactById,
  getArtifacts,
  hydrateArtifactsFromSteps,
  isPanelVisible,
  removeArtifact,
  setActiveArtifact,
  updateArtifactContentById,
  type TabArtifactState
} from '../canvas/artifact-registry'

export const useCanvasStore = defineStore('canvas', () => {
  const tabStates = ref<Map<string, TabArtifactState>>(new Map())
  const splitRatio = ref(0.5)
  const closeTimers = new Map<string, ReturnType<typeof setTimeout>>()

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

  function hydrateFromSteps(tabId: string, steps: ReadonlyArray<{ canvasData?: CanvasData }>) {
    cancelPendingClose(tabId)
    commitTabState(tabId, hydrateArtifactsFromSteps(steps))
  }

  function handleAgentStep(tabId: string, step: AgentStep) {
    if (step.canvasData) {
      applyCanvasDataForTab(tabId, step.canvasData)
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

  return {
    tabStates,
    splitRatio,
    isVisible,
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
    handleAgentStep,
    handleAgentComplete,
    cleanup
  }
})
