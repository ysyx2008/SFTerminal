<script setup lang="ts">
/**
 * Canvas Markdown：左侧源码编辑 + 右侧预览，可选保存到本地路径（与 Agent write_text_file 对齐）。
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Save } from 'lucide-vue-next'
import { useCanvasStore } from '../../stores/canvas'
import { useMarkdown } from '../../composables/useMarkdown'
import { useToast } from '../../composables/useToast'

const props = defineProps<{
  tabId: string
}>()

const { t } = useI18n()
const canvasStore = useCanvasStore()
const { renderMarkdown } = useMarkdown()
const { success: toastSuccess, error: toastError } = useToast()

const draft = ref('')
const saving = ref(false)

const state = computed(() => canvasStore.getState(props.tabId))
const filePath = computed(() => state.value.filePath)
const canSave = computed(() => typeof filePath.value === 'string' && filePath.value.length > 0)

const previewHtml = computed(() => renderMarkdown(draft.value))

watch(
  () => state.value.content,
  (c) => {
    draft.value = c
  },
  { immediate: true }
)

async function saveToDisk() {
  const path = filePath.value
  if (!path || saving.value) return
  const api = window.electronAPI?.localFs
  if (!api?.writeFile) {
    toastError(t('canvas.saveFailed'))
    return
  }
  saving.value = true
  try {
    const res = await api.writeFile(path, draft.value)
    if (res.success) {
      canvasStore.updateContent(props.tabId, draft.value)
      toastSuccess(t('canvas.savedToDisk'))
    } else {
      toastError(res.error || t('canvas.saveFailed'))
    }
  } catch (e) {
    toastError(e instanceof Error ? e.message : t('canvas.saveFailed'))
  } finally {
    saving.value = false
  }
}

function onKeyDown(e: KeyboardEvent) {
  if (!canSave.value) return
  const meta = e.metaKey || e.ctrlKey
  if (meta && e.key === 's') {
    e.preventDefault()
    void saveToDisk()
  }
}

onMounted(() => {
  window.addEventListener('keydown', onKeyDown)
})
onUnmounted(() => {
  window.removeEventListener('keydown', onKeyDown)
})
</script>

<template>
  <div class="markdown-renderer">
    <div class="md-toolbar">
      <div class="md-toolbar-left">
        <span class="md-label">{{ t('canvas.markdownSource') }}</span>
        <span class="md-sep" aria-hidden="true">·</span>
        <span class="md-label muted">{{ t('canvas.markdownPreview') }}</span>
      </div>
      <div class="md-toolbar-right">
        <span v-if="!canSave" class="md-hint">{{ t('canvas.noPathHint') }}</span>
        <button
          v-else
          type="button"
          class="md-save-btn"
          :disabled="saving"
          :title="t('canvas.saveShortcut')"
          @click="saveToDisk"
        >
          <Save :size="14" />
          <span>{{ saving ? t('common.saving') : t('canvas.saveToDisk') }}</span>
        </button>
      </div>
    </div>
    <div class="md-split" role="group" :aria-label="t('canvas.markdownSource')">
      <textarea
        v-model="draft"
        class="md-editor"
        spellcheck="false"
        autocomplete="off"
        :aria-label="t('canvas.markdownSource')"
      />
      <div class="md-preview-wrap">
        <div class="md-preview-inner markdown-canvas-preview" v-html="previewHtml" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.markdown-renderer {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-height: 0;
  background: var(--bg-primary, #1e1e1e);
}

.md-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-shrink: 0;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border-color, rgba(255, 255, 255, 0.08));
  font-size: 11px;
}

.md-toolbar-left {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.md-label {
  color: var(--text-secondary, #aaa);
  font-weight: 500;
}

.md-label.muted {
  opacity: 0.85;
}

.md-sep {
  color: var(--text-tertiary, #666);
}

.md-toolbar-right {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.md-hint {
  color: var(--text-tertiary, #888);
  max-width: 220px;
  text-align: right;
  line-height: 1.35;
}

.md-save-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border: none;
  border-radius: 4px;
  font-size: 11px;
  cursor: pointer;
  background: var(--accent-bg, #3d5a80);
  color: #fff;
  transition: opacity 0.15s, background 0.15s;
}

.md-save-btn:hover:not(:disabled) {
  opacity: 0.92;
}

.md-save-btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.md-split {
  display: grid;
  grid-template-columns: 1fr 1fr;
  flex: 1;
  min-height: 0;
  min-width: 0;
}

.md-editor {
  margin: 0;
  padding: 12px 14px;
  border: none;
  resize: none;
  font-family: ui-monospace, 'SF Mono', Menlo, Monaco, Consolas, monospace;
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-primary, #e8e8e8);
  background: #141414;
  outline: none;
  tab-size: 2;
}

.md-preview-wrap {
  overflow: auto;
  background: #f5f5f5;
  border-left: 1px solid var(--border-color, rgba(255, 255, 255, 0.08));
}

.md-preview-inner {
  padding: 14px 16px 24px;
  min-height: 100%;
  font-size: 13px;
  line-height: 1.65;
  color: #1a1a1a;
}

/* 预览区 Markdown（与对话区大致对齐，独立画布浅色底） */
.markdown-canvas-preview :deep(p) {
  margin: 0.45em 0;
}

.markdown-canvas-preview :deep(p:first-child) {
  margin-top: 0;
}

.markdown-canvas-preview :deep(h1),
.markdown-canvas-preview :deep(h2),
.markdown-canvas-preview :deep(h3) {
  margin: 0.7em 0 0.35em;
  font-weight: 600;
  color: #111;
}

.markdown-canvas-preview :deep(h1) {
  font-size: 1.35em;
}
.markdown-canvas-preview :deep(h2) {
  font-size: 1.2em;
}
.markdown-canvas-preview :deep(h3) {
  font-size: 1.08em;
}

.markdown-canvas-preview :deep(ul),
.markdown-canvas-preview :deep(ol) {
  padding-left: 1.4em;
  margin: 0.4em 0;
}

.markdown-canvas-preview :deep(blockquote) {
  border-left: 3px solid #ccc;
  margin: 0.5em 0;
  padding-left: 10px;
  color: #444;
}

.markdown-canvas-preview :deep(table) {
  border-collapse: collapse;
  width: 100%;
  margin: 0.6em 0;
  font-size: 12px;
}

.markdown-canvas-preview :deep(th),
.markdown-canvas-preview :deep(td) {
  border: 1px solid #ccc;
  padding: 4px 8px;
}

.markdown-canvas-preview :deep(th) {
  background: #eee;
}

.markdown-canvas-preview :deep(pre) {
  overflow: auto;
  padding: 10px 12px;
  border-radius: 4px;
  background: #ececec;
  font-size: 12px;
}

.markdown-canvas-preview :deep(code) {
  font-family: ui-monospace, Menlo, Monaco, Consolas, monospace;
  font-size: 0.92em;
}

.markdown-canvas-preview :deep(p code),
.markdown-canvas-preview :deep(li code) {
  background: rgba(0, 0, 0, 0.06);
  padding: 1px 4px;
  border-radius: 3px;
}

.markdown-canvas-preview :deep(a) {
  color: #0969da;
}

.markdown-canvas-preview :deep(hr) {
  border: none;
  border-top: 1px solid #ddd;
  margin: 1em 0;
}
</style>
