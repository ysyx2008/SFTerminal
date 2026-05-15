<script setup lang="ts">
/**
 * Canvas Markdown：默认全屏编辑，可切换预览；选中内容可引用到同 Tab 的 AI 输入框。
 */
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Eye, MessageSquareQuote, Save, SquarePen } from 'lucide-vue-next'
import { useCanvasStore } from '../../stores/canvas'
import { useComposerQuoteStore } from '../../stores/composer-quote'
import { useMarkdown } from '../../composables/useMarkdown'
import { useToast } from '../../composables/useToast'

const props = defineProps<{
  tabId: string
}>()

const { t } = useI18n()
const canvasStore = useCanvasStore()
const composerQuoteStore = useComposerQuoteStore()
const { renderMarkdown } = useMarkdown()
const { success: toastSuccess, error: toastError, info: toastInfo } = useToast()

const draft = ref('')
const saving = ref(false)
const viewMode = ref<'edit' | 'preview'>('edit')
const textareaRef = ref<HTMLTextAreaElement | null>(null)
const rootRef = ref<HTMLElement | null>(null)

const ctxVisible = ref(false)
const ctxX = ref(0)
const ctxY = ref(0)

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

function toggleViewMode() {
  viewMode.value = viewMode.value === 'edit' ? 'preview' : 'edit'
  if (viewMode.value === 'edit') {
    nextTick(() => textareaRef.value?.focus())
  }
}

function setViewMode(m: 'edit' | 'preview') {
  viewMode.value = m
  if (m === 'edit') {
    nextTick(() => textareaRef.value?.focus())
  }
}

/** 当前选中的可引用文本（编辑：textarea；预览：document 选区，须落在本面板内） */
function captureQuoteText(): string {
  const root = rootRef.value
  if (viewMode.value === 'edit') {
    const el = textareaRef.value
    if (!el) return ''
    const a = el.selectionStart
    const b = el.selectionEnd
    if (a === b) return ''
    return el.value.slice(a, b)
  }
  const sel = window.getSelection()
  if (!sel?.rangeCount || sel.isCollapsed) return ''
  if (!root || !sel.anchorNode || !root.contains(sel.anchorNode)) return ''
  return sel.toString()
}

function quoteSelectionToAi() {
  const raw = captureQuoteText().trim()
  if (!raw) {
    toastInfo(t('canvas.quoteToAiNeedSelection'))
    closeCtxMenu()
    return
  }
  composerQuoteStore.requestQuoteToComposer(props.tabId, raw)
  closeCtxMenu()
}

function openCtxMenu(e: MouseEvent) {
  const raw = captureQuoteText().trim()
  if (!raw) return
  e.preventDefault()
  ctxX.value = e.clientX
  ctxY.value = e.clientY
  ctxVisible.value = true
}

function closeCtxMenu() {
  ctxVisible.value = false
}

function onGlobalKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') closeCtxMenu()
}

function onGlobalMouseDown(e: MouseEvent) {
  const t = e.target as HTMLElement
  if (t.closest?.('.md-ctx-menu')) return
  closeCtxMenu()
}

function onPanelKeydown(e: KeyboardEvent) {
  const mod = e.ctrlKey || e.metaKey
  const k = e.key.toLowerCase()

  if (mod && e.shiftKey && k === 'm') {
    e.preventDefault()
    e.stopPropagation()
    toggleViewMode()
    return
  }

  // Ctrl/Cmd+L：引用到 AI 对话（避免 Cmd+Shift+Q 触发退出等系统行为）
  if (mod && !e.shiftKey && !e.altKey && k === 'l') {
    e.preventDefault()
    e.stopPropagation()
    quoteSelectionToAi()
  }
}

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
  } catch (err) {
    toastError(err instanceof Error ? err.message : t('canvas.saveFailed'))
  } finally {
    saving.value = false
  }
}

function onWindowKeydown(e: KeyboardEvent) {
  if (!canSave.value) return
  const meta = e.metaKey || e.ctrlKey
  if (meta && e.key === 's') {
    e.preventDefault()
    void saveToDisk()
  }
}

onMounted(() => {
  window.addEventListener('keydown', onWindowKeydown)
  window.addEventListener('keydown', onGlobalKeydown)
  document.addEventListener('mousedown', onGlobalMouseDown, true)
})
onUnmounted(() => {
  window.removeEventListener('keydown', onWindowKeydown)
  window.removeEventListener('keydown', onGlobalKeydown)
  document.removeEventListener('mousedown', onGlobalMouseDown, true)
})
</script>

