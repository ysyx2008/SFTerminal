<script setup lang="ts">
/**
 * 助手工作台产出物面板
 *
 * 单产出物预览；≥2 个时通过标题下拉切换。无产出物时由工作台自动隐藏面板。
 */
import { computed, nextTick, onMounted, onUnmounted, provide, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  FolderOpen,
  ChevronDown,
  Download,
  Check,
  X
} from 'lucide-vue-next'
import type { CanvasArtifact, CanvasRendererType } from '@shared/types'
import {
  artifactDisplayLabel,
  canSaveAsArtifact,
  defaultSaveFileName,
  filterArtifactsByQuery,
  isArtifactEditable,
  saveArtifact,
  saveArtifactAs,
  sortArtifactsByRecent,
  refreshFilePathExistsMap,
  type ArtifactSaveDeps,
  getArtifactContextMenuFlags,
  artifactHasFileActions,
  createArtifactSaveBridge,
  provideArtifactSaveBridge,
  useAssistantArtifactStore
} from '../index'
import { getRendererComponent, getRendererIcon } from '../renderers/ui-registry'
import { resolveSourceStepIdById } from '../domain/artifact-source'
import { requireArtifactDesktopHost } from '../host'
import { useToast } from '@sailfish/workbench-sdk/toast'
import { BUTTON_HOVER_TIP_DELAY_MS, useHoverTip } from '../ui/useHoverTip'
import HoverTipOverlay from '../ui/HoverTipOverlay.vue'
import {
  ADD_COMPOSER_QUOTE_KEY,
  SET_COMPOSER_DRAFT_KEY,
  type AddComposerQuoteFn
} from '../composer-quote'

const props = defineProps<{
  tabId: string
  /** 岗壳注入：滚到对话流指定 step（AiPanel.scrollToAgentStep） */
  scrollToAgentStep?: (stepId: string) => void | Promise<void>
  /** 岗壳注入：引用摘录到 Composer（AiPanel.addComposerQuote） */
  addComposerQuote?: AddComposerQuoteFn
  /** 岗壳注入：图片加入 Composer 待发送区（AiPanel.addComposerImage） */
  addComposerImage?: (image: { dataUrl: string; name: string; width?: number; height?: number }) => void
  /** 岗壳注入：设置 Composer 草稿文本（AiPanel.setComposerDraft） */
  setComposerDraft?: (text: string) => void
}>()

provide(ADD_COMPOSER_QUOTE_KEY, (snippet) => {
  props.addComposerQuote?.(snippet)
})
provide(SET_COMPOSER_DRAFT_KEY, (text) => {
  props.setComposerDraft?.(text)
})

const { t } = useI18n()
const artifactStore = useAssistantArtifactStore()
const desktopHost = requireArtifactDesktopHost()
const { success: toastSuccess, error: toastError, info: toastInfo } = useToast()
const saveBridge = createArtifactSaveBridge()
provideArtifactSaveBridge(saveBridge)
const { hoverTip, showTip, hideTip } = useHoverTip({
  placement: 'bottom',
  delayMs: BUTTON_HOVER_TIP_DELAY_MS
})

const artifacts = computed(() => artifactStore.getArtifacts(props.tabId))
const activeArtifact = computed(() => artifactStore.getActiveArtifact(props.tabId))
const activeArtifactId = computed(() => activeArtifact.value?.id ?? null)
const renderer = computed(() => activeArtifact.value?.renderer ?? null)
const filePath = computed(() => activeArtifact.value?.filePath ?? null)
const isActiveEditable = computed(() =>
  activeArtifact.value ? isArtifactEditable(activeArtifact.value) : false
)
const activeRendererComponent = computed(() =>
  renderer.value ? getRendererComponent(renderer.value) : null
)
const activeSourceStepId = computed(() => activeArtifact.value?.sourceStepId ?? null)
const fileExistsMap = ref<Map<string, boolean>>(new Map())

function pathExistsOnDisk(path: string | null | undefined): boolean {
  if (!path) return false
  return fileExistsMap.value.get(path) !== false
}

const activeDirty = computed(() =>
  activeArtifactId.value ? saveBridge.isDirty(activeArtifactId.value) : false
)

const canOpenActive = computed(() => pathExistsOnDisk(filePath.value))
const canSaveAsActive = computed(() =>
  activeArtifact.value ? canSaveAsArtifact(activeArtifact.value) : false
)
const canSaveAll = computed(() =>
  artifacts.value.some(a =>
    isArtifactEditable(a) &&
    Boolean(a.filePath) &&
    fileExistsMap.value.get(a.filePath!) !== false &&
    saveBridge.isDirty(a.id)
  )
)
/** 保存：可编辑、磁盘文件仍在、且有未保存编辑 */
const canSaveActive = computed(() =>
  isActiveEditable.value &&
  Boolean(filePath.value) &&
  pathExistsOnDisk(filePath.value) &&
  activeDirty.value
)

const saveActiveTitle = computed(() => {
  if (!isActiveEditable.value) return ''
  if (!filePath.value) return t('canvas.saveNoPath')
  if (!activeDirty.value) return t('canvas.saveNoChanges')
  return t('canvas.saveShortcut')
})

const showOpenButton = computed(() => Boolean(filePath.value))
const showFileOverflowMenu = computed(() =>
  canOpenActive.value || canSaveAsActive.value || canSaveAll.value
)
const showFileActions = computed(() => showOpenButton.value || showFileOverflowMenu.value)

const fileMenuRef = ref<HTMLElement | null>(null)
const showFileMenuDropdown = ref(false)
const artifactPickerRef = ref<HTMLElement | null>(null)
const artifactPickerDropdownRef = ref<HTMLElement | null>(null)
const ctxMenuRef = ref<HTMLElement | null>(null)
const showArtifactPicker = ref(false)
const artifactPickerQuery = ref('')
const artifactPickerPos = ref({ top: 0, left: 0, width: 300 })
const saving = ref(false)

type ContextTarget =
  | { kind: 'tab'; artifactId: string }
  | { kind: 'header' }
  | null

const ctxMenu = ref<{
  show: boolean
  x: number
  y: number
  target: ContextTarget
}>({
  show: false,
  x: 0,
  y: 0,
  target: null
})
/** 产出物列表仍打开时弹出的右键菜单（需保持列表可见且菜单置于列表之上） */
const ctxMenuFromPicker = ref(false)

