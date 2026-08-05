/**
 * 助手工作台产出物面板 — Pinia 适配层
 *
 * 领域逻辑在 `domain/artifact-registry.ts`（纯函数）；
 * 本 store 只负责 assistant tab 级 state 容器、布局比例与 Agent step 分发。
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { AgentStep, CanvasArtifact, CanvasData } from '@shared/types'
import { resolveCanvasArtifactId } from '@shared/types/canvas'
import {
  applyCanvasData,
  clearTabArtifacts,
  createTabArtifactState,
  dismissEmptyPanel,
  enrichCanvasDataFromStep,
  getActiveArtifact,
  getArtifactById,
  getArtifacts,
  hasArtifacts,
  hidePanel,
  hydrateArtifactsFromSteps,
  isArtifactEmptyState,
  isPanelVisible,
  removeArtifact,
  setActiveArtifact,
  showPanel,
  updateArtifactContentById,
  type TabArtifactState
} from './domain/artifact-registry'
import {
  findArtifactIdsWithMissingFiles,
  refreshFilePathExistsMap
} from './domain/artifact-file-status'
import { shouldSyncArtifactsAfterStep } from './domain/artifact-disk-sync'
import {
  ARTIFACT_CONTENT_RELOAD_DELAYS_MS,
  artifactNeedsContentReload,
  loadArtifactContentFromDisk,
  sleep
} from './domain/artifact-content-loader'
import {
  createCoeditEntry,
  decideExternalContent,
  entryAfterCanonicalize,
  entryAfterApply,
  entryAfterDefer,
  entryAfterDismissDeferred,
  entryAfterSave,
  type CoeditEntry
} from './domain/coedit-conflict'

export interface ArtifactDiskSyncEvent {
  tabId: string
  removed: CanvasArtifact[]
  at: number
}

function coeditKey(tabId: string, artifactId: string): string {
  return `${tabId} ${artifactId}`
}

export const useAssistantArtifactStore = defineStore('assistantArtifact', () => {
  const tabStates = ref<Map<string, TabArtifactState>>(new Map())
  const splitRatio = ref(0.5)
  const closeTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const lastDiskSync = ref<ArtifactDiskSyncEvent | null>(null)
  /** 人机双写协同状态（session 级，不持久化）：key = coeditKey(tabId, artifactId) */
  const coeditStates = ref<Map<string, CoeditEntry>>(new Map())

  function getCoeditEntry(tabId: string, artifactId: string): CoeditEntry | undefined {
    return coeditStates.value.get(coeditKey(tabId, artifactId))
  }

  function patchCoeditEntry(tabId: string, artifactId: string, next: CoeditEntry) {
    const key = coeditKey(tabId, artifactId)
    const map = new Map(coeditStates.value)
    map.set(key, next)
    coeditStates.value = map
  }

  function dropCoeditEntry(tabId: string, artifactId: string) {
    const key = coeditKey(tabId, artifactId)
    if (!coeditStates.value.has(key)) return
    const map = new Map(coeditStates.value)
    map.delete(key)
    coeditStates.value = map
  }

  function dropCoeditEntriesForTab(tabId: string) {
    const prefix = `${tabId} `
    if (![...coeditStates.value.keys()].some(k => k.startsWith(prefix))) return
    const map = new Map(coeditStates.value)
    for (const k of map.keys()) {
      if (k.startsWith(prefix)) map.delete(k)
    }
    coeditStates.value = map
  }

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

  function hasArtifactsForTab(tabId: string): boolean {
    return hasArtifacts(getTabState(tabId))
  }

  function isPanelMinimized(tabId: string): boolean {
    const state = getTabState(tabId)
    return hasArtifacts(state) && !state.visible
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
    const art = getArtifactByIdForTab(tabId, artifactId)
    if (art && artifactNeedsContentReload(art)) {
      void reloadArtifactContent(tabId, artifactId)
    }
  }

  function removeArtifactFromTab(tabId: string, artifactId: string) {
    dropCoeditEntry(tabId, artifactId)
    mutateTab(tabId, state => removeArtifact(state, artifactId))
  }

  function applyCanvasDataForTab(tabId: string, data: CanvasData) {
    cancelPendingClose(tabId)
    let nextData = data
    // 人机双写：文件类产出物的内容更新经冲突分流；挂起时保留用户草稿（content 剥离，其余元数据照常 upsert）
    if (
      (data.action === 'open' || data.action === 'update') &&
      typeof data.content === 'string'
    ) {
      const id = resolveCanvasArtifactId(data)
      const target = getArtifactByIdForTab(tabId, id)
      if (target?.editable && target.filePath) {
        if (ingestExternalContent(tabId, id, data.content) === 'deferred') {
          nextData = { ...data, content: undefined }
        }
      } else if (!target && data.action === 'open' && data.filePath) {
        // 新产出物：以首个外部内容建立磁盘基线
        patchCoeditEntry(tabId, id, entryAfterApply(getCoeditEntry(tabId, id), data.content))
      }
    }
    mutateTab(tabId, state => applyCanvasData(state, nextData))
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

  // ── 人机双写：协同状态与外部内容分流 ──

  /** 渲染器推送 dirty（草稿 ≠ 磁盘基线） */
  function setArtifactDirty(tabId: string, artifactId: string, dirty: boolean) {
    const entry = getCoeditEntry(tabId, artifactId) ?? createCoeditEntry()
    if (entry.dirty === dirty) return
    patchCoeditEntry(tabId, artifactId, { ...entry, dirty })
  }

  function isArtifactDirty(tabId: string, artifactId: string): boolean {
    return getCoeditEntry(tabId, artifactId)?.dirty ?? false
  }

  function getDiskBaseline(tabId: string, artifactId: string): string | undefined {
    return getCoeditEntry(tabId, artifactId)?.baseline
  }

  function getDeferredContent(tabId: string, artifactId: string): string | undefined {
    return getCoeditEntry(tabId, artifactId)?.deferred
  }

  /**
   * 外部（Agent 推送 / 磁盘回填）内容进入的唯一入口。
   * 用户草稿已偏离基线时挂起外部版本（返回 'deferred'），否则直接应用（返回 'applied'）。
   */
  function ingestExternalContent(tabId: string, artifactId: string, content: string): 'applied' | 'deferred' {
    const entry = getCoeditEntry(tabId, artifactId)
    const current = getArtifactByIdForTab(tabId, artifactId)?.content ?? ''
    if (decideExternalContent(entry, current) === 'deferred') {
      patchCoeditEntry(tabId, artifactId, entryAfterDefer(entry, content))
      return 'deferred'
    }
    updateContent(tabId, content, artifactId)
    patchCoeditEntry(tabId, artifactId, entryAfterApply(entry, content))
    return 'applied'
  }

  /** 渲染器侧检测到 store 已应用但本地草稿 dirty（推送时序差）时，补挂起 */
  function deferExternalContent(tabId: string, artifactId: string, content: string) {
    const entry = getCoeditEntry(tabId, artifactId)
    if (entry?.deferred === content) return
    patchCoeditEntry(tabId, artifactId, entryAfterDefer(entry, content))
  }

  /** 用户选择「保留我的修改」：关闭提示，dirty 保持 */
  function dismissDeferredContent(tabId: string, artifactId: string) {
    const entry = getCoeditEntry(tabId, artifactId)
    if (entry?.deferred === undefined) return
    patchCoeditEntry(tabId, artifactId, entryAfterDismissDeferred(entry))
  }

  /** 用户保存成功：基线 = 草稿，冲突解除 */
  function markSavedToDisk(tabId: string, artifactId: string, content: string) {
    patchCoeditEntry(tabId, artifactId, entryAfterSave(getCoeditEntry(tabId, artifactId), content))
  }

  /**
   * WYSIWYG 编辑器规范化回写后同步基线（基线恒为编辑器规范化内容）。
   * 「载入外部版本」也走这里：deferred 经编辑器规范化后回写，基线随之前进。
   */
  function syncCoeditBaseline(tabId: string, artifactId: string, content: string) {
    patchCoeditEntry(tabId, artifactId, entryAfterCanonicalize(getCoeditEntry(tabId, artifactId), content))
  }

  function hydrateFromSteps(tabId: string, steps: ReadonlyArray<AgentStep>) {
    cancelPendingClose(tabId)
    dropCoeditEntriesForTab(tabId)
    commitTabState(tabId, hydrateArtifactsFromSteps(steps))
    void reloadArtifactContent(tabId)
  }

  /**
   * 直接从持久化清单恢复产出物面板（新方式，优先于 hydrateFromSteps replay）。
   * 清单来自 AgentRecord.artifacts，已剥离 contentFromFile 的 content，恢复后按 filePath 读盘回填。
   */
  function restoreFromArtifacts(tabId: string, artifacts: CanvasArtifact[]) {
    cancelPendingClose(tabId)
    dropCoeditEntriesForTab(tabId)
    if (artifacts.length === 0) {
      commitTabState(tabId, createTabArtifactState())
      return
    }
    const activeArtifactId = artifacts[artifacts.length - 1].id
    commitTabState(tabId, {
      visible: true,
      activeArtifactId,
      artifacts: [...artifacts],
      hadArtifacts: true
    })
    void reloadArtifactContent(tabId)
  }

  /**
   * 历史持久化会剥离 md/html 产出物的 content（contentFromFile）。
   * 恢复后或 open 时 content 为空，这里按 filePath 异步读盘/重建预览。
   * 写入磁盘与 step 到达存在竞态，失败时会退避重试。
   */
  async function reloadArtifactContent(
    tabId: string,
    artifactId?: string,
    attempt = 0
  ): Promise<void> {
    const previewApi = window.electronAPI?.localFs?.previewArtifact
    const readApi = window.electronAPI?.localFs?.readFile
    if (!previewApi && !readApi) return

    const targets = artifactId
      ? [getArtifactByIdForTab(tabId, artifactId)].filter((a): a is CanvasArtifact => a != null)
      : [...getArtifactsForTab(tabId)]

    const pending = targets.filter(artifactNeedsContentReload)
    if (pending.length === 0) return

    let anyStillEmpty = false
    await Promise.all(
      pending.map(async (a) => {
        try {
          const data = await loadArtifactContentFromDisk(a, {
            previewArtifact: previewApi,
            readFile: readApi
          })
          if (data) {
            // 读盘回填同样走冲突分流：用户草稿 dirty 时挂起而非覆盖
            ingestExternalContent(tabId, a.id, data)
            return
          }
        } catch {
          /* 读盘/预览失败：留空，由退避重试或磁盘同步处理 */
        }
        if (artifactNeedsContentReload(getArtifactByIdForTab(tabId, a.id) ?? a)) {
          anyStillEmpty = true
        }
      })
    )

    const retryDelay = ARTIFACT_CONTENT_RELOAD_DELAYS_MS[attempt]
    if (anyStillEmpty && retryDelay !== undefined) {
      await sleep(retryDelay)
      await reloadArtifactContent(tabId, artifactId, attempt + 1)
    }
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
      if (step.canvasData.action === 'open') {
        const id = resolveCanvasArtifactId(step.canvasData)
        void reloadArtifactContent(tabId, id)
      }
    }
    if (shouldSyncArtifactsAfterStep(step)) {
      void syncArtifactsWithDisk(tabId)
    }
  }

  function cleanup(tabId: string) {
    cancelPendingClose(tabId)
    dropCoeditEntriesForTab(tabId)
    tabStates.value.delete(tabId)
    tabStates.value = new Map(tabStates.value)
    // 清主进程 webview 预览内容缓存（sailfish-artifact:// 协议数据源）
    window.electronAPI?.artifactPreview?.clear(tabId)
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

  function minimizePanel(tabId: string) {
    cancelPendingClose(tabId)
    commitTabState(tabId, hidePanel(getTabState(tabId)))
  }

  function expandPanel(tabId: string) {
    cancelPendingClose(tabId)
    commitTabState(tabId, showPanel(getTabState(tabId)))
    void reloadArtifactContent(tabId)
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
    isVisible,
    hasArtifacts: hasArtifactsForTab,
    isPanelMinimized,
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
    setArtifactDirty,
    isArtifactDirty,
    getDiskBaseline,
    getDeferredContent,
    ingestExternalContent,
    deferExternalContent,
    dismissDeferredContent,
    markSavedToDisk,
    syncCoeditBaseline,
    applyCanvasData: applyCanvasDataForTab,
    hydrateFromSteps,
    restoreFromArtifacts,
    reloadArtifactContent,
    syncArtifactsWithDisk,
    handleAgentStep,
    cleanup,
    closeOthers,
    closeAll,
    dismissPanel,
    minimizePanel,
    expandPanel,
    relocateArtifact,
  }
})

/** @deprecated 使用 useAssistantArtifactStore */
export const useCanvasStore = useAssistantArtifactStore
