<script setup lang="ts">
/**
 * 助手工作台产出物面板
 *
 * 单产出物预览；≥2 个时通过标题下拉切换。无产出物时由工作台自动隐藏面板。
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
  type ArtifactSaveDeps,
  getArtifactContextMenuFlags,
  artifactHasFileActions,
  createArtifactSaveBridge,
  provideArtifactSaveBridge,
  useAssistantArtifactStore
} from '../index'
import { getRendererComponent, getRendererIcon } from '../renderers/ui-registry'
import { useToast } from '../../../../composables/useToast'

const props = defineProps<{
  tabId: string
}>()

const { t } = useI18n()
const artifactStore = useAssistantArtifactStore()
const { success: toastSuccess, error: toastError, info: toastInfo } = useToast()
const saveBridge = createArtifactSaveBridge()
provideArtifactSaveBridge(saveBridge)

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

const showFileMenu = computed(() =>
  Boolean(filePath.value) || canSaveAsActive.value || canSaveAll.value
)

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

const showArtifactSwitcher = computed(() => artifacts.value.length >= 2)
const allArtifactsSorted = computed(() => sortArtifactsByRecent(artifacts.value))
const pickerArtifacts = computed(() =>
  filterArtifactsByQuery(allArtifactsSorted.value, artifactPickerQuery.value)
)
const showPickerSearch = computed(() => artifacts.value.length >= 4)

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

function artifactTabTitle(artifact: CanvasArtifact) {
  return artifactTabLabel(artifact.title)
}

function activeTitleLabel() {
  return artifactTabLabel(activeArtifact.value?.title ?? '')
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
  }
}

function closeFileMenu() {
  showFileMenuDropdown.value = false
}

function artifactTabLabel(artifactTitle: string) {
  return artifactTitle || t('canvas.artifactUntitled')
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
  const width = Math.min(340, Math.max(260, window.innerWidth - 16))
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
}

function closeOthers(keepId: string) {
  flushActiveDraft()
  artifactStore.closeOthers(props.tabId, keepId)
}

function closeAllArtifacts() {
  flushActiveDraft()
  artifactStore.closeAll(props.tabId)
}

function handleCloseActive() {
  if (activeArtifactId.value) {
    artifactStore.close(props.tabId, activeArtifactId.value)
  }
}

function jumpToSource(stepId?: string) {
  const id = stepId ?? activeSourceStepId.value
  if (!id) return
  closeAllMenus()
  artifactStore.requestJumpToSource(props.tabId, id)
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
      <div ref="artifactPickerRef" class="artifact-header-title">
        <button
          v-if="showArtifactSwitcher"
          type="button"
          class="artifact-title-btn"
          :class="{ active: showArtifactPicker }"
          :title="t('canvas.artifactPickerTitle')"
          :aria-expanded="showArtifactPicker"
          @click="toggleArtifactPicker"
          @contextmenu="openCtxMenu($event, { kind: 'header' })"
        >
          <component :is="rendererIcon(activeArtifact?.renderer ?? null)" :size="14" class="artifact-title-icon" />
          <span class="artifact-title-label">{{ activeTitleLabel() }}</span>
          <ChevronDown :size="13" class="artifact-title-chevron" />
        </button>
        <div
          v-else
          class="artifact-title-static"
          @contextmenu="openCtxMenu($event, { kind: 'header' })"
        >
          <component :is="rendererIcon(activeArtifact?.renderer ?? null)" :size="14" class="artifact-title-icon" />
          <span class="artifact-title-label">{{ activeTitleLabel() }}</span>
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
          @click="handleCloseActive()"
          :title="t('canvas.closeArtifact')"
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
              <component :is="rendererIcon(artifact.renderer)" :size="15" class="artifact-picker-icon" />
              <span class="artifact-picker-label">{{ artifactTabLabel(artifact.title) }}</span>
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

    <div v-if="activeArtifactId" class="canvas-body">
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
  display: flex;
  align-items: center;
  gap: 12px;
  box-sizing: border-box;
  height: var(--workbench-panel-header-height, 38px);
  min-height: var(--workbench-panel-header-height, 38px);
  padding: 0 12px;
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
  flex: 1;
}

.artifact-title-btn,
.artifact-title-static {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  max-width: 100%;
  height: 100%;
  padding: 0 6px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--text-primary, #eee);
  font-size: 13px;
  text-align: left;
}

.artifact-title-btn {
  cursor: pointer;
  transition: background 0.12s, color 0.12s;
}

.artifact-title-btn:hover,
.artifact-title-btn.active {
  background: var(--hover-bg, rgba(255, 255, 255, 0.06));
}

.artifact-title-icon {
  flex-shrink: 0;
  opacity: 0.85;
  color: var(--accent-primary, #89b4fa);
}

.artifact-title-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
  font-size: 13px;
  font-weight: 600;
}

.artifact-title-chevron {
  flex-shrink: 0;
  opacity: 0.7;
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
  box-sizing: border-box;
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
  max-height: 280px;
  overflow-y: auto;
}

.artifact-picker-row {
  display: flex;
  align-items: center;
  gap: 2px;
  border-radius: 6px;
}

.artifact-picker-row.active {
  background: rgba(var(--accent-rgb, 137, 180, 250), 0.12);
}

.artifact-picker-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-width: 0;
  min-height: 36px;
  padding: 8px 10px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-primary, #eee);
  font-size: 13px;
  line-height: 1.35;
  text-align: left;
  cursor: pointer;
  transition: background 0.12s;
}

.artifact-picker-item:hover {
  background: var(--hover-bg, rgba(255, 255, 255, 0.08));
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
  flex: 1;
  font-size: 13px;
  font-weight: 500;
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
  padding: 4px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--text-secondary, #aaa);
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}

.canvas-close:hover {
  background: var(--bg-surface, var(--hover-bg, rgba(255, 255, 255, 0.1)));
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
