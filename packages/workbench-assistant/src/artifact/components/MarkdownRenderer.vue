<script setup lang="ts">
/**
 * Canvas Markdown：默认预览渲染，可切换编辑；选中内容可引用到同 Tab 的 AI 输入框。
 */
import { computed, nextTick, onMounted, onUnmounted, ref, toRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Eye, MessageSquareQuote, SquarePen } from 'lucide-vue-next'
import { useAssistantArtifactStore } from '../store'
import { useArtifactSaveBridge } from '../domain/artifact-save-bridge'
import { useArtifactContentHydration } from '../composables/useArtifactContentHydration'
import { requireArtifactDesktopHost } from '../host'
import { useComposerQuoteStore } from '@/stores/composer-quote'
import { useMarkdown } from '@sailfish/workbench-sdk/markdown'
import { useToast } from '@sailfish/workbench-sdk/toast'

const props = defineProps<{
  tabId: string
  artifactId: string
}>()

const { t } = useI18n()
const artifactStore = useAssistantArtifactStore()
const saveBridge = useArtifactSaveBridge()
const { loadingFromDisk } = useArtifactContentHydration(props.tabId, toRef(props, 'artifactId'))
const composerQuoteStore = useComposerQuoteStore()
const desktopHost = requireArtifactDesktopHost()
const { renderMarkdown, handleCodeBlockClick, handleFilePathContextMenu } = useMarkdown()
const previewWrapRef = ref<HTMLElement | null>(null)
const { success: toastSuccess, error: toastError, info: toastInfo } = useToast()

const draft = ref('')
const saving = ref(false)
const viewMode = ref<'edit' | 'preview'>('preview')
const textareaRef = ref<HTMLTextAreaElement | null>(null)
const rootRef = ref<HTMLElement | null>(null)

const ctxVisible = ref(false)
const ctxX = ref(0)
const ctxY = ref(0)
/** 右键菜单打开时的摘录快照（点击菜单项时选区可能已丢失） */
const ctxQuotePayload = ref<{
  excerpt: string
  accurate: boolean
  startLine: number | null
  endLine: number | null
} | null>(null)
/** 预览区选区快照（右键/快捷键时 DOM 选区可能已丢失） */
const lastPreviewQuoteMeta = ref<{
  excerpt: string
  accurate: boolean
  startLine: number | null
  endLine: number | null
} | null>(null)

const artifact = computed(() => artifactStore.getArtifactById(props.tabId, props.artifactId))
const filePath = computed(() => artifact.value?.filePath ?? null)
const canSave = computed(() => typeof filePath.value === 'string' && filePath.value.length > 0)
const isDirty = computed(() => saveBridge?.isDirty(props.artifactId) ?? false)

const previewHtml = computed(() => renderMarkdown(draft.value))

watch(
  () => artifact.value?.content,
  (c) => {
    draft.value = c ?? ''
  },
  { immediate: true }
)

function flushDraftToStore() {
  if (!artifact.value) return
  if (draft.value !== artifact.value.content) {
    artifactStore.updateContent(props.tabId, draft.value, props.artifactId)
  }
}

watch(
  () => props.artifactId,
  (_next, prev) => {
    if (prev) saveBridge?.flush(prev)
  }
)

watch(draft, () => {
  if (!artifact.value) return
  const dirty = draft.value !== (artifact.value.content ?? '')
  saveBridge?.setDirty(props.artifactId, dirty)
}, { immediate: true })

function focusEditorIfNeeded() {
  if (viewMode.value !== 'edit') return
  nextTick(() => textareaRef.value?.focus())
}

function toggleViewMode() {
  viewMode.value = viewMode.value === 'edit' ? 'preview' : 'edit'
  focusEditorIfNeeded()
}

function setViewMode(m: 'edit' | 'preview') {
  viewMode.value = m
  focusEditorIfNeeded()
}

type QuoteMeta = {
  excerpt: string
  accurate: boolean
  startLine: number | null
  endLine: number | null
}

/** 预览区多为非可聚焦节点，焦点常在 AI 输入框，需 window 级快捷键 */
function isMarkdownPanelActive(): boolean {
  const root = rootRef.value
  if (!root?.isConnected) return false
  if (!artifactStore.isVisible(props.tabId)) return false
  if (artifactStore.getActiveArtifact(props.tabId)?.id !== props.artifactId) return false
  if (artifactStore.getActiveArtifact(props.tabId)?.renderer !== 'markdown') return false
  if (!desktopHost.isTabActive(props.tabId)) return false
  const active = document.activeElement
  if (active && root.contains(active)) return true
  return viewMode.value === 'preview'
}

