<script setup lang="ts">
/**
 * Canvas Artifact 面板
 *
 * 独立助手右侧产出物工作区：多 tab 切换 + 按 renderer 动态加载视图。
 */
import { computed, ref, onMounted, onUnmounted } from 'vue'
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
import type { CanvasRendererType } from '@shared/types'
import {
  filterArtifactsByQuery,
  pickVisibleArtifactTabs,
  sortArtifactsByRecent
} from '../../canvas/artifact-tab-layout'
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
const { error: toastError } = useToast()

const artifacts = computed(() => canvasStore.getArtifacts(props.tabId))
const activeArtifact = computed(() => canvasStore.getActiveArtifact(props.tabId))
const activeArtifactId = computed(() => activeArtifact.value?.id ?? null)
const renderer = computed(() => activeArtifact.value?.renderer ?? null)
const filePath = computed(() => activeArtifact.value?.filePath ?? null)
const canOpen = computed(() => typeof filePath.value === 'string' && filePath.value.length > 0)

const openMenuRef = ref<HTMLElement | null>(null)
const showOpenMenu = ref(false)
const artifactPickerRef = ref<HTMLElement | null>(null)
const showArtifactPicker = ref(false)
const artifactPickerQuery = ref('')

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

function rendererIcon(type: CanvasRendererType | null) {
  switch (type) {
    case 'document': return FileText
    case 'spreadsheet': return Table2
    case 'markdown': return FileCode
    case 'html': return Presentation
    default: return FileText
  }
}

function artifactTabLabel(artifactTitle: string) {
  return artifactTitle || t('canvas.artifactUntitled')
}

function selectArtifact(id: string) {
  canvasStore.setActiveArtifact(props.tabId, id)
  closeArtifactPicker()
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
  canvasStore.removeArtifact(props.tabId, id)
}

function handleCloseActive() {
  if (activeArtifactId.value) {
    canvasStore.close(props.tabId, activeArtifactId.value)
  }
}

async function openFile() {
  closeOpenMenu()
  const path = filePath.value
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

function toggleOpenMenu() {
  showOpenMenu.value = !showOpenMenu.value
}

function closeOpenMenu() {
  showOpenMenu.value = false
}

async function showInFolder() {
  closeOpenMenu()
  const path = filePath.value
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

function onDocumentMouseDown(e: MouseEvent) {
  const target = e.target as Node
  if (showOpenMenu.value) {
    const el = openMenuRef.value
    if (el && !el.contains(target)) closeOpenMenu()
  }
  if (showArtifactPicker.value) {
    const el = artifactPickerRef.value
    if (el && !el.contains(target)) closeArtifactPicker()
  }
}

onMounted(() => {
  document.addEventListener('mousedown', onDocumentMouseDown, true)
})

onUnmounted(() => {
  document.removeEventListener('mousedown', onDocumentMouseDown, true)
})
</script>

<template>
  <div class="canvas-panel">
    <div class="canvas-header">
      <div v-if="artifacts.length > 0" class="artifact-tabs" role="tablist">
        <button
          v-for="artifact in visibleTabs"
          :key="artifact.id"
          type="button"
          role="tab"
          class="artifact-tab"
          :class="{ active: artifact.id === activeArtifactId }"
          :aria-selected="artifact.id === activeArtifactId"
          :title="artifactTabLabel(artifact.title)"
          @click="selectArtifact(artifact.id)"
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
              <button
                v-for="artifact in pickerArtifacts"
                :key="artifact.id"
                type="button"
                role="option"
                class="artifact-picker-item"
                :class="{ active: artifact.id === activeArtifactId }"
                :aria-selected="artifact.id === activeArtifactId"
                @click="selectArtifact(artifact.id)"
              >
                <component :is="rendererIcon(artifact.renderer)" :size="14" class="artifact-picker-icon" />
                <span class="artifact-picker-label">{{ artifactTabLabel(artifact.title) }}</span>
              </button>
              <div v-if="pickerArtifacts.length === 0" class="artifact-picker-empty">
                {{ t('canvas.artifactPickerEmpty') }}
              </div>
            </div>
          </div>
        </div>
      </div>
      <div class="canvas-header-actions">
        <div v-if="canOpen" ref="openMenuRef" class="canvas-open-group">
          <button
            type="button"
            class="canvas-open-btn canvas-open-main"
            :title="t('canvas.openFile')"
            @click="openFile"
          >
            <FolderOpen :size="14" />
            <span>{{ t('canvas.openFile') }}</span>
          </button>
          <button
            type="button"
            class="canvas-open-btn canvas-open-chevron"
            :title="t('canvas.openMenu')"
            :aria-expanded="showOpenMenu"
            @click="toggleOpenMenu"
          >
            <ChevronDown :size="12" />
          </button>
          <div v-if="showOpenMenu" class="canvas-open-menu" @click.stop>
            <button type="button" class="canvas-open-menu-item" @click="showInFolder">
              <Folder :size="14" />
              <span>{{ t('canvas.showInFolder') }}</span>
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
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 4px 6px 4px 4px;
  background: var(--bg-secondary, #252525);
  border-bottom: 1px solid var(--border-color, rgba(255, 255, 255, 0.08));
  flex-shrink: 0;
  user-select: none;
  min-height: 32px;
}

.artifact-tabs {
  display: flex;
  align-items: center;
  gap: 2px;
  flex: 1;
  min-width: 0;
  overflow: hidden;
}

.artifact-tab {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 160px;
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
  min-width: 220px;
  max-width: min(320px, 70vw);
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

.artifact-picker-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
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

.artifact-picker-item.active {
  background: rgba(var(--accent-rgb, 137, 180, 250), 0.14);
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

.artifact-picker-empty {
  padding: 10px 8px;
  color: var(--text-secondary, #888);
  font-size: 12px;
  text-align: center;
}

.canvas-header-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.canvas-open-group {
  position: relative;
  display: inline-flex;
  align-items: stretch;
  height: 22px;
  border: 1px solid rgba(var(--accent-rgb, 137, 180, 250), 0.35);
  border-radius: 4px;
  background: rgba(var(--accent-rgb, 137, 180, 250), 0.12);
  transition: background 0.15s, border-color 0.15s;
}

.canvas-open-group:hover {
  background: rgba(var(--accent-rgb, 137, 180, 250), 0.22);
  border-color: rgba(var(--accent-rgb, 137, 180, 250), 0.5);
}

.canvas-open-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  border: none;
  background: transparent;
  color: var(--accent-primary, #89b4fa);
  font-size: 11px;
  cursor: pointer;
}

.canvas-open-main {
  height: 100%;
  padding: 0 8px;
  border-radius: 4px 0 0 4px;
}

.canvas-open-chevron {
  width: 20px;
  height: 100%;
  padding: 0;
  border-left: 1px solid rgba(var(--accent-rgb, 137, 180, 250), 0.28);
  border-radius: 0 4px 4px 0;
}

.canvas-open-menu {
  position: absolute;
  top: calc(100% + 4px);
  right: 0;
  min-width: 148px;
  padding: 4px;
  background: var(--bg-secondary, #252525);
  border: 1px solid var(--border-color, rgba(255, 255, 255, 0.12));
  border-radius: 6px;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.28);
  z-index: 20;
}

.canvas-open-menu-item {
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

.canvas-open-menu-item:hover {
  background: var(--hover-bg, rgba(255, 255, 255, 0.08));
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
</style>
