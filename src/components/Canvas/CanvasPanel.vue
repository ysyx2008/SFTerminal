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
  FileText,
  Table2,
  FileCode,
  Presentation,
  FolderOpen,
  ChevronDown,
  Folder
} from 'lucide-vue-next'
import type { CanvasArtifact, CanvasRendererType } from '@shared/types'
import {
  canSaveAsArtifact,
  filterArtifactsByQuery,
  pickVisibleArtifactTabs,
  saveArtifact,
  saveArtifactAs,
  sortArtifactsByRecent,
  refreshFilePathExistsMap,
  type ArtifactSaveDeps
} from '../../canvas'
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
import DocumentRenderer from './DocumentRenderer.vue'
import SpreadsheetRenderer from './SpreadsheetRenderer.vue'
import MarkdownRenderer from './MarkdownRenderer.vue'
import SlidesRenderer from './SlidesRenderer.vue'

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
const isMarkdownActive = computed(() => renderer.value === 'markdown')
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
    a.renderer === 'markdown' &&
    Boolean(a.filePath) &&
    fileExistsMap.value.get(a.filePath!) !== false &&
    saveBridge.isDirty(a.id)
  )
)
/** 保存：仅 Markdown、磁盘文件仍在、且有未保存编辑 */
const canSaveActive = computed(() =>
  isMarkdownActive.value &&
  Boolean(filePath.value) &&
  pathExistsOnDisk(filePath.value) &&
  activeDirty.value
)

