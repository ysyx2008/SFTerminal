/**
 * 助手工作台产出物注册表（纯函数，无 Vue/Pinia 依赖）
 *
 * 每个 assistant tab 对应一份 TabArtifactState；所有变更返回新 state（immutable）。
 */
import type { CanvasArtifact, CanvasArtifactTarget, CanvasData } from '@shared/types'
import { resolveCanvasArtifactId } from '@shared/types/canvas'
import { enrichCanvasDataFromStep, type SourceStepLike } from './artifact-source'
import { getRendererCapabilities } from '../renderers/registry'

export type { SourceStepLike } from './artifact-source'
export { enrichCanvasDataFromStep, resolveSourceStepIdById, resolveVisibleSourceStepId } from './artifact-source'

export interface TabArtifactState {
  visible: boolean
  activeArtifactId: string | null
  artifacts: CanvasArtifact[]
  /** 本会话是否曾出现过产出物（用于清空后的轻量空态） */
  hadArtifacts: boolean
}

export function createTabArtifactState(): TabArtifactState {
  return {
    visible: false,
    activeArtifactId: null,
    artifacts: [],
    hadArtifacts: false
  }
}

export function hasArtifacts(state: TabArtifactState): boolean {
  return state.artifacts.length > 0
}

/** 面板是否展开（有产出物且未被用户最小化） */
export function isPanelVisible(state: TabArtifactState): boolean {
  return state.artifacts.length > 0 && state.visible
}

/** @deprecated 产出物为空时面板自动隐藏，不再保留空态占位 */
export function isArtifactEmptyState(_state: TabArtifactState): boolean {
  return false
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
  if (data.url) {
    const id = `url:${data.url}`
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
  return { ...state, visible: true, hadArtifacts: true, activeArtifactId }
}

function artifactMetaFromData(
  data: CanvasData,
  prev?: CanvasArtifact
): Pick<CanvasArtifact, 'origin' | 'editable' | 'sourceStepId' | 'contentFromFile'> {
  const caps = getRendererCapabilities(data.renderer)
  const contentFromFile =
    data.contentFromFile ??
    (prev && prev.renderer === data.renderer ? prev.contentFromFile : undefined)
  return {
    origin: data.origin ?? prev?.origin ?? 'agent',
    editable: caps.editable,
    sourceStepId: data.sourceStepId ?? prev?.sourceStepId,
    contentFromFile
  }
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
      url: data.url !== undefined ? data.url : prev.url,
      ...artifactMetaFromData(data, prev),
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
        url: data.url,
        ...artifactMetaFromData(data),
        createdAt: now,
        updatedAt: now
      }
    ]
  }

  const next = { ...state, artifacts, hadArtifacts: true }
  return activateArtifact(next, id, data.activate !== false)
}

function updateArtifactFields(
  state: TabArtifactState,
  fields: { content?: string; url?: string },
  target?: CanvasArtifactTarget
): TabArtifactState {
  const artifact = target ? findArtifactForData(state, target) : getActiveArtifact(state)
  if (!artifact) return state
  const idx = state.artifacts.findIndex(a => a.id === artifact.id)
  if (idx < 0) return state
  const artifacts = [...state.artifacts]
  artifacts[idx] = {
    ...artifacts[idx],
    ...(fields.content !== undefined ? { content: fields.content } : {}),
    ...(fields.url !== undefined ? { url: fields.url } : {}),
    updatedAt: Date.now()
  }
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
    return { ...createTabArtifactState(), hadArtifacts: true }
  }

  return { ...state, artifacts, activeArtifactId }
}

export function clearTabArtifacts(_state: TabArtifactState): TabArtifactState {
  return createTabArtifactState()
}

/** 关闭空态面板，恢复为未出现产出物的初始态 */
export function dismissEmptyPanel(_state: TabArtifactState): TabArtifactState {
  return createTabArtifactState()
}

/** 最小化面板：保留产出物数据，仅隐藏分屏区域 */
export function hidePanel(state: TabArtifactState): TabArtifactState {
  if (state.artifacts.length === 0) return state
  return { ...state, visible: false }
}

/** 展开已最小化的产出物面板 */
export function showPanel(state: TabArtifactState): TabArtifactState {
  if (state.artifacts.length === 0) return state
  return { ...state, visible: true }
}

export function applyCanvasData(state: TabArtifactState, data: CanvasData): TabArtifactState {
  switch (data.action) {
    case 'open':
      if (!data.renderer) return state
      return upsertArtifact(state, data)
    case 'update':
      if (data.content === undefined && data.url === undefined) return state
      return updateArtifactFields(state, { content: data.content, url: data.url }, data)
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
  return updateArtifactFields(state, { content }, { artifactId })
}

/** 按 steps 顺序重放 canvasData，用于从历史对话恢复 Artifact 面板 */
export function hydrateArtifactsFromSteps(
  steps: ReadonlyArray<SourceStepLike & { canvasData?: CanvasData }>
): TabArtifactState {
  let state = createTabArtifactState()
  for (const step of steps) {
    if (step.canvasData) {
      const data =
        step.canvasData.action === 'open' && step.id && !step.canvasData.sourceStepId
          ? enrichCanvasDataFromStep(step.canvasData, step, steps)
          : step.canvasData
      state = applyCanvasData(state, data)
    }
  }
  return state
}