const showArtifactSwitcher = computed(() => artifacts.value.length >= 1)
const allArtifactsSorted = computed(() => sortArtifactsByRecent(artifacts.value))
const pickerArtifacts = computed(() =>
  filterArtifactsByQuery(allArtifactsSorted.value, artifactPickerQuery.value)
)
const showPickerSearch = computed(() => artifacts.value.length >= 5)

const ctxArtifact = computed(() => {
  if (ctxMenu.value.target?.kind !== 'tab') return null
  return artifactStore.getArtifactById(props.tabId, ctxMenu.value.target.artifactId)
})

const ctxMenuFlags = computed(() => {
  const artifact = ctxArtifact.value
  if (!artifact) return null
  const path = artifact.filePath
  const fileExists = path ? fileExistsMap.value.get(path) !== false : false
  return getArtifactContextMenuFlags(artifact, artifacts.value.length, {
    isDirty: saveBridge.isDirty(artifact.id),
    fileExists
  })
})

function rendererIcon(type: CanvasRendererType | null) {
  if (!type) return getRendererIcon('document')
  return getRendererIcon(type)
}

function rendererTypeKey(type: CanvasRendererType | null): string {
  return type ?? 'document'
}

function activeTitleLabel() {
  return activeArtifact.value
    ? artifactTabLabel(activeArtifact.value)
    : artifactTabLabel({ title: '', filePath: null })
}

async function updateFileExistsMap() {
  const remaining = artifactStore.getArtifacts(props.tabId)
  fileExistsMap.value = remaining.length > 0
    ? await refreshFilePathExistsMap(remaining)
    : new Map()
}

async function refreshFileStatus() {
  await artifactStore.syncArtifactsWithDisk(props.tabId)
  await updateFileExistsMap()
}

function toggleFileMenu() {
  const next = !showFileMenuDropdown.value
  showFileMenuDropdown.value = next
  if (next) {
    closeArtifactPicker()
    closeCtxMenu()
    closeSendMenu()
  }
}

function closeFileMenu() {
  showFileMenuDropdown.value = false
}

// ---- 发送到手机（IM 渠道直发，三态：可发 / 未连接 / 无会话） ----
interface ChannelSendTarget {
  platform: string
  connected: boolean
  hasContact: boolean
  contactName?: string
}
const sendMenuRef = ref<HTMLElement | null>(null)
const sendMenuDropdownRef = ref<HTMLElement | null>(null)
const showSendMenu = ref(false)
const sendMenuPos = ref({ top: 0, left: 0, width: 200 })
const sendTargets = ref<ChannelSendTarget[]>([])
const sendTargetsLoading = ref(false)
const sendingPlatform = ref<string | null>(null)
let offImConnectionChange: (() => void) | null = null

const canSendActive = computed(() => Boolean(filePath.value) && pathExistsOnDisk(filePath.value))

function channelName(platform: string): string {
  return t(`settings.im.${platform}`)
}

function syncSendMenuPosition() {
  if (!showSendMenu.value) return
  const anchor = sendMenuRef.value
  if (!anchor) return
  const rect = anchor.getBoundingClientRect()
  const width = sendMenuPos.value.width
  // 与按钮右对齐，防出屏
  const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8))
  sendMenuPos.value = { top: rect.bottom + 4, left, width }
}

async function refreshSendTargets() {
  sendTargetsLoading.value = sendTargets.value.length === 0
  try {
    sendTargets.value = (await window.electronAPI?.im?.getChannelSendTargets?.()) ?? []
  } catch {
    sendTargets.value = []
  } finally {
    sendTargetsLoading.value = false
  }
}

async function toggleSendMenu() {
  if (showSendMenu.value) {
    closeSendMenu()
    return
  }
  showSendMenu.value = true
  closeFileMenu()
  closeArtifactPicker()
  closeCtxMenu()
  void nextTick(syncSendMenuPosition)
  void refreshSendTargets()
  // 菜单打开期间跟随连接状态变化自刷新（启动后渠道可能稍后才连上）
  offImConnectionChange = window.electronAPI?.im?.onConnectionChange?.(() => {
    void refreshSendTargets()
  }) ?? null
}

function closeSendMenu() {
  showSendMenu.value = false
  offImConnectionChange?.()
  offImConnectionChange = null
}

function sendTargetTip(target: ChannelSendTarget): string | undefined {
  if (!target.connected) return t('canvas.sendChannelOfflineTip')
  if (!target.hasContact) return t('canvas.sendChannelNoSessionTip', { platform: channelName(target.platform) })
  return undefined
}

async function sendToChannel(target: ChannelSendTarget) {
  if (!target.connected || !target.hasContact || sendingPlatform.value) return
  const artifact = activeArtifact.value
  const path = filePath.value
  if (!artifact || !path) return
  sendingPlatform.value = target.platform
  try {
    const result = await window.electronAPI?.im?.sendFileToChannel?.(
      target.platform,
      path,
      defaultSaveFileName(artifact)
    )
    if (result?.success) {
      toastSuccess(t('canvas.sendToChannelSuccess', { platform: channelName(target.platform) }))
      closeSendMenu()
    } else {
      toastError(t('canvas.sendToChannelFailed', { platform: channelName(target.platform), error: result?.error || '' }))
    }
  } catch (err: any) {
    toastError(t('canvas.sendToChannelFailed', { platform: channelName(target.platform), error: err?.message || '' }))
  } finally {
    sendingPlatform.value = null
  }
}

function artifactTabLabel(artifact: Pick<CanvasArtifact, 'title' | 'filePath'>) {
  return artifactDisplayLabel(artifact, t('canvas.artifactUntitled'))
}

function getArtifactContent(artifact: CanvasArtifact): string {
  return saveBridge.getContent(artifact.id, artifact.content)
}

function buildSaveDeps(): ArtifactSaveDeps | null {
  const api = window.electronAPI
  if (!api?.localFs?.writeFile || !api.localFs.copyFile || !api.sftp?.selectSavePath) {
    return null
  }
  return {
    writeFile: (path, content) => api.localFs!.writeFile(path, content),
    copyFile: (src, dest) => api.localFs!.copyFile(src, dest),
    selectSavePath: (defaultName) => api.sftp!.selectSavePath(defaultName),
    getContent: (artifactId) => {
      const a = artifactStore.getArtifactById(props.tabId, artifactId)
      return a ? saveBridge.getContent(artifactId, a.content) : ''
    }
  }
}

