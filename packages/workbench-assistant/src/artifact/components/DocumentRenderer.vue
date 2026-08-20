<script setup lang="ts">
/**
 * Canvas DocumentRenderer
 *
 * Word / WPS 文字 HTML 预览（mammoth 转换，只读）。
 * 选区即作用域：划一段后发送时静默附带摘录，右键快捷指令当场发出。
 */
import { computed, inject, nextTick, onMounted, onUnmounted, ref, toRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Wand2 } from 'lucide-vue-next'
import { useAssistantArtifactStore } from '../store'
import { useArtifactContentHydration } from '../composables/useArtifactContentHydration'
import { requireArtifactDesktopHost } from '../host'
import { artifactBasename } from '../domain/artifact-actions'
import {
  applyStickyMarks,
  clearStickyMarks,
  excerptFromRange,
  rangeFromExcerpt,
  rangeInsideRoot,
  STICKY_MARK_CLASS
} from '../domain/html-sticky-selection'
import { SET_COMPOSER_DRAFT_KEY, SUBMIT_COMPOSER_MESSAGE_KEY, type ArtifactComposerQuote } from '../composer-quote'
import { registerSelectionScopeProvider } from '../selection-scope'
import { clampContextMenuPosition, intersectViewport } from '../domain/context-menu-position'
import { useSelectionActionHint } from '../composables/useSelectionActionHint'
import SelectionActionHint from '../ui/SelectionActionHint.vue'
import '../ui/quote-context-menu.css'

const CTX_MENU_ESTIMATE = { width: 200, height: 200 }

const props = defineProps<{
  tabId: string
  artifactId: string
}>()

const { t } = useI18n()
const artifactStore = useAssistantArtifactStore()
const { loadingFromDisk } = useArtifactContentHydration(props.tabId, toRef(props, 'artifactId'))
const setComposerDraft = inject(SET_COMPOSER_DRAFT_KEY, undefined)
const submitComposerMessage = inject(SUBMIT_COMPOSER_MESSAGE_KEY, undefined)
const desktopHost = requireArtifactDesktopHost()

const rootRef = ref<HTMLElement | null>(null)
const contentRef = ref<HTMLElement | null>(null)
let stickyRange: Range | null = null
/** Range 失效时仍可用，保证右键能拿到摘录 */
let lastExcerpt = ''
/** 指针已离开预览：用背景钉住，并收掉原生选区，避免双重高亮 */
let pinSticky = false
/** 只在文档 HTML 真变时写 innerHTML，避免点输入框重绘冲掉高亮 */
let paintedHtml: string | null = null

const ctxVisible = ref(false)
const ctxX = ref(0)
const ctxY = ref(0)
const ctxMenuRef = ref<HTMLElement | null>(null)
const ctxQuotePayload = ref<{ excerpt: string } | null>(null)
const {
  anchor: hintAnchor,
  show: showSelectionHint,
  hide: hideSelectionHint,
  refresh: refreshSelectionHint,
  hideOnTyping: hideHintOnTyping
} = useSelectionActionHint(() => contentRef.value)

function placeCtxMenu(x: number, y: number, size = CTX_MENU_ESTIMATE) {
  const placed = clampContextMenuPosition({
    x,
    y,
    menuWidth: size.width,
    menuHeight: size.height,
    viewport: intersectViewport(rootRef.value?.getBoundingClientRect())
  })
  ctxX.value = placed.left
  ctxY.value = placed.top
}

function refineCtxMenu(x: number, y: number) {
  void nextTick(() => {
    const el = ctxMenuRef.value
    if (!el) return
    const r = el.getBoundingClientRect()
    placeCtxMenu(x, y, { width: r.width, height: r.height })
  })
}

const artifact = computed(() => artifactStore.getArtifactById(props.tabId, props.artifactId))
const content = computed(() => artifact.value?.content ?? '')
const filePath = computed(() => artifact.value?.filePath ?? null)

const panelActive = computed(() => {
  const root = rootRef.value
  if (!root?.isConnected) return false
  if (!artifactStore.isVisible(props.tabId)) return false
  if (artifactStore.getActiveArtifact(props.tabId)?.id !== props.artifactId) return false
  if (artifactStore.getActiveArtifact(props.tabId)?.renderer !== 'document') return false
  return desktopHost.isTabActive(props.tabId)
})