const saveActiveTitle = computed(() => {
  if (!isMarkdownActive.value) return ''
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
const showArtifactPicker = ref(false)
const artifactPickerQuery = ref('')
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

const tabLayout = computed(() =>
  pickVisibleArtifactTabs(artifacts.value, activeArtifactId.value)
)
const visibleTabs = computed(() => tabLayout.value.visible)
const overflowCount = computed(() => tabLayout.value.overflowCount)

const allArtifactsSorted = computed(() => sortArtifactsByRecent(artifacts.value))
const pickerArtifacts = computed(() =>
  filterArtifactsByQuery(allArtifactsSorted.value, artifactPickerQuery.value)
)
const showPickerSearch = computed(() => artifacts.value.length >= 6)

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
  switch (type) {
    case 'document': return FileText
    case 'spreadsheet': return Table2
    case 'markdown': return FileCode
    case 'html': return Presentation
    default: return FileText
  }
}

function artifactTabTitle(artifact: CanvasArtifact) {
  return artifactTabLabel(artifact.title)
}

function showRemovedToast(removed: readonly CanvasArtifact[]) {
  if (removed.length === 1) {
    toastInfo(t('canvas.autoRemovedOne', { name: artifactTabLabel(removed[0].title) }))
  } else if (removed.length > 1) {
    toastInfo(t('canvas.autoRemovedMany', { count: removed.length }))
  }
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
  showFileMenuDropdown.value = !showFileMenuDropdown.value
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

function toggleArtifactPicker() {
  showArtifactPicker.value = !showArtifactPicker.value
  if (!showArtifactPicker.value) {
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

async function openFileFor(artifact: CanvasArtifact) {
  closeAllMenus()
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
  closeAllMenus()
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

function closeAllMenus() {
  closeFileMenu()
  closeArtifactPicker()
  closeCtxMenu()
}

function openCtxMenu(e: MouseEvent, target: ContextTarget) {
  e.preventDefault()
  e.stopPropagation()
  closeAllMenus()
  ctxMenu.value = {
    show: true,
    x: e.clientX,
    y: e.clientY,
    target
  }
}

function closeCtxMenu() {
  ctxMenu.value.show = false
  ctxMenu.value.target = null
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
    const el = artifactPickerRef.value
    if (el && !el.contains(target)) closeArtifactPicker()
  }
  if (ctxMenu.value.show) {
    const menu = document.querySelector('.canvas-ctx-menu')
    if (menu && !menu.contains(target)) closeCtxMenu()
  }
}

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
    showRemovedToast(ev.removed)
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
  window.addEventListener('focus', onWindowFocus)
  document.addEventListener('visibilitychange', onVisibilityChange)
  void refreshFileStatus()
  scrollActiveTabIntoView()
})

onUnmounted(() => {
  document.removeEventListener('mousedown', onDocumentMouseDown, true)
  window.removeEventListener('focus', onWindowFocus)
  document.removeEventListener('visibilitychange', onVisibilityChange)
})
</script>

<template>
  <div class="canvas-panel">
    <div
      class="canvas-header"
      @contextmenu="openCtxMenu($event, { kind: 'header' })"
    >
      <div
        v-if="artifacts.length > 0"
        ref="tabsScrollRef"
        class="artifact-tabs-scroll"
      >
        <div class="artifact-tabs" role="tablist">
          <button
            v-for="artifact in visibleTabs"
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
            <component :is="rendererIcon(artifact.renderer)" :size="12" class="artifact-tab-icon" />
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
          <div v-if="overflowCount > 0" ref="artifactPickerRef" class="artifact-overflow-wrap">
            <button
              type="button"
              class="artifact-overflow-btn"
              :class="{ active: showArtifactPicker }"
              :title="t('canvas.artifactPickerTitle')"
              :aria-expanded="showArtifactPicker"
              @click="toggleArtifactPicker"
            >
              <span>{{ t('canvas.artifactOverflow', { count: overflowCount }) }}</span>
              <ChevronDown :size="12" />
            </button>
            <div v-if="showArtifactPicker" class="artifact-picker" @click.stop>
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
                  @contextmenu="openCtxMenu($event, { kind: 'tab', artifactId: artifact.id })"
                >
                  <button
                    type="button"
                    class="artifact-picker-item"
                    @click="selectArtifact(artifact.id)"
                  >
                    <component :is="rendererIcon(artifact.renderer)" :size="14" class="artifact-picker-icon" />
                    <span class="artifact-picker-text">
                      <span class="artifact-picker-label">{{ artifactTabLabel(artifact.title) }}</span>
                      <span class="artifact-picker-sub">{{ artifactPickerSubtitle(artifact) }}</span>
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
          </div>
        </div>
      </div>
      <div class="canvas-header-actions">
        <button
          v-if="isMarkdownActive"
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
          v-if="activeArtifactId"
          class="canvas-close"
          @click="handleCloseActive"
          :title="t('canvas.closeArtifact')"
        >
          <X :size="14" />
        </button>
      </div>
    </div>

    <div
      v-if="ctxMenu.show"
      class="canvas-ctx-overlay"
      @mousedown="closeCtxMenu"
      @contextmenu.prevent="closeCtxMenu"
    />
    <div
      v-if="ctxMenu.show"
      class="canvas-ctx-menu"
      :style="{ left: `${ctxMenu.x}px`, top: `${ctxMenu.y}px` }"
      @click.stop
    >
      <template v-if="ctxMenu.target?.kind === 'tab' && ctxArtifact && ctxMenuFlags">
        <div class="canvas-ctx-header">{{ artifactTabLabel(ctxArtifact.title) }}</div>
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
          v-if="canOpenActive && (isMarkdownActive || canSaveAsActive || canSaveAll)"
          class="canvas-ctx-separator"
        />
        <button
          v-if="isMarkdownActive"
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
          v-if="isMarkdownActive || canSaveAsActive || canSaveAll"
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

    <div v-if="activeArtifactId" class="canvas-body">
      <DocumentRenderer
        v-if="renderer === 'document'"
        :key="activeArtifactId"
        :tab-id="tabId"
        :artifact-id="activeArtifactId"
      />
      <SpreadsheetRenderer
        v-else-if="renderer === 'spreadsheet'"
        :key="activeArtifactId"
        :tab-id="tabId"
        :artifact-id="activeArtifactId"
      />
      <MarkdownRenderer
        v-else-if="renderer === 'markdown'"
        :key="activeArtifactId"
        :tab-id="tabId"
        :artifact-id="activeArtifactId"
      />
      <SlidesRenderer
        v-else-if="renderer === 'html'"
        :key="activeArtifactId"
        :tab-id="tabId"
        :artifact-id="activeArtifactId"
      />
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
  min-height: 32px;
}

.artifact-tabs-scroll {
  min-width: 0;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: thin;
}

.artifact-tabs {
  display: flex;
  align-items: center;
  gap: 2px;
  min-width: min-content;
  padding-right: 2px;
}

.artifact-tab {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 140px;
  height: 24px;
  padding: 0 4px 0 6px;
  border: 1px solid transparent;
  border-radius: 4px;
  background: transparent;
  color: var(--text-secondary, #aaa);
  font-size: 11px;
  cursor: pointer;
  flex-shrink: 0;
  transition: background 0.12s, color 0.12s, border-color 0.12s;
}

.artifact-tab:hover {
  background: var(--hover-bg, rgba(255, 255, 255, 0.06));
  color: var(--text-primary, #eee);
}

.artifact-tab.active {
  background: rgba(var(--accent-rgb, 137, 180, 250), 0.14);
  border-color: rgba(var(--accent-rgb, 137, 180, 250), 0.35);
  color: var(--text-primary, #eee);
}

.artifact-tab-icon {
  flex-shrink: 0;
  opacity: 0.85;
}

.artifact-tab-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
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
  opacity: 0.7;
}

.artifact-tab-close:hover {
  opacity: 1;
  background: rgba(255, 255, 255, 0.12);
}

.artifact-overflow-wrap {
  position: relative;
  flex-shrink: 0;
}

.artifact-overflow-btn {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  height: 24px;
  padding: 0 6px;
  border: 1px solid transparent;
  border-radius: 4px;
  background: transparent;
  color: var(--text-secondary, #aaa);
  font-size: 11px;
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.12s, color 0.12s, border-color 0.12s;
}

.artifact-overflow-btn:hover,
.artifact-overflow-btn.active {
  background: rgba(var(--accent-rgb, 137, 180, 250), 0.14);
  border-color: rgba(var(--accent-rgb, 137, 180, 250), 0.35);
  color: var(--text-primary, #eee);
}

.artifact-picker {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  z-index: 25;
  min-width: 240px;
  max-width: min(340px, 70vw);
  padding: 4px;
  background: var(--bg-secondary, #252525);
  border: 1px solid var(--border-color, rgba(255, 255, 255, 0.12));
  border-radius: 6px;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.28);
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
</style>
