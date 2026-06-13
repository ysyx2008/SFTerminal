/**
 * Canvas Artifact 注册表（纯函数，无 Vue/Pinia 依赖）
 *
 * 每个助手 tab 对应一份 TabArtifactState；所有变更返回新 state（immutable）。
 */
import type { CanvasArtifact, CanvasArtifactTarget, CanvasData } from '@shared/types'
import { resolveCanvasArtifactId } from '@shared/types/canvas'

export interface TabArtifactState {
  visible: boolean
  activeArtifactId: string | null
  artifacts: CanvasArtifact[]
}

export function createTabArtifactState(): TabArtifactState {
  return {
    visible: false,
    activeArtifactId: null,
    artifacts: []
  }
}

export function isPanelVisible(state: TabArtifactState): boolean {
  return state.visible && state.artifacts.length > 0
}

export function getArtifacts(state: TabArtifactState): readonly CanvasArtifact[] {
  return state.artifacts
}

export function getActiveArtifact(state: TabArtifactState): CanvasArtifact | null {
  if (!state.activeArtifactId) return null
  return state.artifacts.find(a => a.id === state.activeArtifactId) ?? null
}

export function getArtifactById(state: TabArtifactState, artifactId: string): CanvasArtifact | null {
  return state.artifacts.find(a => a.id === artifactId) ?? null
}

export function findArtifactForData(
  state: TabArtifactState,
  data: CanvasArtifactTarget
): CanvasArtifact | null {
  if (data.artifactId) {
    return state.artifacts.find(a => a.id === data.artifactId) ?? null
  }
  if (data.filePath) {
    const id = `file:${data.filePath}`
    return state.artifacts.find(a => a.id === id) ?? null
  }
  const active = getActiveArtifact(state)
  if (active && data.renderer && active.renderer === data.renderer) return active
  if (!data.renderer) return active
  const sameRenderer = state.artifacts.filter(a => a.renderer === data.renderer)
  if (sameRenderer.length === 0) return null
  return sameRenderer.reduce((a, b) => (a.updatedAt >= b.updatedAt ? a : b))
}

function activateArtifact(
  state: TabArtifactState,
  artifactId: string,
  activate: boolean
): TabArtifactState {
  let activeArtifactId = state.activeArtifactId
  if (activate) {
    activeArtifactId = artifactId
  } else if (!activeArtifactId) {
    activeArtifactId = artifactId
  }
  return { ...state, visible: true, activeArtifactId }
}

function upsertArtifact(state: TabArtifactState, data: CanvasData): TabArtifactState {
  const id = resolveCanvasArtifactId(data)
  const now = Date.now()
  const idx = state.artifacts.findIndex(a => a.id === id)
  let artifacts: CanvasArtifact[]

  if (idx >= 0) {
    const prev = state.artifacts[idx]
    artifacts = [...state.artifacts]
    artifacts[idx] = {
      ...prev,
      renderer: data.renderer,
      title: data.title ?? prev.title,
      content: data.content ?? prev.content,
      filePath: data.filePath !== undefined ? data.filePath : prev.filePath,
      updatedAt: now
    }
  } else {
    artifacts = [
      ...state.artifacts,
      {
        id,
        renderer: data.renderer,
        title: data.title ?? '',
        content: data.content ?? '',
        filePath: data.filePath ?? null,
        createdAt: now,
        updatedAt: now
      }
    ]
  }

  const next = { ...state, artifacts }
  return activateArtifact(next, id, data.activate !== false)
}

function updateArtifactContent(
  state: TabArtifactState,
  content: string,
  target?: CanvasArtifactTarget
): TabArtifactState {
  const artifact = target ? findArtifactForData(state, target) : getActiveArtifact(state)
  if (!artifact) return state
  const idx = state.artifacts.findIndex(a => a.id === artifact.id)
  if (idx < 0) return state
  const artifacts = [...state.artifacts]
  artifacts[idx] = { ...artifacts[idx], content, updatedAt: Date.now() }
  return { ...state, artifacts }
}

export function setActiveArtifact(state: TabArtifactState, artifactId: string): TabArtifactState {
  if (!state.artifacts.some(a => a.id === artifactId)) return state
  return { ...state, visible: true, activeArtifactId: artifactId }
}

export function removeArtifact(state: TabArtifactState, artifactId: string): TabArtifactState {
  const idx = state.artifacts.findIndex(a => a.id === artifactId)
  if (idx < 0) return state

  const artifacts = state.artifacts.filter(a => a.id !== artifactId)

  let activeArtifactId = state.activeArtifactId
  if (activeArtifactId === artifactId) {
    activeArtifactId = artifacts[idx]?.id ?? artifacts[idx - 1]?.id ?? null
  }

  if (artifacts.length === 0) {
    return createTabArtifactState()
  }

  return { ...state, visible: true, artifacts, activeArtifactId }
}

export function clearTabArtifacts(_state: TabArtifactState): TabArtifactState {
  return createTabArtifactState()
}

export function applyCanvasData(state: TabArtifactState, data: CanvasData): TabArtifactState {
  switch (data.action) {
    case 'open':
      if (!data.renderer) return state
      return upsertArtifact(state, data)
    case 'update':
      if (data.content === undefined) return state
      return updateArtifactContent(state, data.content, data)
    case 'close': {
      const target = findArtifactForData(state, data)
      if (target) return removeArtifact(state, target.id)
      if (data.renderer) {
        const match = findArtifactForData(state, { renderer: data.renderer })
        if (match) return removeArtifact(state, match.id)
      }
      return state
    }
    default:
      return state
  }
}

export function updateArtifactContentById(
  state: TabArtifactState,
  artifactId: string,
  content: string
): TabArtifactState {
  return updateArtifactContent(state, content, { artifactId })
}

/** 按 steps 顺序重放 canvasData，用于从历史对话恢复 Artifact 面板 */
export function hydrateArtifactsFromSteps(
  steps: ReadonlyArray<{ canvasData?: CanvasData }>
): TabArtifactState {
  let state = createTabArtifactState()
  for (const step of steps) {
    if (step.canvasData) {
      state = applyCanvasData(state, step.canvasData)
    }
  }
  return state
}