function flushActiveDraft() {
  if (activeArtifactId.value) {
    saveBridge.flush(activeArtifactId.value)
  }
}

function selectArtifact(id: string) {
  if (id !== activeArtifactId.value) {
    flushActiveDraft()
  }
  artifactStore.setActiveArtifact(props.tabId, id)
  closeArtifactPicker()
  void refreshFileStatus()
}

function syncArtifactPickerPosition() {
  if (!showArtifactPicker.value) return
  const anchor = artifactPickerRef.value
  if (!anchor) return
  const rect = anchor.getBoundingClientRect()
  // 长文件名常见：加宽下拉，配合两行 clamp + title 悬停看全名
  const width = Math.min(480, Math.max(300, window.innerWidth - 16))
  let left = rect.left
  left = Math.max(8, Math.min(left, window.innerWidth - width - 8))
  artifactPickerPos.value = {
    top: rect.bottom + 4,
    left,
    width
  }
}

function toggleArtifactPicker() {
  showArtifactPicker.value = !showArtifactPicker.value
  if (showArtifactPicker.value) {
    closeFileMenu()
    closeCtxMenu()
    void nextTick(syncArtifactPickerPosition)
  } else {
    artifactPickerQuery.value = ''
  }
}

function closeArtifactPicker() {
  showArtifactPicker.value = false
  artifactPickerQuery.value = ''
}

function closeArtifact(id: string, e?: Event) {
  e?.stopPropagation()
  saveBridge.flush(id)
  artifactStore.removeArtifact(props.tabId, id)
  desktopHost.persistArtifacts(props.tabId)
}

function closeOthers(keepId: string) {
  flushActiveDraft()
  artifactStore.closeOthers(props.tabId, keepId)
  desktopHost.persistArtifacts(props.tabId)
}

function closeAllArtifacts() {
  flushActiveDraft()
  artifactStore.closeAll(props.tabId)
  desktopHost.persistArtifacts(props.tabId)
}

function minimizePanel() {
  flushActiveDraft()
  for (const artifact of artifacts.value) {
    saveBridge.flush(artifact.id)
  }
  closeAllMenus()
  hideTip()
  artifactStore.minimizePanel(props.tabId)
}

function jumpToSource(stepId?: string) {
  const rawId = stepId ?? activeSourceStepId.value
  if (!rawId || !props.scrollToAgentStep) return
  closeAllMenus()
  const allSteps = desktopHost.getAgentSteps(props.tabId)
  const visibleStepId = resolveSourceStepIdById(rawId, allSteps)
  void props.scrollToAgentStep(visibleStepId)
}

/**
 * 截图反馈闭环：截取 webview 渲染结果 → 图片进 Composer 待发送区 + 草稿意图文本。
 * 用户补充意见后回车，Agent 读到截图与意见后修改，面板刷新即见新版。
 */
async function onCaptureFeedback(payload: { webContentsId: number; suggestedName: string }) {
  const api = window.electronAPI?.artifactPreview
  if (!api?.capture) {
    toastError(t('canvas.captureFeedbackFailed'))
    return
  }
  const res = await api.capture(payload)
  if (!res.success || !res.data) {
    toastError(res.error || t('canvas.captureFeedbackFailed'))
    return
  }
  const active = activeArtifact.value
  const name = payload.suggestedName || active?.title || 'artifact'
  props.addComposerImage?.({
    dataUrl: res.data.dataUrl,
    name: `${name}.png`,
    width: res.data.width,
    height: res.data.height
  })
  props.setComposerDraft?.(t('canvas.captureFeedbackDraft', { title: active?.title || name }))
  toastSuccess(t('canvas.captureFeedbackReady'))
}

async function openFileFor(artifact: CanvasArtifact) {
  const path = artifact.filePath
  if (!path) return
  const api = window.electronAPI?.localFs
  if (!api?.openFile) {
    toastError(t('canvas.openFailed'))
    return
  }
  try {
    await api.openFile(path)
  } catch (err) {
    toastError(err instanceof Error ? err.message : t('canvas.openFailed'))
  }
}

async function openFile() {
  const active = activeArtifact.value
  if (active) await openFileFor(active)
}

async function showInFolderFor(artifact: CanvasArtifact) {
  const path = artifact.filePath
  if (!path) return
  const api = window.electronAPI?.localFs
  if (!api?.showInExplorer) {
    toastError(t('canvas.showInFolderFailed'))
    return
  }
  try {
    await api.showInExplorer(path)
  } catch (err) {
    toastError(err instanceof Error ? err.message : t('canvas.showInFolderFailed'))
  }
}

async function showInFolder() {
  const active = activeArtifact.value
  if (active) await showInFolderFor(active)
}

async function runSave(artifact: CanvasArtifact) {
  const deps = buildSaveDeps()
  if (!deps) {
    toastError(t('canvas.saveFailed'))
    return
  }
  saveBridge.flush(artifact.id)
  saving.value = true
  try {
    const res = await saveArtifact(artifact, deps)
    if (res.ok) {
      artifactStore.updateContent(props.tabId, getArtifactContent(artifact), artifact.id)
      artifactStore.markSavedToDisk(props.tabId, artifact.id, getArtifactContent(artifact))
      saveBridge.clearDirty(artifact.id)
      if (artifact.filePath) {
        fileExistsMap.value = new Map(fileExistsMap.value).set(artifact.filePath, true)
      }
      toastSuccess(t('canvas.savedToDisk'))
    } else {
      toastError(res.error || t('canvas.saveFailed'))
    }
  } finally {
    saving.value = false
  }
}