<template>
  <div ref="rootRef" class="markdown-renderer" @keydown.capture="onPanelKeydown">
    <div class="md-toolbar">
      <div class="md-toolbar-left">
        <div class="md-mode-switch" role="tablist" :aria-label="t('canvas.viewMode')">
          <button
            type="button"
            role="tab"
            class="md-mode-btn"
            :class="{ active: viewMode === 'edit' }"
            :aria-selected="viewMode === 'edit'"
            :title="t('canvas.modeEditHint')"
            @click="setViewMode('edit')"
          >
            <SquarePen :size="14" aria-hidden="true" />
            <span>{{ t('canvas.modeEdit') }}</span>
          </button>
          <button
            type="button"
            role="tab"
            class="md-mode-btn"
            :class="{ active: viewMode === 'preview' }"
            :aria-selected="viewMode === 'preview'"
            :title="t('canvas.modePreviewHint')"
            @click="setViewMode('preview')"
          >
            <Eye :size="14" aria-hidden="true" />
            <span>{{ t('canvas.modePreview') }}</span>
          </button>
        </div>
      </div>
      <div class="md-toolbar-mid">
        <span class="md-shortcut-hint">{{ t('canvas.toggleModeHint') }}</span>
        <span class="md-shortcut-hint quote">{{ t('canvas.quoteHint') }}</span>
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

    <div class="md-body">
      <textarea
        v-show="viewMode === 'edit'"
        id="canvas-md-editor"
        ref="textareaRef"
        v-model="draft"
        class="md-editor"
        spellcheck="false"
        autocomplete="off"
        :aria-label="t('canvas.modeEdit')"
        @contextmenu="openCtxMenu"
      />
      <div
        v-show="viewMode === 'preview'"
        class="md-preview-wrap md-preview-full"
        :aria-label="t('canvas.modePreview')"
      >
        <div
          class="md-preview-inner markdown-canvas-preview"
          v-html="previewHtml"
          @contextmenu="openCtxMenu"
        />
      </div>
    </div>

    <Teleport to="body">
      <div
        v-if="ctxVisible"
        class="md-ctx-menu"
        :style="{ left: ctxX + 'px', top: ctxY + 'px' }"
        role="menu"
        @mousedown.prevent
      >
        <button type="button" role="menuitem" class="md-ctx-item" @click="quoteSelectionToAi">
          <MessageSquareQuote :size="14" aria-hidden="true" />
          <span>{{ t('canvas.quoteToComposer') }}</span>
        </button>
      </div>
    </Teleport>
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
  gap: 8px;
  min-width: 0;
}

.md-toolbar-mid {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  flex: 1;
  min-width: 0;
  justify-content: center;
}

.md-shortcut-hint {
  color: var(--text-tertiary, #6a6a6a);
  font-size: 10px;
  white-space: nowrap;
}

.md-shortcut-hint.quote {
  opacity: 0.9;
}

.md-mode-switch {
  display: inline-flex;
  border-radius: 6px;
  padding: 2px;
  background: var(--bg-secondary, #252525);
  border: 1px solid var(--border-color, rgba(255, 255, 255, 0.08));
}

.md-mode-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 10px;
  border: none;
  border-radius: 4px;
  font-size: 11px;
  cursor: pointer;
  background: transparent;
  color: var(--text-secondary, #aaa);
  transition: background 0.12s, color 0.12s;
}

.md-mode-btn:hover {
  color: var(--text-primary, #eee);
}

.md-mode-btn.active {
  background: var(--hover-bg, rgba(255, 255, 255, 0.12));
  color: var(--text-primary, #fff);
}

.md-toolbar-right {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.md-hint {
  color: var(--text-tertiary, #888);
  max-width: 200px;
  text-align: right;
  line-height: 1.35;
  font-size: 10px;
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

.md-body {
  flex: 1;
  min-height: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.md-editor {
  flex: 1;
  width: 100%;
  min-height: 0;
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
}

.md-preview-full {
  flex: 1;
  min-height: 0;
}

.md-preview-inner {
  padding: 14px 16px 24px;
  min-height: 100%;
  font-size: 13px;
  line-height: 1.65;
  color: #1a1a1a;
}

/* 右键菜单（Teleport 到 body，需全局类名） */
</style>

<style>
/* 非 scoped：Teleport 到 body 的菜单 */
.md-ctx-menu {
  position: fixed;
  z-index: 10050;
  min-width: 180px;
  padding: 4px;
  border-radius: 6px;
  background: var(--bg-secondary, #2d2d2d);
  border: 1px solid var(--border-color, rgba(255, 255, 255, 0.12));
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
}

.md-ctx-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 10px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--text-primary, #eaeaea);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}

.md-ctx-item:hover {
  background: var(--hover-bg, rgba(255, 255, 255, 0.08));
}
</style>

<style scoped>
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
