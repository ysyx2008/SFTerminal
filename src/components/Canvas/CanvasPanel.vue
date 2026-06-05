<script setup lang="ts">
/**
 * Canvas 预览面板
 *
 * 独立助手右侧的动态预览区域，根据 renderer 类型动态加载对应渲染组件。
 */
import { computed, ref, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { X, TerminalSquare, FileText, Table2, FileCode, Presentation, FolderOpen, ChevronDown, Folder } from 'lucide-vue-next'
import { useCanvasStore } from '../../stores/canvas'
import { useToast } from '../../composables/useToast'
import TerminalRenderer from './TerminalRenderer.vue'
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

const renderer = computed(() => canvasStore.getRenderer(props.tabId))
const title = computed(() => canvasStore.getTitle(props.tabId))
const filePath = computed(() => canvasStore.getFilePath(props.tabId))
const canOpen = computed(() => typeof filePath.value === 'string' && filePath.value.length > 0)

const rendererRef = ref<InstanceType<typeof TerminalRenderer> | null>(null)
const openMenuRef = ref<HTMLElement | null>(null)
const showOpenMenu = ref(false)

function handleClose() {
  canvasStore.close(props.tabId)
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
  if (!showOpenMenu.value) return
  const el = openMenuRef.value
  if (el && !el.contains(e.target as Node)) {
    closeOpenMenu()
  }
}

onMounted(() => {
  document.addEventListener('mousedown', onDocumentMouseDown, true)
})

onUnmounted(() => {
  document.removeEventListener('mousedown', onDocumentMouseDown, true)
})

const rendererIcon = computed(() => {
  switch (renderer.value) {
    case 'terminal': return TerminalSquare
    case 'document': return FileText
    case 'spreadsheet': return Table2
    case 'markdown': return FileCode
    case 'html': return Presentation
    default: return TerminalSquare
  }
})

defineExpose({
  fit() {
    rendererRef.value?.fit?.()
  }
})
</script>

<template>
  <div class="canvas-panel">
    <div class="canvas-header">
      <div class="canvas-title">
        <component :is="rendererIcon" :size="14" />
        <span>{{ title }}</span>
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
        <button class="canvas-close" @click="handleClose" :title="t('common.close')">
          <X :size="14" />
        </button>
      </div>
    </div>
    <div class="canvas-body">
      <TerminalRenderer
        v-if="renderer === 'terminal'"
        ref="rendererRef"
        :tab-id="tabId"
      />
      <DocumentRenderer
        v-else-if="renderer === 'document'"
        :tab-id="tabId"
      />
      <SpreadsheetRenderer
        v-else-if="renderer === 'spreadsheet'"
        :tab-id="tabId"
      />
      <MarkdownRenderer
        v-else-if="renderer === 'markdown'"
        :tab-id="tabId"
      />
      <SlidesRenderer
        v-else-if="renderer === 'html'"
        :tab-id="tabId"
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
  padding: 6px 10px;
  background: var(--bg-secondary, #252525);
  border-bottom: 1px solid var(--border-color, rgba(255, 255, 255, 0.08));
  flex-shrink: 0;
  user-select: none;
}

.canvas-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-secondary, #aaa);
  font-weight: 500;
}

.canvas-header-actions {
  display: flex;
  align-items: center;
  gap: 6px;
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