function captureQuoteMeta(): { excerpt: string } | null {
  const live = rangeInsideRoot(contentRef.value, window.getSelection())
  const excerpt = live ? excerptFromRange(live) : lastExcerpt
  return excerpt.trim() ? { excerpt: excerpt.trim() } : null
}

function lockRange(range: Range): void {
  stickyRange = range
  lastExcerpt = excerptFromRange(range)
}

function resolveStickyRange(): Range | null {
  const live = rangeInsideRoot(contentRef.value, window.getSelection())
  if (live) {
    lockRange(live)
    return live
  }
  if (stickyRange) return stickyRange
  const recovered = rangeFromExcerpt(contentRef.value, lastExcerpt)
  if (recovered) stickyRange = recovered
  return recovered
}

function pinStickyHighlight(): void {
  const el = contentRef.value
  if (!el) return
  pinSticky = true
  hideSelectionHint()
  if (el.querySelector(`.${STICKY_MARK_CLASS}`)) {
    window.getSelection()?.removeAllRanges()
    return
  }
  const range = resolveStickyRange()
  applyStickyMarks(el, range)
  window.getSelection()?.removeAllRanges()
}

function clearSticky(): void {
  pinSticky = false
  stickyRange = null
  lastExcerpt = ''
  hideSelectionHint()
  clearStickyMarks(contentRef.value)
}

function buildSelectionScope(): ArtifactComposerQuote | null {
  const meta = captureQuoteMeta()
  const trimmed = meta?.excerpt.trim()
  if (!trimmed) return null
  const fp = filePath.value
  const title = artifact.value?.title ?? ''
  const label = fp ? artifactBasename(fp) : (title || 'Word')
  return {
    label,
    sourcePath: fp || null,
    sourceLinesAccurate: false,
    quoteOrigin: 'canvas',
    startLine: null,
    endLine: null,
    excerpt: trimmed
  }
}

const QUOTE_ACTION_KEYS = ['rewrite', 'polish', 'proofread', 'translate', 'expand'] as const

function applyCtxQuoteAction(actionKey: string) {
  const meta = ctxQuotePayload.value
  if (!meta?.excerpt.trim()) {
    closeCtxMenu()
    return
  }
  submitComposerMessage?.(t(`canvas.quoteActions.${actionKey}`))
  closeCtxMenu()
}

function openCtxMenu(e: MouseEvent) {
  const meta = captureQuoteMeta()
  if (!meta?.excerpt.trim()) return
  e.preventDefault()
  e.stopPropagation()
  ctxQuotePayload.value = meta
  hideSelectionHint()
  placeCtxMenu(e.clientX, e.clientY)
  // 右键手势里 mousedown 可能晚于 contextmenu，推迟挂上以免当场被关掉
  requestAnimationFrame(() => {
    ctxVisible.value = true
    refineCtxMenu(e.clientX, e.clientY)
  })
}

function closeCtxMenu() {
  ctxVisible.value = false
  ctxQuotePayload.value = null
}

function onSelectionChange() {
  const range = rangeInsideRoot(contentRef.value, window.getSelection())
  if (range) {
    lockRange(range)
    if (pinSticky) {
      window.getSelection()?.removeAllRanges()
      return
    }
    // 选区变长/挪位时提示跟着走；mouseup 之后再来的 selectionchange 也不会把它收掉
    refreshSelectionHint()
    clearStickyMarks(contentRef.value)
    return
  }
  if (pinSticky) return
  if (stickyRange || lastExcerpt) pinStickyHighlight()
}

function onContentMouseUp(e: MouseEvent) {
  // 右键随后的 mouseup 常把原生选区折叠，不能据此清 sticky，否则菜单点完发送会丢作用域
  if (e.button === 2) return
  const range = rangeInsideRoot(contentRef.value, window.getSelection())
  if (range) {
    pinSticky = false
    lockRange(range)
    clearStickyMarks(contentRef.value)
    showSelectionHint()
    return
  }
  // 点预览空白才清；点到输入框不会进这个 handler
  const target = e.target as Node | null
  if (target && rootRef.value?.contains(target)) clearSticky()
}

function onGlobalKeydown(e: KeyboardEvent) {
  hideHintOnTyping(e)
  if (e.key === 'Escape') closeCtxMenu()
}

