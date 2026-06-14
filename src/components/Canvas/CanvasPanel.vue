<script setup lang="ts">
/**
 * Canvas Artifact 面板
 *
 * 独立助手右侧产出物工作区：多 tab 切换 + 按 renderer 动态加载视图。
 */
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  X,
  FolderOpen,
  ChevronDown,
  Folder
} from 'lucide-vue-next'
import type { CanvasArtifact, CanvasRendererType } from '@shared/types'
import {
  canSaveAsArtifact,
  filterArtifactsByQuery,
  isArtifactEditable,
  saveArtifact,
  saveArtifactAs,
  sortArtifactsByRecent,
  refreshFilePathExistsMap,
  type ArtifactSaveDeps
} from '../../canvas'
import { getRendererComponent, getRendererIcon } from './renderer-ui-registry'
import {
  getArtifactContextMenuFlags,
  artifactHasFileActions
} from '../../canvas/artifact-context-menu'
import {
  createArtifactSaveBridge,
  provideArtifactSaveBridge
} from '../../canvas/artifact-save-bridge'
import { useCanvasStore } from '../../stores/canvas'
import { useToast } from '../../composables/useToast'

const props = defineProps<{
  tabId: string
}>()

const { t } = useI18n()
const canvasStore = useCanvasStore()
const { success: toastSuccess, error: toastError, info: toastInfo } = useToast()
const saveBridge = createArtifactSaveBridge()
provideArtifactSaveBridge(saveBridge)

const artifacts = computed(() => canvasStore.getArtifacts(props.tabId))
const activeArtifact = computed(() => canvasStore.getActiveArtifact(props.tabId))
const activeArtifactId = computed(() => activeArtifact.value?.id ?? null)
const renderer = computed(() => activeArtifact.value?.renderer ?? null)
const filePath = computed(() => activeArtifact.value?.filePath ?? null)
const isEmptyState = computed(() => canvasStore.isEmptyState(props.tabId))
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

const showFileMenu = computed(() =>
  Boolean(filePath.value) || canSaveAsActive.value || canSaveAll.value
)

const tabsScrollRef = ref<HTMLElement | null>(null)
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

const headerTabs = computed(() => sortArtifactsByRecent(artifacts.value))
const showTabList = computed(() => artifacts.value.length >= 2)

const allArtifactsSorted = computed(() => sortArtifactsByRecent(artifacts.value))
const pickerArtifacts = computed(() =>
  filterArtifactsByQuery(allArtifactsSorted.value, artifactPickerQuery.value)
)
const showPickerSearch = computed(() => artifacts.value.length >= 4)