async function runSaveAs(artifact: CanvasArtifact) {
  const deps = buildSaveDeps()
  if (!deps) {
    toastError(t('canvas.saveFailed'))
    return
  }
  saveBridge.flush(artifact.id)
  saving.value = true
  try {
    const res = await saveArtifactAs(artifact, deps)
    if (res.ok) {
      artifactStore.relocateArtifact(
        props.tabId,
        artifact.id,
        res.filePath,
        getArtifactContent(artifact)
      )
      saveBridge.clearDirty(artifact.id)
      await refreshFileStatus()
      toastSuccess(t('canvas.savedToDisk'))
    } else if (!res.canceled) {
      toastError(res.error || t('canvas.saveFailed'))
    }
  } finally {
    saving.value = false
  }
}

async function runSaveActive() {
  const active = activeArtifact.value
  if (!active || !canSaveActive.value) return
  await runSave(active)
}

async function runSaveAsActive() {
  const active = activeArtifact.value
  if (!active || !canSaveAsArtifact(active)) return
  await runSaveAs(active)
}

async function runSaveAll() {
  const deps = buildSaveDeps()
  if (!deps) {
    toastError(t('canvas.saveFailed'))
    return
  }
  for (const a of artifacts.value) {
    saveBridge.flush(a.id)
  }
  saving.value = true
  try {
    let saved = 0
    let failed = 0
    for (const a of artifacts.value) {
      if (!a.filePath || fileExistsMap.value.get(a.filePath) === false) continue
      if (a.renderer !== 'markdown' || !saveBridge.isDirty(a.id)) continue
      const res = await saveArtifact(a, deps)
      if (res.ok) {
        artifactStore.updateContent(props.tabId, getArtifactContent(a), a.id)
        artifactStore.markSavedToDisk(props.tabId, a.id, getArtifactContent(a))
        saveBridge.clearDirty(a.id)
        saved += 1
      } else {
        failed += 1
      }
    }
    if (saved === 0 && failed === 0) {
      toastInfo(t('canvas.saveAllNone'))
      return
    }
    if (failed === 0) {
      toastSuccess(t('canvas.saveAllDone', { count: saved }))
    } else {
      toastError(t('canvas.saveAllPartial', { saved, failed }))
    }
  } finally {
    saving.value = false
  }
}

function closeOverlayMenus(options?: { keepArtifactPicker?: boolean }) {
  closeFileMenu()
  closeSendMenu()
  closeCtxMenu()
  if (!options?.keepArtifactPicker) {
    closeArtifactPicker()
  }
}

function closeAllMenus() {
  closeOverlayMenus()
}

/** 任意浮层菜单打开时屏蔽 canvas-body 的指针事件，防止 iframe 合成层吞掉点击，导致菜单无法关闭 */
const anyMenuOpen = computed(() =>
  ctxMenu.value.show || showArtifactPicker.value || showFileMenuDropdown.value || showSendMenu.value
)

function openCtxMenu(
  e: MouseEvent,
  target: ContextTarget,
  options?: { keepArtifactPicker?: boolean }
) {
  e.preventDefault()
  e.stopPropagation()
  closeFileMenu()
  closeCtxMenu()
  if (!options?.keepArtifactPicker) {
    closeArtifactPicker()
  }
  ctxMenuFromPicker.value = options?.keepArtifactPicker ?? false
  ctxMenu.value = {
    show: true,
    x: e.clientX,
    y: e.clientY,
    target
  }
}

function openArtifactPickerCtxMenu(e: MouseEvent, artifactId: string) {
  openCtxMenu(e, { kind: 'tab', artifactId }, { keepArtifactPicker: true })
}

function closeCtxMenu() {
  ctxMenu.value.show = false
  ctxMenu.value.target = null
  ctxMenuFromPicker.value = false
}

function onDocumentMouseDown(e: MouseEvent) {
  const target = e.target as Node
  if (showFileMenuDropdown.value) {
    const el = fileMenuRef.value
    if (el && !el.contains(target)) closeFileMenu()
  }
  if (showSendMenu.value) {
    const anchor = sendMenuRef.value
    const dropdown = sendMenuDropdownRef.value
    if (
      anchor && !anchor.contains(target) &&
      dropdown && !dropdown.contains(target)
    ) {
      closeSendMenu()
    }
  }
  if (showArtifactPicker.value) {
    const anchor = artifactPickerRef.value
    const dropdown = artifactPickerDropdownRef.value
    if (
      anchor && !anchor.contains(target) &&
      dropdown && !dropdown.contains(target)
    ) {
      closeArtifactPicker()
    }
  }
  if (ctxMenu.value.show) {
    const menu = ctxMenuRef.value
    if (menu && !menu.contains(target)) {
      closeCtxMenu()
    }
  }
}

function onDocumentKeyDown(e: KeyboardEvent) {
  if (e.key !== 'Escape') return
  if (ctxMenu.value.show) {
    closeCtxMenu()
    return
  }
  if (showArtifactPicker.value) {
    closeArtifactPicker()
    return
  }
  if (showSendMenu.value) {
    closeSendMenu()
    return
  }
  if (showFileMenuDropdown.value) {
    closeFileMenu()
  }
}

watch(showArtifactPicker, (open) => {
  if (open) {
    void nextTick(syncArtifactPickerPosition)
    window.addEventListener('resize', syncArtifactPickerPosition)
    window.addEventListener('scroll', syncArtifactPickerPosition, true)
  } else {
    window.removeEventListener('resize', syncArtifactPickerPosition)
    window.removeEventListener('scroll', syncArtifactPickerPosition, true)
  }
})

watch(showSendMenu, (open) => {
  if (open) {
    void nextTick(syncSendMenuPosition)
    window.addEventListener('resize', syncSendMenuPosition)
    window.addEventListener('scroll', syncSendMenuPosition, true)
  } else {
    window.removeEventListener('resize', syncSendMenuPosition)
    window.removeEventListener('scroll', syncSendMenuPosition, true)
  }
})

watch(artifacts, () => {
  void refreshFileStatus()
}, { deep: true })

watch(
  () => artifactStore.lastDiskSync,
  (ev) => {
    if (!ev || ev.tabId !== props.tabId) return
    for (const artifact of ev.removed) {
      saveBridge.unregister(artifact.id)
    }
    void updateFileExistsMap()
  }
)

function onWindowFocus() {
  void refreshFileStatus()
}

function onVisibilityChange() {
  if (document.visibilityState === 'visible') {
    void refreshFileStatus()
  }
}