function pinIfPointerLeftPreview(target: EventTarget | null): void {
  const el = target as HTMLElement | null
  if (el?.closest?.('.md-ctx-menu')) return
  const inside = !!(rootRef.value && el && rootRef.value.contains(el))
  if (inside) {
    pinSticky = false
    hideSelectionHint()
    clearStickyMarks(contentRef.value)
    return
  }
  if (stickyRange || lastExcerpt) pinStickyHighlight()
}

function onGlobalMouseDown(e: MouseEvent) {
  if (e.button !== 0) return
  const t = e.target as HTMLElement
  if (t.closest?.('.md-ctx-menu')) return
  closeCtxMenu()
  pinIfPointerLeftPreview(e.target)
}

function onPointerDownCapture(e: PointerEvent) {
  if (e.button !== 0) return
  pinIfPointerLeftPreview(e.target)
}

function onFocusIn(e: FocusEvent) {
  pinIfPointerLeftPreview(e.target)
}

function onWindowKeydown(e: KeyboardEvent) {
  const meta = e.metaKey || e.ctrlKey
  if (!meta || e.shiftKey || e.altKey) return
  if (e.key.toLowerCase() !== 'l') return
  if (!panelActive.value) return
  const quoteMeta = captureQuoteMeta()
  if (!quoteMeta?.excerpt.trim()) return
  e.preventDefault()
  e.stopPropagation()
  setComposerDraft?.('')
  hideSelectionHint()
  closeCtxMenu()
}

function paintDocumentHtml(html: string) {
  const el = contentRef.value
  if (!el) return
  if (paintedHtml === html) return
  paintedHtml = html
  el.innerHTML = html
  clearSticky()
}

watch(
  [content, loadingFromDisk],
  () => { void nextTick(() => paintDocumentHtml(content.value)) },
  { immediate: true }
)

watch(panelActive, (active) => {
  if (active && pinSticky && (stickyRange || lastExcerpt)) pinStickyHighlight()
})

let unregisterSelectionScope: (() => void) | null = null

onMounted(() => {
  unregisterSelectionScope = registerSelectionScopeProvider(props.tabId, {
    getScope: () => buildSelectionScope(),
    clearScope: () => clearSticky()
  })
  rootRef.value?.addEventListener('contextmenu', openCtxMenu)
  document.addEventListener('selectionchange', onSelectionChange)
  document.addEventListener('focusin', onFocusIn)
  document.addEventListener('pointerdown', onPointerDownCapture, true)
  window.addEventListener('keydown', onWindowKeydown, true)
  window.addEventListener('keydown', onGlobalKeydown)
  document.addEventListener('mousedown', onGlobalMouseDown, true)
})

onUnmounted(() => {
  unregisterSelectionScope?.()
  unregisterSelectionScope = null
  rootRef.value?.removeEventListener('contextmenu', openCtxMenu)
  clearSticky()
  document.removeEventListener('selectionchange', onSelectionChange)
  document.removeEventListener('focusin', onFocusIn)
  document.removeEventListener('pointerdown', onPointerDownCapture, true)
  window.removeEventListener('keydown', onWindowKeydown, true)
  window.removeEventListener('keydown', onGlobalKeydown)
  document.removeEventListener('mousedown', onGlobalMouseDown, true)
})
</script>

<template>
  <div ref="rootRef" class="document-renderer">
    <div class="document-scroll" @mouseup="onContentMouseUp">
      <div v-if="loadingFromDisk && !content.trim()" class="document-loading">
        {{ t('canvas.htmlPreviewLoading') }}
      </div>
      <div v-else class="document-page">
        <div
          ref="contentRef"
          class="document-content"
        />
      </div>
    </div>

    <Teleport to="body">
      <div
        v-if="ctxVisible"
        ref="ctxMenuRef"
        class="md-ctx-menu"
        :style="{ left: ctxX + 'px', top: ctxY + 'px' }"
        role="menu"
        @mousedown.prevent
      >
        <div class="md-ctx-group">{{ t('canvas.quoteActionGroup') }}</div>
        <button
          v-for="key in QUOTE_ACTION_KEYS"
          :key="key"
          type="button"
          role="menuitem"
          class="md-ctx-item"
          @click="applyCtxQuoteAction(key)"
        >
          <Wand2 :size="14" aria-hidden="true" />
          <span>{{ t(`canvas.quoteActions.${key}`) }}</span>
        </button>
      </div>
    </Teleport>

    <SelectionActionHint :anchor="hintAnchor" :clip-el="rootRef" />
  </div>