const ctxArtifact = computed(() => {
  if (ctxMenu.value.target?.kind !== 'tab') return null
  return canvasStore.getArtifactById(props.tabId, ctxMenu.value.target.artifactId)
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

function artifactTabTitle(artifact: CanvasArtifact) {
  return artifactTabLabel(artifact.title)
}

async function updateFileExistsMap() {
  const remaining = canvasStore.getArtifacts(props.tabId)
  fileExistsMap.value = remaining.length > 0
    ? await refreshFilePathExistsMap(remaining)
    : new Map()
}

async function refreshFileStatus() {
  await canvasStore.syncArtifactsWithDisk(props.tabId)
  await updateFileExistsMap()
}

function toggleFileMenu() {
  const next = !showFileMenuDropdown.value
  showFileMenuDropdown.value = next
  if (next) {
    closeArtifactPicker()
    closeCtxMenu()
  }
}

function closeFileMenu() {
  showFileMenuDropdown.value = false
}

function artifactTabLabel(artifactTitle: string) {
  return artifactTitle || t('canvas.artifactUntitled')
}

function artifactPickerSubtitle(artifact: CanvasArtifact): string {
  if (artifact.filePath) return artifact.filePath
  return t('canvas.noPathShort')
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
      const a = canvasStore.getArtifactById(props.tabId, artifactId)
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
  canvasStore.setActiveArtifact(props.tabId, id)
  closeArtifactPicker()
  scrollActiveTabIntoView()
  void refreshFileStatus()
}

function syncArtifactPickerPosition() {
  if (!showArtifactPicker.value) return
  const anchor = artifactPickerRef.value
  if (!anchor) return
  const rect = anchor.getBoundingClientRect()
  const width = Math.min(340, Math.max(260, window.innerWidth - 16))
  let left = rect.right - width
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
  canvasStore.removeArtifact(props.tabId, id)
}

function closeOthers(keepId: string) {
  flushActiveDraft()
  canvasStore.closeOthers(props.tabId, keepId)
}

function closeAllArtifacts() {
  flushActiveDraft()
  canvasStore.closeAll(props.tabId)
}

function handleCloseActive() {
  if (activeArtifactId.value) {
    canvasStore.close(props.tabId, activeArtifactId.value)
  }
}

function dismissEmptyPanel() {
  canvasStore.dismissPanel(props.tabId)
}

function jumpToSource(stepId?: string) {
  const id = stepId ?? activeSourceStepId.value
  if (!id) return
  closeAllMenus()
  canvasStore.requestJumpToSource(props.tabId, id)
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
      canvasStore.updateContent(props.tabId, getArtifactContent(artifact), artifact.id)
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
      canvasStore.relocateArtifact(
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
        canvasStore.updateContent(props.tabId, getArtifactContent(a), a.id)
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
  closeCtxMenu()
  if (!options?.keepArtifactPicker) {
    closeArtifactPicker()
  }
}

function closeAllMenus() {
  closeOverlayMenus()
}

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

function onTabAuxClick(e: MouseEvent, id: string) {
  if (e.button === 1) {
    e.preventDefault()
    closeArtifact(id, e)
  }
}

function scrollActiveTabIntoView() {
  nextTick(() => {
    const root = tabsScrollRef.value
    if (!root) return
    const activeEl = root.querySelector('.artifact-tab.active')
    activeEl?.scrollIntoView({ inline: 'nearest', block: 'nearest' })
  })
}

function onDocumentMouseDown(e: MouseEvent) {
  const target = e.target as Node
  if (showFileMenuDropdown.value) {
    const el = fileMenuRef.value
    if (el && !el.contains(target)) closeFileMenu()
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

watch(activeArtifactId, () => {
  scrollActiveTabIntoView()
})

watch(artifacts, () => {
  void refreshFileStatus()
}, { deep: true })

watch(
  () => canvasStore.lastDiskSync,
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
  scrollActiveTabIntoView()
})

onUnmounted(() => {
  document.removeEventListener('mousedown', onDocumentMouseDown, true)
  document.removeEventListener('keydown', onDocumentKeyDown, true)
  window.removeEventListener('focus', onWindowFocus)
  window.removeEventListener('visibilitychange', onVisibilityChange)
  window.removeEventListener('resize', syncArtifactPickerPosition)
  window.removeEventListener('scroll', syncArtifactPickerPosition, true)
})
</script>

<template>
  <div class="canvas-panel">
    <div
      class="canvas-header"
      @contextmenu="openCtxMenu($event, { kind: 'header' })"
    >
      <div v-if="artifacts.length > 0" class="artifact-tabs-bar">
        <div ref="tabsScrollRef" class="artifact-tabs-scroll">
          <div class="artifact-tabs" role="tablist">
            <button
              v-for="artifact in headerTabs"
              :key="artifact.id"
              type="button"
              role="tab"
              class="artifact-tab"
              :class="{ active: artifact.id === activeArtifactId }"
              :aria-selected="artifact.id === activeArtifactId"
              :title="artifactTabTitle(artifact)"
              @click="selectArtifact(artifact.id)"
              @contextmenu="openCtxMenu($event, { kind: 'tab', artifactId: artifact.id })"
              @auxclick="onTabAuxClick($event, artifact.id)"
            >
              <component :is="rendererIcon(artifact.renderer)" :size="13" class="artifact-tab-icon" />
              <span class="artifact-tab-label">{{ artifactTabLabel(artifact.title) }}</span>
              <span
                class="artifact-tab-close"
                role="button"
                :title="t('canvas.closeArtifact')"
                @click="closeArtifact(artifact.id, $event)"
              >
                <X :size="10" />
              </span>
            </button>
          </div>
        </div>
        <div v-if="showTabList" ref="artifactPickerRef" class="artifact-list-wrap">
          <button
            type="button"
            class="artifact-list-btn"
            :class="{ active: showArtifactPicker }"
            :title="t('canvas.artifactPickerTitle')"
            :aria-expanded="showArtifactPicker"
            @click="toggleArtifactPicker"
          >
            <span class="artifact-list-count">{{ artifacts.length }}</span>
            <ChevronDown :size="12" />
          </button>
        </div>
      </div>
      <div v-else class="canvas-header-empty">
        <span class="canvas-header-empty-label">{{ t('canvas.emptyStateTitle') }}</span>
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
        <div v-if="showFileMenu" ref="fileMenuRef" class="canvas-file-menu-wrap">
          <button
            type="button"
            class="canvas-text-btn"
            :aria-expanded="showFileMenuDropdown"
            @click="toggleFileMenu"
          >
            <span>{{ t('canvas.fileMenu') }}</span>
            <ChevronDown :size="12" />
          </button>
          <div v-if="showFileMenuDropdown" class="canvas-dropdown-menu" @click.stop>
            <button
              type="button"
              class="canvas-dropdown-item"
              :disabled="!canOpenActive"
              @click="openFile(); closeFileMenu()"
            >
              <FolderOpen :size="14" />
              <span>{{ t('canvas.openFile') }}</span>
            </button>
            <button
              type="button"
              class="canvas-dropdown-item"
              :disabled="!canOpenActive"
              @click="showInFolder(); closeFileMenu()"
            >
              <Folder :size="14" />
              <span>{{ t('canvas.showInFolder') }}</span>
            </button>
            <div v-if="canSaveAsActive" class="canvas-dropdown-separator" />
            <button
              v-if="canSaveAsActive"
              type="button"
              class="canvas-dropdown-item"
              :disabled="saving"
              @click="runSaveAsActive(); closeFileMenu()"
            >
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
        <button
          v-if="activeArtifactId || isEmptyState"
          class="canvas-close"
          @click="isEmptyState ? dismissEmptyPanel() : handleCloseActive()"
          :title="isEmptyState ? t('canvas.dismissEmptyPanel') : t('canvas.closeArtifact')"
        >
          <X :size="14" />
        </button>
      </div>
    </div>

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
              @click="selectArtifact(artifact.id)"
            >
              <component :is="rendererIcon(artifact.renderer)" :size="14" class="artifact-picker-icon" />
              <span class="artifact-picker-text">
                <span class="artifact-picker-label">{{ artifactTabLabel(artifact.title) }}</span>
                <span class="artifact-picker-sub" :title="artifactPickerSubtitle(artifact)">
                  {{ artifactPickerSubtitle(artifact) }}
                </span>
              </span>
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
        <div class="canvas-ctx-header">{{ artifactTabLabel(ctxArtifact.title) }}</div>
        <div v-if="ctxArtifact.filePath" class="canvas-ctx-path" :title="ctxArtifact.filePath">
          {{ ctxArtifact.filePath }}
        </div>
        <button
          v-if="ctxMenuFlags.showJumpToSource"
          type="button"
          class="canvas-ctx-item"
          @click="jumpToSource(ctxArtifact.sourceStepId); closeCtxMenu()"
        >
          {{ t('canvas.jumpToSource') }}
        </button>
        <div
          v-if="ctxMenuFlags.showJumpToSource || ctxArtifact.filePath || artifactHasFileActions(ctxMenuFlags)"
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
      </template>
      <template v-else-if="ctxMenu.target?.kind === 'header'">
        <button
          v-if="activeSourceStepId"
          type="button"
          class="canvas-ctx-item"
          @click="jumpToSource(); closeCtxMenu()"
        >
          {{ t('canvas.jumpToSource') }}
        </button>
        <div
          v-if="activeSourceStepId && (canOpenActive || isActiveEditable || canSaveAsActive || canSaveAll)"
          class="canvas-ctx-separator"
        />
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
      </template>
      </div>
    </Teleport>

    <div v-if="isEmptyState" class="canvas-body canvas-empty-body">
      <p class="canvas-empty-text">{{ t('canvas.emptyStateHint') }}</p>
      <button type="button" class="canvas-empty-dismiss" @click="dismissEmptyPanel">
        {{ t('canvas.dismissEmptyPanel') }}
      </button>
    </div>

    <div v-else-if="activeArtifactId" class="canvas-body">
      <div class="canvas-renderer-host">
        <component
          :is="activeRendererComponent"
          v-if="activeRendererComponent"
          :key="activeArtifactId"
          :tab-id="tabId"
          :artifact-id="activeArtifactId"
        />
        <div v-else class="canvas-unsupported">
          {{ t('canvas.unsupportedRenderer') }}
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.canvas-panel {
  display: flex;
  flex-direction: column;
  flex: 1;
  height: 100%;
  min-width: 0;
  background: var(--bg-primary, #1e1e1e);
  border-left: 1px solid var(--border-color, rgba(255, 255, 255, 0.08));
}

.canvas-header {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 4px;
  padding: 4px 6px 4px 4px;
  background: var(--bg-secondary, #252525);
  border-bottom: 1px solid var(--border-color, rgba(255, 255, 255, 0.08));
  flex-shrink: 0;
  user-select: none;
  min-height: 28px;
}

.artifact-tabs-bar {
  display: flex;
  align-items: stretch;
  min-width: 0;
  height: 28px;
}

.artifact-tabs-scroll {
  flex: 1;
  min-width: 0;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none;
}

.artifact-tabs-scroll::-webkit-scrollbar {
  display: none;
}

.artifact-tabs {
  display: flex;
  align-items: stretch;
  gap: 0;
  min-width: min-content;
  height: 100%;
}

.artifact-tab {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-width: 72px;
  max-width: 120px;
  height: 100%;
  padding: 0 8px;
  border: none;
  border-radius: 0;
  background: transparent;
  color: var(--text-muted, #888);
  font-size: 12px;
  cursor: pointer;
  flex-shrink: 0;
  transition: color 0.2s ease;
}

.artifact-tab::after {
  content: '';
  position: absolute;
  left: 50%;
  bottom: 0;
  width: 0;
  height: 2px;
  background: linear-gradient(90deg, var(--accent-primary, #89b4fa), var(--accent-secondary, #74c7ec));
  border-radius: 1px;
  transform: translateX(-50%);
  transition: width 0.2s ease;
}

.artifact-tab:hover {
  color: var(--text-primary, #eee);
}

.artifact-tab.active {
  color: var(--text-primary, #eee);
  font-weight: 600;
}

.artifact-tab.active::after {
  width: calc(100% - 16px);
}

.artifact-tab-icon {
  flex-shrink: 0;
  color: inherit;
  opacity: 0.85;
}

.artifact-tab.active .artifact-tab-icon {
  color: var(--accent-primary, #89b4fa);
}

.artifact-tab-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
  flex: 1;
}

.artifact-tab-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  border-radius: 3px;
  flex-shrink: 0;
  opacity: 0;
  transition: opacity 0.12s, background 0.12s;
}

.artifact-tab:hover .artifact-tab-close,
.artifact-tab.active .artifact-tab-close {
  opacity: 0.65;
}

.artifact-tab-close:hover {
  opacity: 1;
  background: var(--hover-bg, rgba(255, 255, 255, 0.1));
}

.artifact-list-wrap {
  position: relative;
  flex-shrink: 0;
  display: flex;
  align-items: stretch;
  border-left: 1px solid var(--border-color, rgba(255, 255, 255, 0.08));
}

.artifact-list-btn {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  height: 100%;
  padding: 0 8px;
  border: none;
  border-radius: 0;
  background: transparent;
  color: var(--text-muted, #888);
  font-size: 11px;
  cursor: pointer;
  white-space: nowrap;
  transition: color 0.2s ease, background 0.12s;
}

.artifact-list-btn:hover,
.artifact-list-btn.active {
  color: var(--text-primary, #eee);
  background: var(--hover-bg, rgba(255, 255, 255, 0.04));
}

.artifact-list-count {
  min-width: 14px;
  text-align: center;
  font-variant-numeric: tabular-nums;
}

.artifact-picker {
  padding: 4px;
  background: var(--bg-secondary, #252525);
  border: 1px solid var(--border-color, rgba(255, 255, 255, 0.12));
  border-radius: 6px;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.28);
}

.artifact-picker--floating {
  position: fixed;
  z-index: 10000;
  max-width: calc(100vw - 16px);
  box-sizing: border-box;
}

.artifact-picker-search {
  padding: 2px 2px 4px;
}

.artifact-picker-input {
  width: 100%;
  box-sizing: border-box;
  height: 26px;
  padding: 0 8px;
  border: 1px solid var(--border-color, rgba(255, 255, 255, 0.12));
  border-radius: 4px;
  background: var(--bg-primary, #1e1e1e);
  color: var(--text-primary, #eee);
  font-size: 12px;
  outline: none;
}

.artifact-picker-input:focus {
  border-color: rgba(var(--accent-rgb, 137, 180, 250), 0.45);
}

.artifact-picker-list {
  max-height: 280px;
  overflow-y: auto;
}

.artifact-picker-row {
  display: flex;
  align-items: center;
  gap: 2px;
  border-radius: 4px;
}

.artifact-picker-row.active {
  background: rgba(var(--accent-rgb, 137, 180, 250), 0.1);
}

.artifact-picker-item {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  min-width: 0;
  padding: 6px 8px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--text-primary, #eee);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
  transition: background 0.12s;
}

.artifact-picker-item:hover {
  background: var(--hover-bg, rgba(255, 255, 255, 0.08));
}

.artifact-picker-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  margin-right: 2px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--text-secondary, #aaa);
  cursor: pointer;
  flex-shrink: 0;
  opacity: 0;
  transition: opacity 0.12s, background 0.12s, color 0.12s;
}

.artifact-picker-row:hover .artifact-picker-close {
  opacity: 0.85;
}

.artifact-picker-close:hover {
  background: rgba(255, 255, 255, 0.1);
  color: var(--text-primary, #eee);
}

.artifact-picker-icon {
  flex-shrink: 0;
  opacity: 0.85;
}

.artifact-picker-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

.artifact-picker-text {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
  flex: 1;
}

.artifact-picker-sub {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 10px;
  color: var(--text-secondary, #888);
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
  padding-left: 4px;
  border-left: 1px solid var(--border-color, rgba(255, 255, 255, 0.08));
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

.canvas-text-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.canvas-save-text-btn:not(:disabled) {
  border-color: rgba(var(--accent-rgb, 137, 180, 250), 0.35);
  color: var(--accent-primary, #89b4fa);
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

.canvas-close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--text-secondary, #aaa);
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}

.canvas-close:hover {
  background: var(--hover-bg, rgba(255, 255, 255, 0.1));
  color: var(--text-primary, #fff);
}

.canvas-body {
  flex: 1;
  overflow: hidden;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.canvas-renderer-host {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
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

.canvas-header-empty {
  min-width: 0;
  padding: 0 4px;
}

.canvas-header-empty-label {
  font-size: 12px;
  color: var(--text-secondary, #aaa);
}

.canvas-empty-body {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 32px 24px;
}

.canvas-empty-text {
  margin: 0;
  max-width: 280px;
  font-size: 13px;
  line-height: 1.5;
  color: var(--text-secondary, #aaa);
  text-align: center;
}

.canvas-empty-dismiss {
  padding: 6px 12px;
  border: 1px solid var(--border-color, rgba(255, 255, 255, 0.12));
  border-radius: 6px;
  background: transparent;
  color: var(--text-primary, #eee);
  font-size: 12px;
  cursor: pointer;
}

.canvas-empty-dismiss:hover {
  background: var(--hover-bg, rgba(255, 255, 255, 0.06));
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