onMounted(() => {
  document.addEventListener('mousedown', onDocumentMouseDown, true)
  document.addEventListener('keydown', onDocumentKeyDown, true)
  window.addEventListener('focus', onWindowFocus)
  document.addEventListener('visibilitychange', onVisibilityChange)
  void refreshFileStatus()
  const active = artifactStore.getActiveArtifact(props.tabId)
  if (active && !active.content?.trim() && active.filePath) {
    void artifactStore.reloadArtifactContent(props.tabId, active.id)
  }
})

onUnmounted(() => {
  document.removeEventListener('mousedown', onDocumentMouseDown, true)
  document.removeEventListener('keydown', onDocumentKeyDown, true)
  window.removeEventListener('focus', onWindowFocus)
  window.removeEventListener('visibilitychange', onVisibilityChange)
  window.removeEventListener('resize', syncArtifactPickerPosition)
  window.removeEventListener('scroll', syncArtifactPickerPosition, true)
  window.removeEventListener('resize', syncSendMenuPosition)
  window.removeEventListener('scroll', syncSendMenuPosition, true)
  offImConnectionChange?.()
})

defineExpose({ minimizePanel })
</script>

<template>
  <div class="canvas-panel">
    <div
      class="canvas-header"
      @contextmenu="openCtxMenu($event, { kind: 'header' })"
    >
      <div ref="artifactPickerRef" class="artifact-header-title">
        <button
          v-if="showArtifactSwitcher"
          type="button"
          class="artifact-file-select"
          :class="{ active: showArtifactPicker }"
          :title="t('canvas.artifactPickerTitle')"
          :aria-expanded="showArtifactPicker"
          @click="toggleArtifactPicker"
          @contextmenu="openCtxMenu($event, { kind: 'header' })"
        >
          <span class="artifact-file-select-label">{{ activeTitleLabel() }}</span>
          <ChevronDown :size="12" class="artifact-file-select-chevron" />
        </button>
        <div
          v-else
          class="artifact-file-select artifact-file-select-static"
          @contextmenu="openCtxMenu($event, { kind: 'header' })"
        >
          <span class="artifact-file-select-label">{{ activeTitleLabel() }}</span>
        </div>
      </div>
      <div class="canvas-header-actions">
        <button
          v-if="isActiveEditable"
          type="button"
          class="canvas-text-btn canvas-save-text-btn"
          :disabled="saving || !canSaveActive"
          :title="saveActiveTitle"
          @click="runSaveActive"
        >
          {{ saving ? t('common.saving') : t('canvas.saveToDisk') }}
        </button>
        <div v-if="showFileActions" class="canvas-file-actions">
          <button
            v-if="showOpenButton"
            type="button"
            class="canvas-text-btn canvas-open-btn"
            :class="{ 'canvas-open-btn--with-menu': showFileOverflowMenu }"
            :disabled="!canOpenActive"
            :title="t('canvas.openFile')"
            @click="openFile()"
          >
            {{ t('canvas.openFile') }}
          </button>
          <div v-if="showFileOverflowMenu" ref="fileMenuRef" class="canvas-file-menu-wrap">
            <button
              type="button"
              class="canvas-text-btn canvas-file-overflow-btn"
              :class="{ 'canvas-file-overflow-btn--solo': !showOpenButton }"
              :aria-expanded="showFileMenuDropdown"
              :title="t('canvas.openMenu')"
              @click="toggleFileMenu"
            >
              <ChevronDown :size="12" />
            </button>
            <div v-if="showFileMenuDropdown" class="canvas-dropdown-menu" @click.stop>
              <button
                v-if="canOpenActive"
                type="button"
                class="canvas-dropdown-item"
                @click="showInFolder(); closeFileMenu()"
              >
                <FolderOpen :size="14" />
                <span>{{ t('canvas.showInFolder') }}</span>
              </button>
              <div v-if="canOpenActive && canSaveAsActive" class="canvas-dropdown-separator" />
              <button
                v-if="canSaveAsActive"
                type="button"
                class="canvas-dropdown-item"
                :disabled="saving"
                @click="runSaveAsActive(); closeFileMenu()"
              >
                <Download :size="14" />
                <span>{{ t('canvas.saveAs') }}</span>
              </button>
              <button
                v-if="canSaveAll"
                type="button"
                class="canvas-dropdown-item"
                :disabled="saving"
                @click="runSaveAll(); closeFileMenu()"
              >
                <span>{{ t('canvas.saveAll') }}</span>
              </button>
            </div>
          </div>
        </div>
        <div v-if="canSendActive" ref="sendMenuRef" class="canvas-file-menu-wrap">
          <button
            type="button"
            class="canvas-text-btn"
            :aria-expanded="showSendMenu"
            :title="t('canvas.sendToPhone')"
            @click="toggleSendMenu"
          >
            {{ t('canvas.sendToPhone') }}
          </button>
        </div>
      </div>
    </div>

    <Teleport to="body">
      <div
        v-if="showSendMenu"
        ref="sendMenuDropdownRef"
        class="canvas-dropdown-menu canvas-send-menu canvas-send-menu--floating"
        :style="{
          top: `${sendMenuPos.top}px`,
          left: `${sendMenuPos.left}px`,
          width: `${sendMenuPos.width}px`
        }"
        @click.stop
      >
        <div v-if="sendTargetsLoading" class="canvas-send-loading">{{ t('common.loading') }}</div>
        <template v-else>
          <button
            v-for="target in sendTargets"
            :key="target.platform"
            type="button"
            class="canvas-dropdown-item canvas-send-item"
            :class="{ 'canvas-send-item--disabled': !target.connected || !target.hasContact }"
            :aria-disabled="!target.connected || !target.hasContact"
            :title="sendTargetTip(target)"
            @click="sendToChannel(target)"
          >
            <span class="canvas-send-platform">{{ channelName(target.platform) }}</span>
            <span v-if="sendingPlatform === target.platform" class="canvas-send-meta">
              {{ t('canvas.sending') }}
            </span>
            <span v-else-if="target.connected && target.hasContact && target.contactName" class="canvas-send-meta">
              {{ target.contactName }}
            </span>
            <span v-else-if="!target.connected" class="canvas-send-meta">
              {{ t('canvas.sendChannelOffline') }}
            </span>
            <span v-else-if="!target.hasContact" class="canvas-send-meta">
              {{ t('canvas.sendChannelNoSession') }}
            </span>
          </button>
        </template>
      </div>
    </Teleport>

    <Teleport to="body">
      <div
        v-if="showArtifactPicker"
        ref="artifactPickerDropdownRef"
        class="artifact-picker artifact-picker--floating"
        :style="{
          top: `${artifactPickerPos.top}px`,
          left: `${artifactPickerPos.left}px`,
          width: `${artifactPickerPos.width}px`
        }"
        @click.stop
      >
        <div v-if="showPickerSearch" class="artifact-picker-search">
          <input
            v-model="artifactPickerQuery"
            type="search"
            class="artifact-picker-input"
            :placeholder="t('canvas.artifactPickerSearch')"
            @keydown.stop
          />
        </div>
        <div class="artifact-picker-list" role="listbox">
          <div
            v-for="artifact in pickerArtifacts"
            :key="artifact.id"
            role="option"
            class="artifact-picker-row"
            :class="{ active: artifact.id === activeArtifactId }"
            :aria-selected="artifact.id === activeArtifactId"
            @contextmenu="openArtifactPickerCtxMenu($event, artifact.id)"
          >
            <button
              type="button"
              class="artifact-picker-item"
              :title="artifactTabLabel(artifact)"
              @click="selectArtifact(artifact.id)"
            >
              <span class="artifact-picker-icon-wrap" :data-type="rendererTypeKey(artifact.renderer)">
                <component :is="rendererIcon(artifact.renderer)" :size="13" class="artifact-picker-icon" />
              </span>
              <span class="artifact-picker-label">{{ artifactTabLabel(artifact) }}</span>
              <Check v-if="artifact.id === activeArtifactId" :size="13" class="artifact-picker-check" />
            </button>
            <button
              type="button"
              class="artifact-picker-close"
              :title="t('canvas.closeArtifact')"
              @click.stop="closeArtifact(artifact.id)"
            >
              <X :size="12" />
            </button>
          </div>
          <div v-if="pickerArtifacts.length === 0" class="artifact-picker-empty">
            {{ t('canvas.artifactPickerEmpty') }}
          </div>
        </div>
      </div>
    </Teleport>

    <Teleport to="body">
      <div
        v-if="ctxMenu.show && !ctxMenuFromPicker"
        class="canvas-ctx-overlay"
        @mousedown="closeCtxMenu"
        @contextmenu.prevent="closeCtxMenu"
      />
      <div
        v-if="ctxMenu.show"
        ref="ctxMenuRef"
        class="canvas-ctx-menu"
        :class="{ 'canvas-ctx-menu--elevated': ctxMenuFromPicker }"
        :style="{ left: `${ctxMenu.x}px`, top: `${ctxMenu.y}px` }"
        @click.stop
        @contextmenu.prevent
      >
      <template v-if="ctxMenu.target?.kind === 'tab' && ctxArtifact && ctxMenuFlags">
        <div class="canvas-ctx-header" :title="artifactTabLabel(ctxArtifact)">{{ artifactTabLabel(ctxArtifact) }}</div>
        <div v-if="ctxArtifact.filePath" class="canvas-ctx-path" :title="ctxArtifact.filePath">
          {{ ctxArtifact.filePath }}
        </div>
        <div
          v-if="ctxArtifact.filePath || artifactHasFileActions(ctxMenuFlags)"
          class="canvas-ctx-separator"
        />
        <button
          v-if="ctxMenuFlags.showOpen"
          type="button"
          class="canvas-ctx-item"
          @click="openFileFor(ctxArtifact); closeCtxMenu()"
        >
          {{ t('canvas.openFile') }}
        </button>
        <button
          v-if="ctxMenuFlags.showOpen"
          type="button"
          class="canvas-ctx-item"
          @click="showInFolderFor(ctxArtifact); closeCtxMenu()"
        >
          {{ t('canvas.showInFolder') }}
        </button>
        <div
          v-if="ctxMenuFlags.showOpen && (ctxMenuFlags.showSave || ctxMenuFlags.showSaveAs)"
          class="canvas-ctx-separator"
        />
        <button
          v-if="ctxMenuFlags.showSave"
          type="button"
          class="canvas-ctx-item"
          :disabled="saving"
          @click="runSave(ctxArtifact); closeCtxMenu()"
        >
          {{ t('canvas.saveToDisk') }}
        </button>
        <button
          v-if="ctxMenuFlags.showSaveAs"
          type="button"
          class="canvas-ctx-item"
          :disabled="saving"
          @click="runSaveAs(ctxArtifact); closeCtxMenu()"
        >
          {{ t('canvas.saveAs') }}
        </button>
        <div class="canvas-ctx-separator" />
        <button
          type="button"
          class="canvas-ctx-item"
          @click="closeArtifact(ctxArtifact.id); closeCtxMenu()"
        >
          {{ t('canvas.closeArtifact') }}
        </button>
        <button
          v-if="ctxMenuFlags.showCloseOthers"
          type="button"
          class="canvas-ctx-item"
          @click="closeOthers(ctxArtifact.id); closeCtxMenu()"
        >
          {{ t('canvas.closeOthers') }}
        </button>
        <button
          type="button"
          class="canvas-ctx-item danger"
          @click="closeAllArtifacts(); closeCtxMenu()"
        >
          {{ t('canvas.closeAll') }}
        </button>
        <template v-if="ctxMenuFlags.showJumpToSource">
          <div class="canvas-ctx-separator" />
          <button
            type="button"
            class="canvas-ctx-item"
            @click="jumpToSource(ctxArtifact.sourceStepId); closeCtxMenu()"
          >
            {{ t('canvas.jumpToSource') }}
          </button>
        </template>
      </template>
      <template v-else-if="ctxMenu.target?.kind === 'header'">
        <button
          v-if="canOpenActive"
          type="button"
          class="canvas-ctx-item"
          @click="openFile(); closeCtxMenu()"
        >
          {{ t('canvas.openFile') }}
        </button>
        <button
          v-if="canOpenActive"
          type="button"
          class="canvas-ctx-item"
          @click="showInFolder(); closeCtxMenu()"
        >
          {{ t('canvas.showInFolder') }}
        </button>
        <div
          v-if="canOpenActive && (isActiveEditable || canSaveAsActive || canSaveAll)"
          class="canvas-ctx-separator"
        />
        <button
          v-if="isActiveEditable"
          type="button"
          class="canvas-ctx-item"
          :disabled="saving || !canSaveActive"
          :title="saveActiveTitle"
          @click="runSaveActive(); closeCtxMenu()"
        >
          {{ t('canvas.saveToDisk') }}
        </button>
        <button
          v-if="canSaveAsActive"
          type="button"
          class="canvas-ctx-item"
          :disabled="saving"
          @click="runSaveAsActive(); closeCtxMenu()"
        >
          {{ t('canvas.saveAs') }}
        </button>
        <button
          v-if="canSaveAll"
          type="button"
          class="canvas-ctx-item"
          :disabled="saving"
          @click="runSaveAll(); closeCtxMenu()"
        >
          {{ t('canvas.saveAll') }}
        </button>
        <div
          v-if="isActiveEditable || canSaveAsActive || canSaveAll"
          class="canvas-ctx-separator"
        />
        <button
          v-if="artifacts.length > 0"
          type="button"
          class="canvas-ctx-item danger"
          @click="closeAllArtifacts(); closeCtxMenu()"
        >
          {{ t('canvas.closeAll') }}
        </button>
        <template v-if="activeSourceStepId">
          <div class="canvas-ctx-separator" />
          <button
            type="button"
            class="canvas-ctx-item"
            @click="jumpToSource(); closeCtxMenu()"
          >
            {{ t('canvas.jumpToSource') }}
          </button>
        </template>
      </template>
      </div>
    </Teleport>

    <div v-if="activeArtifactId" class="canvas-body" :class="{ 'canvas-body--no-pointer': anyMenuOpen }">
      <div class="canvas-renderer-host">
        <component
          :is="activeRendererComponent"
          v-if="activeRendererComponent"
          :key="activeArtifactId"
          :tab-id="tabId"
          :artifact-id="activeArtifactId"
          @capture-feedback="onCaptureFeedback"
        />
        <div v-else class="canvas-unsupported">
          {{ t('canvas.unsupportedRenderer') }}
        </div>
      </div>
    </div>

    <HoverTipOverlay :tip="hoverTip" />
  </div>