</template>

<style scoped>
.document-renderer {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-height: 0;
  background: #2a2a2a;
}

.document-scroll {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 20px 16px;
}

.document-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 200px;
  color: var(--text-secondary, #888);
  font-size: 13px;
}

/* 白纸容器 */
.document-page {
  max-width: 680px;
  margin: 0 auto;
  background: #fff;
  border-radius: 3px;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.3);
  padding: 48px 56px;
  min-height: 200px;
}

.document-content {
  --doc-sel-bg: color-mix(in srgb, var(--accent-primary, #4d9eff) 35%, transparent);
  color: #1a1a1a;
  font-family: 'Songti SC', 'SimSun', 'Times New Roman', serif;
  font-size: 14px;
  line-height: 1.8;
  word-wrap: break-word;
  text-align: justify;
  user-select: text;
  -webkit-user-select: text;
}

.document-content :deep(::selection) {
  background: var(--doc-sel-bg);
  color: inherit;
}

.document-content :deep(.sf-doc-sticky-mark) {
  background: var(--doc-sel-bg);
  color: inherit;
}

.document-content :deep(h1.document-title) {
  font-family: 'STXiaoBiaoSong', 'PingFang SC', 'Microsoft YaHei', 'Helvetica Neue', sans-serif;
  font-size: 22px;
  font-weight: 700;
  margin: 0.5em 0 0.8em;
  color: #000;
  text-align: center;
}

.document-content :deep(h1) {
  font-family: 'STHeiti', 'Heiti SC', 'PingFang SC', 'Microsoft YaHei', 'Helvetica Neue', sans-serif;
  font-size: 18px;
  font-weight: 600;
  margin: 1em 0 0.5em;
  color: #000;
}

.document-content :deep(h2) {
  font-family: 'STKaiti', 'Kaiti SC', 'PingFang SC', 'Microsoft YaHei', 'Helvetica Neue', sans-serif;
  font-size: 16px;
  font-weight: 600;
  margin: 0.8em 0 0.4em;
  color: #111;
}

.document-content :deep(h3) {
  font-family: 'PingFang SC', 'Microsoft YaHei', 'Helvetica Neue', sans-serif;
  font-size: 15px;
  font-weight: 600;
  margin: 0.6em 0 0.3em;
  color: #222;
}

.document-content :deep(p) {
  margin: 0.4em 0;
  text-indent: 2em;
}

.document-content :deep(ul),
.document-content :deep(ol) {
  padding-left: 2em;
  margin: 0.4em 0;
}

.document-content :deep(li) {
  margin: 0.15em 0;
  text-indent: 0;
}

.document-content :deep(table) {
  width: 100%;
  table-layout: fixed;
  border-collapse: collapse;
  margin: 0.8em 0;
  font-size: 13px;
}

.document-content :deep(th),
.document-content :deep(td) {
  border: 1px solid #555;
  padding: 6px 10px;
  text-align: left;
  text-indent: 0;
  vertical-align: top;
}

.document-content :deep(th p),
.document-content :deep(td p) {
  text-indent: 0;
  margin: 0.15em 0;
}

.document-content :deep(th) {
  background: #f0f0f0;
  font-weight: 600;
  color: #111;
  text-align: center;
}

.document-content :deep(strong),
.document-content :deep(b) {
  font-weight: 700;
  color: #000;
}

.document-content :deep(em),
.document-content :deep(i) {
  font-style: italic;
}

.document-content :deep(u) {
  text-decoration: underline;
}

.document-content :deep(a) {
  color: #0563C1;
  text-decoration: underline;
}

.document-content :deep(img) {
  max-width: 100%;
  height: auto;
  margin: 0.5em 0;
}

.document-content :deep(blockquote) {
  border-left: 3px solid #ccc;
  padding-left: 12px;
  margin: 0.5em 0;
  color: #555;
}

.document-content :deep(hr) {
  border: none;
  border-top: 1px dashed #ccc;
  margin: 1.5em 0;
}

.document-content :deep(sup) {
  font-size: 0.75em;
  color: #666;
}
</style>
