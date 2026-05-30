<script setup lang="ts">
/**
 * Canvas 预览面板
 *
 * 独立助手右侧的动态预览区域，根据 renderer 类型动态加载对应渲染组件。
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { X, TerminalSquare, FileText, Table2, FileCode, ExternalLink } from 'lucide-vue-next'
import { useCanvasStore } from '../../stores/canvas'
import { useToast } from '../../composables/useToast'
import TerminalRenderer from './TerminalRenderer.vue'
import DocumentRenderer from './DocumentRenderer.vue'
import SpreadsheetRenderer from './SpreadsheetRenderer.vue'
import MarkdownRenderer from './MarkdownRenderer.vue'

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

function handleClose() {
  canvasStore.close(props.tabId)
}

async function openFile() {
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

const rendererIcon = computed(() => {
  switch (renderer.value) {
    case 'terminal': return TerminalSquare
    case 'document': return FileText
    case 'spreadsheet': return Table2
    case 'markdown': return FileCode
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
        <button
          v-if="canOpen"
          type="button"
          class="canvas-open-btn"
          :title="t('canvas.openFile')"
          @click="openFile"
        >
          <ExternalLink :size="14" />
          <span>{{ t('canvas.openFile') }}</span>
        </button>
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

.canvas-open-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 8px;
  border: none;
  border-radius: 4px;
  background: var(--accent-bg, #3d5a80);
  color: #fff;
  font-size: 11px;
  cursor: pointer;
  transition: opacity 0.15s;
}

.canvas-open-btn:hover {
  opacity: 0.92;
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