</template>

<style scoped>
.canvas-panel {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  width: 100%;
  min-width: 0;
  min-height: 0;
  background: var(--bg-primary, #1e1e1e);
  border-left: 1px solid var(--border-color, rgba(255, 255, 255, 0.08));
}

.canvas-header {
  display: flex;
  align-items: center;
  gap: 12px;
  box-sizing: border-box;
  height: var(--workbench-panel-header-height, 38px);
  min-height: var(--workbench-panel-header-height, 38px);
  padding: 0 38px 0 12px;
  background: var(--bg-tertiary, var(--bg-secondary, #252525));
  border-bottom: 1px solid var(--border-color, rgba(255, 255, 255, 0.08));
  flex-shrink: 0;
  user-select: none;
  container-type: inline-size;
  container-name: artifact-header;
}

.artifact-header-title {
  display: flex;
  align-items: center;
  min-width: 0;
  flex: 0 1 auto;
  max-width: min(240px, 55%);
}

/* 触发器 typography 与 AiPanel model-select-sm 对齐，见 WorkbenchShell 非 scoped 样式 */
.artifact-file-select-static {
  cursor: default;
  padding-right: 8px;
}

@container artifact-header (max-width: 420px) {
  .artifact-header-title {
    max-width: min(160px, 45%);
  }
}

.artifact-picker {
  padding: 6px;
  background: var(--bg-secondary, #252525);
  border: 1px solid var(--border-color, rgba(255, 255, 255, 0.12));
  border-radius: 6px;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.28);
}

.artifact-picker--floating {
  position: fixed;
  z-index: 10000;
  max-width: calc(100vw - 16px);
  max-height: calc(100vh - 120px);
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.artifact-picker-search {
  padding: 2px 2px 6px;
}

.artifact-picker-input {
  width: 100%;
  box-sizing: border-box;
  height: 30px;
  padding: 0 10px;
  border: 1px solid var(--border-color, rgba(255, 255, 255, 0.12));
  border-radius: 4px;
  background: var(--bg-primary, #1e1e1e);
  color: var(--text-primary, #eee);
  font-size: 13px;
  outline: none;
}

.artifact-picker-input:focus {
  border-color: rgba(var(--accent-rgb, 137, 180, 250), 0.45);
}

.artifact-picker-list {
  flex: 1;
  min-height: 0;
  max-height: 480px;
  overflow-y: auto;
}

.artifact-picker-row {
  display: flex;
  align-items: flex-start;
  gap: 2px;
  border-radius: 6px;
  padding: 1px 2px;
}

.artifact-picker-row.active {
  background: rgba(var(--accent-rgb, 137, 180, 250), 0.1);
}

.artifact-picker-row.active .artifact-picker-item {
  color: var(--accent-primary, #89b4fa);
}

.artifact-picker-item {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  flex: 1;
  min-width: 0;
  min-height: 38px;
  padding: 6px 8px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--text-primary, #eee);
  font-size: 13px;
  line-height: 1.35;
  text-align: left;
  cursor: pointer;
  transition: background 0.1s;
}

.artifact-picker-item:hover {
  background: var(--hover-bg, rgba(255, 255, 255, 0.07));
}

/* icon wrap with type-based color accent */
.artifact-picker-icon-wrap {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  margin-top: 1px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.06);
  color: var(--text-secondary, #aaa);
  transition: background 0.1s;
}

.artifact-picker-icon-wrap[data-type="markdown"] {
  background: rgba(137, 180, 250, 0.14);
  color: #89b4fa;
}
.artifact-picker-icon-wrap[data-type="html"] {
  background: rgba(250, 179, 135, 0.14);
  color: #fab387;
}
.artifact-picker-icon-wrap[data-type="spreadsheet"] {
  background: rgba(166, 227, 161, 0.14);
  color: #a6e3a1;
}
.artifact-picker-icon-wrap[data-type="document"] {
  background: rgba(203, 166, 247, 0.14);
  color: #cba6f7;
}
.artifact-picker-icon-wrap[data-type="pdf"] {
  background: rgba(243, 139, 168, 0.14);
  color: #f38ba8;
}
.artifact-picker-icon-wrap[data-type="image"] {
  background: rgba(249, 226, 175, 0.14);
  color: #f9e2af;
}
.artifact-picker-icon-wrap[data-type="browser"] {
  background: rgba(148, 226, 213, 0.14);
  color: #94e2d5;
}

.artifact-picker-icon {
  flex-shrink: 0;
}

.artifact-picker-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow-wrap: anywhere;
  word-break: break-word;
  white-space: normal;
  font-size: 13px;
  font-weight: 500;
  line-height: 1.35;
}

.artifact-picker-check {
  flex-shrink: 0;
  margin-top: 4px;
  color: var(--accent-primary, #89b4fa);
  opacity: 0.85;
}

.artifact-picker-close {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  margin-top: 4px;
  margin-right: 4px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--text-secondary, #aaa);
  cursor: pointer;
  opacity: 0;
  transition: background 0.1s, color 0.1s, opacity 0.1s;
}

.artifact-picker-row:hover .artifact-picker-close {
  opacity: 1;
}

.artifact-picker-close:hover {
  background: rgba(244, 63, 94, 0.12);
  color: #f87171;
}


.canvas-ctx-header {
  padding: 6px 14px 2px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-primary, #eee);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.canvas-ctx-path {
  padding: 0 14px 6px;
  font-size: 10px;
  color: var(--text-secondary, #888);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 280px;
}

.artifact-picker-empty {
  padding: 10px 8px;
  color: var(--text-secondary, #888);
  font-size: 12px;
  text-align: center;
}

.canvas-header-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
  margin-left: auto;
}

.canvas-text-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 22px;
  padding: 0 8px;
  border: 1px solid var(--border-color, rgba(255, 255, 255, 0.14));
  border-radius: 4px;
  background: transparent;
  color: var(--text-primary, #eee);
  font-size: 11px;
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.12s, border-color 0.12s;
}

.canvas-text-btn:hover:not(:disabled) {
  background: var(--hover-bg, rgba(255, 255, 255, 0.08));
}

.canvas-header-actions .canvas-save-text-btn:hover:not(:disabled) {
  color: var(--accent-primary, #89b4fa);
  border-color: rgba(var(--accent-rgb, 137, 180, 250), 0.35);
}

.canvas-text-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.canvas-save-text-btn:not(:disabled) {
  border-color: rgba(var(--accent-rgb, 137, 180, 250), 0.35);
  color: var(--accent-primary, #89b4fa);
}

.canvas-file-actions {
  display: flex;
  align-items: center;
}

.canvas-open-btn--with-menu {
  border-top-right-radius: 0;
  border-bottom-right-radius: 0;
  border-right: none;
}

.canvas-file-overflow-btn {
  padding: 0 5px;
  min-width: 22px;
  justify-content: center;
}

.canvas-file-overflow-btn:not(.canvas-file-overflow-btn--solo) {
  border-top-left-radius: 0;
  border-bottom-left-radius: 0;
}

.canvas-file-menu-wrap {
  position: relative;
}

.canvas-dropdown-menu {
  position: absolute;
  top: calc(100% + 4px);
  right: 0;
  min-width: 160px;
  padding: 4px;
  background: var(--bg-secondary, #252525);
  border: 1px solid var(--border-color, rgba(255, 255, 255, 0.12));
  border-radius: 6px;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.28);
  z-index: 20;
}

.canvas-dropdown-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 10px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--text-primary, #eee);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
  transition: background 0.12s;
}

.canvas-dropdown-item:hover:not(:disabled) {
  background: var(--hover-bg, rgba(255, 255, 255, 0.08));
}

.canvas-dropdown-item:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.canvas-dropdown-separator {
  height: 1px;
  margin: 4px 0;
  background: var(--border-color, rgba(255, 255, 255, 0.1));
}

.canvas-send-menu--floating {
  position: fixed;
  top: auto;
  right: auto;
  z-index: 10000;
  box-sizing: border-box;
  max-height: calc(100vh - 120px);
  overflow-y: auto;
}

.canvas-send-loading {
  padding: 6px 10px;
  font-size: 12px;
  color: var(--text-secondary, #999);
}

.canvas-send-item {
  justify-content: space-between;
}

.canvas-send-item--disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.canvas-send-item--disabled:hover {
  background: transparent;
}

.canvas-send-platform {
  flex-shrink: 0;
  white-space: nowrap;
}

.canvas-send-meta {
  margin-left: 12px;
  font-size: 11px;
  color: var(--text-secondary, #999);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.canvas-body {
  flex: 1;
  overflow: hidden;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.canvas-body--no-pointer {
  pointer-events: none;
}

.canvas-renderer-host {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.canvas-renderer-host > * {
  flex: 1 1 auto;
  min-height: 0;
  min-width: 0;
}

.canvas-ctx-overlay {
  position: fixed;
  inset: 0;
  z-index: 9998;
}

.canvas-ctx-menu {
  position: fixed;
  z-index: 9999;
  min-width: 168px;
  padding: 4px 0;
  background: var(--bg-secondary, #252525);
  border: 1px solid var(--border-color, rgba(255, 255, 255, 0.12));
  border-radius: 6px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.32);
}

.canvas-ctx-menu--elevated {
  z-index: 10001;
}

.canvas-ctx-item {
  display: block;
  width: 100%;
  padding: 7px 14px;
  border: none;
  background: transparent;
  color: var(--text-primary, #eee);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
  transition: background 0.12s, color 0.12s;
}

.canvas-ctx-item:hover:not(:disabled) {
  background: var(--hover-bg, rgba(255, 255, 255, 0.08));
}

.canvas-ctx-item:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.canvas-ctx-item.danger {
  color: var(--text-secondary, #ccc);
}

.canvas-ctx-item.danger:hover:not(:disabled) {
  background: rgba(244, 63, 94, 0.12);
  color: #f87171;
}

.canvas-ctx-separator {
  height: 1px;
  margin: 4px 0;
  background: var(--border-color, rgba(255, 255, 255, 0.1));
}

.canvas-unsupported {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 1;
  padding: 24px;
  color: var(--text-secondary, #aaa);
  font-size: 13px;
}
</style>