function refreshPreviewQuoteSnapshot() {
  if (viewMode.value !== 'preview') return
  const meta = captureQuoteMeta()
  if (meta?.excerpt.trim()) {
    lastPreviewQuoteMeta.value = meta
  }
}

function resolveQuoteMeta(): QuoteMeta | null {
  const meta = captureQuoteMeta()
  if (meta?.excerpt.trim()) return meta
  if (viewMode.value === 'preview' && lastPreviewQuoteMeta.value?.excerpt.trim()) {
    return lastPreviewQuoteMeta.value
  }
  return null
}

/** 预览：窗口选区；编辑：textarea 选区及文件内行号 */
function captureQuoteMeta(): {
  excerpt: string
  accurate: boolean
  startLine: number | null
  endLine: number | null
} | null {
  const root = rootRef.value
  if (viewMode.value === 'edit') {
    const el = textareaRef.value
    if (!el) return null
    const a = el.selectionStart
    const b = el.selectionEnd
    if (a === b) return null
    const full = draft.value
    const excerpt = full.slice(a, b)
    const startLine = full.slice(0, a).split('\n').length
    const endLine = full.slice(0, b).split('\n').length
    return { excerpt, accurate: true, startLine, endLine }
  }
  const sel = window.getSelection()
  if (!sel?.rangeCount || sel.isCollapsed) return null
  if (!root || !sel.anchorNode || !root.contains(sel.anchorNode)) return null
  return {
    excerpt: sel.toString(),
    accurate: false,
    startLine: null,
    endLine: null
  }
}

function basenamePath(p: string): string {
  const norm = p.replace(/\\/g, '/')
  const i = norm.lastIndexOf('/')
  return i >= 0 ? norm.slice(i + 1) : norm
}

function pushQuoteSnippet(meta: {
  excerpt: string
  accurate: boolean
  startLine: number | null
  endLine: number | null
}) {
  const trimmed = meta.excerpt.trim()
  if (!trimmed) {
    toastInfo(t('canvas.quoteToAiNeedSelection'))
    return
  }
  const fp = filePath.value
  const title = artifact.value?.title ?? ''
  const label = fp ? basenamePath(fp) : (title || 'Markdown')

  composerQuoteStore.addSnippet(props.tabId, {
    label,
    sourcePath: fp || null,
    sourceLinesAccurate: meta.accurate,
    quoteOrigin: 'canvas',
    startLine: meta.startLine,
    endLine: meta.endLine,
    excerpt: trimmed
  })
  toastSuccess(t('ai.quoteSnippetAdded'))
}

function applyCtxQuoteFromMenu() {
  const meta = ctxQuotePayload.value
  if (!meta?.excerpt.trim()) {
    closeCtxMenu()
    return
  }
  pushQuoteSnippet(meta)
  closeCtxMenu()
}

function openCtxMenu(e: MouseEvent) {
  const meta = resolveQuoteMeta()
  if (!meta || !meta.excerpt.trim()) return
  e.preventDefault()
  ctxQuotePayload.value = meta
  ctxX.value = e.clientX
  ctxY.value = e.clientY
  ctxVisible.value = true
}

/** 预览区 capture 阶段处理右键，避免选区在冒泡前丢失；文件路径链路由 useMarkdown 处理 */
function onPreviewContextMenuCapture(e: MouseEvent) {
  if (viewMode.value !== 'preview') return
  const target = e.target as HTMLElement
  if (target.closest('[data-file-path]')) return
  openCtxMenu(e)
}

function closeCtxMenu() {
  ctxVisible.value = false
  ctxQuotePayload.value = null
}

function onGlobalKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') closeCtxMenu()
}

function onGlobalMouseDown(e: MouseEvent) {
  const t = e.target as HTMLElement
  if (t.closest?.('.md-ctx-menu')) return
  closeCtxMenu()
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
      artifactStore.updateContent(props.tabId, draft.value, props.artifactId)
      saveBridge?.clearDirty(props.artifactId)
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
  const meta = e.metaKey || e.ctrlKey
  if (!meta) return

  const k = e.key.toLowerCase()

  // Ctrl/Cmd+L：引用到 AI（预览无焦点时也需 window 级响应）
  if (!e.shiftKey && !e.altKey && k === 'l' && isMarkdownPanelActive()) {
    const quoteMeta = resolveQuoteMeta()
    if (quoteMeta?.excerpt.trim()) {
      e.preventDefault()
      e.stopPropagation()
      pushQuoteSnippet(quoteMeta)
      closeCtxMenu()
      return
    }
  }

  if (e.shiftKey && k === 'm' && isMarkdownPanelActive()) {
    e.preventDefault()
    e.stopPropagation()
    toggleViewMode()
    return
  }

  if (!canSave.value) return
  if (e.key === 's') {
    e.preventDefault()
    if (!isDirty.value) {
      toastInfo(t('canvas.saveNoChanges'))
      return
    }
    void saveToDisk()
  }
}

function bindPreviewMarkdownInteractions() {
  const el = previewWrapRef.value
  if (!el) return
  el.addEventListener('click', handleCodeBlockClick)
  el.addEventListener('contextmenu', handleFilePathContextMenu)
  el.addEventListener('contextmenu', onPreviewContextMenuCapture, true)
}

function unbindPreviewMarkdownInteractions() {
  const el = previewWrapRef.value
  if (!el) return
  el.removeEventListener('click', handleCodeBlockClick)
  el.removeEventListener('contextmenu', handleFilePathContextMenu)
  el.removeEventListener('contextmenu', onPreviewContextMenuCapture, true)
}

function onDocumentSelectionChange() {
  refreshPreviewQuoteSnapshot()
}

watch(viewMode, (mode) => {
  if (mode === 'preview') {
    nextTick(bindPreviewMarkdownInteractions)
  } else {
    lastPreviewQuoteMeta.value = null
    unbindPreviewMarkdownInteractions()
  }
})

onMounted(() => {
  saveBridge?.register(props.artifactId, {
    getContent: () => draft.value,
    flushToStore: flushDraftToStore,
    isDirty: () => draft.value !== (artifact.value?.content ?? '')
  })
  window.addEventListener('keydown', onWindowKeydown, true)
  window.addEventListener('keydown', onGlobalKeydown)
  document.addEventListener('mousedown', onGlobalMouseDown, true)
  document.addEventListener('selectionchange', onDocumentSelectionChange)
  if (viewMode.value === 'preview') {
    nextTick(bindPreviewMarkdownInteractions)
  }
})
onUnmounted(() => {
  flushDraftToStore()
  saveBridge?.unregister(props.artifactId)
  unbindPreviewMarkdownInteractions()
  window.removeEventListener('keydown', onWindowKeydown, true)
  window.removeEventListener('keydown', onGlobalKeydown)
  document.removeEventListener('mousedown', onGlobalMouseDown, true)
  document.removeEventListener('selectionchange', onDocumentSelectionChange)
})
</script>

<template>
  <div ref="rootRef" class="markdown-renderer">
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
        <span v-if="canSave && isDirty" class="md-dirty-hint">
          {{ t('canvas.unsavedChanges') }}
        </span>
        <span v-else-if="!canSave" class="md-hint">{{ t('canvas.noPathHint') }}</span>
      </div>
    </div>

    <div class="md-body">
      <div v-if="loadingFromDisk && !draft.trim()" class="md-loading">{{ t('canvas.htmlPreviewLoading') }}</div>
      <textarea
        v-show="viewMode === 'edit' && !(loadingFromDisk && !draft.trim())"
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
        v-show="viewMode === 'preview' && !(loadingFromDisk && !draft.trim())"
        ref="previewWrapRef"
        class="md-preview-wrap md-preview-full"
        :aria-label="t('canvas.modePreview')"
      >
        <div
          class="md-preview-inner markdown-content"
          v-html="previewHtml"
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
        <button type="button" role="menuitem" class="md-ctx-item" @click="applyCtxQuoteFromMenu">
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

.md-dirty-hint {
  color: var(--accent-primary, #89b4fa);
  font-size: 11px;
  white-space: nowrap;
}

.md-body {
  flex: 1;
  min-height: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.md-loading {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-secondary, #888);
  font-size: 13px;
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
  color: var(--text-primary);
  background: var(--bg-secondary);
  outline: none;
  tab-size: 2;
}

/* 覆盖全局 textarea:focus 光晕（main.css），全屏编辑区不需要焦点环 */
.md-editor:focus {
  outline: none;
  border-color: transparent;
  box-shadow: none;
}

.md-preview-wrap {
  overflow: auto;
  background: var(--bg-primary, #1e1e1e);
}

.md-preview-full {
  flex: 1;
  min-height: 0;
}

.md-preview-inner {
  padding: 14px 16px 24px;
  min-height: 100%;
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
