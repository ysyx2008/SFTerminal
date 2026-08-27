<script setup lang="ts">
/**
 * Canvas SpreadsheetRenderer
 *
 * 渲染 Excel 表格的 HTML 预览，仿 Excel 白底绿色主题。
 * 预览只读；多 sheet 时底部标签由本组件绘制，点击切换（不改文件）。
 * 圈选即作用域：圈一块格子后发送时静默附带范围，右键快捷指令当场发出。
 */
import { computed, inject, nextTick, onMounted, onUnmounted, ref, toRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Wand2 } from 'lucide-vue-next'
import { useAssistantArtifactStore } from '../store'
import { useArtifactContentHydration } from '../composables/useArtifactContentHydration'
import { requireArtifactDesktopHost } from '../host'
import { artifactBasename } from '../domain/artifact-actions'
import {
  applySpreadsheetActiveSheet,
  parseSpreadsheetPreviewHtml,
  spreadsheetPreviewNeedsAllSheets
} from '../domain/spreadsheet-preview'
import {
  applySpreadsheetSelectionToCells,
  cellFromPoint,
  cellFromTarget,
  clearSpreadsheetSelection,
  expandRectToSpans,
  formatSpreadsheetExcerpt,
  listCellElements,
  normalizeRect,
  readSelectedCells,
  rectsIntersect,
  selectionRectStillOnSheet,
  shouldKeepSpreadsheetSelection,
  spanToRect,
  spreadsheetSelectionBox,
  visibleSheetPane,
  type SpreadsheetCellEl,
  type SpreadsheetCellSpan,
  type SpreadsheetRect
} from '../domain/spreadsheet-selection'
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

const artifact = computed(() => artifactStore.getArtifactById(props.tabId, props.artifactId))
const content = computed(() => artifact.value?.content ?? '')
const filePath = computed(() => artifact.value?.filePath ?? null)

const parsed = computed(() => parseSpreadsheetPreviewHtml(content.value))
const sheets = computed(() => parsed.value.sheets.filter(s => s.name))
const userSheet = ref<string | null>(null)
const upgrading = ref(false)
const rootRef = ref<HTMLElement | null>(null)
const bodyRef = ref<HTMLElement | null>(null)

const ctxVisible = ref(false)
const ctxX = ref(0)
const ctxY = ref(0)
const ctxMenuRef = ref<HTMLElement | null>(null)
const assistantName = computed(() => desktopHost.getAssistantName())

let dragStart: SpreadsheetCellSpan | null = null
let dragEnd: SpreadsheetCellSpan | null = null
let stickyRect: SpreadsheetRect | null = null
let cellCache: SpreadsheetCellEl[] | null = null

const activeName = computed(() => {
  const names = new Set(sheets.value.map(s => s.name))
  if (userSheet.value && names.has(userSheet.value)) return userSheet.value
  return parsed.value.activeSheet || sheets.value[0]?.name || ''
})

const panelActive = computed(() => {
  const root = rootRef.value
  if (!root?.isConnected) return false
  if (!artifactStore.isVisible(props.tabId)) return false
  if (artifactStore.getActiveArtifact(props.tabId)?.id !== props.artifactId) return false
  if (artifactStore.getActiveArtifact(props.tabId)?.renderer !== 'spreadsheet') return false
  return desktopHost.isTabActive(props.tabId)
})

function currentPane(): HTMLElement | null {
  return visibleSheetPane(bodyRef.value)
}

const {
  anchor: hintAnchor,
  show: showSelectionHint,
  hide: hideSelectionHint,
  hideOnTyping: hideHintOnTyping
} = useSelectionActionHint(
  () => currentPane(),
  () => spreadsheetSelectionBox(currentPane())
)

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

function invalidateCellCache(): void {
  cellCache = null
}

function ensureCellCache(): SpreadsheetCellEl[] {
  if (!cellCache) cellCache = listCellElements(currentPane())
  return cellCache
}

function paintRect(rect: SpreadsheetRect | null): void {
  stickyRect = rect
  applySpreadsheetSelectionToCells(ensureCellCache(), rect)
}

function clearSticky(): void {
  dragStart = null
  dragEnd = null
  stickyRect = null
  hideSelectionHint()
  clearSpreadsheetSelection(bodyRef.value)
}

function buildSelectionScope(): ArtifactComposerQuote | null {
  if (!stickyRect) return null
  const pane = currentPane()
  const cells = readSelectedCells(pane, stickyRect)
  const excerpt = formatSpreadsheetExcerpt({
    sheet: activeName.value || 'Sheet1',
    rect: stickyRect,
    cells
  })
  if (!excerpt.trim()) return null
  const fp = filePath.value
  const title = artifact.value?.title ?? ''
  const label = fp ? artifactBasename(fp) : (title || 'Excel')
  return {
    label,
    sourcePath: fp || null,
    sourceLinesAccurate: false,
    quoteOrigin: 'canvas',
    startLine: null,
    endLine: null,
    excerpt
  }
}

const QUOTE_ACTION_KEYS = ['rewrite', 'polish', 'proofread', 'translate', 'expand'] as const

function applyCtxQuoteAction(actionKey: string) {
  if (!stickyRect) {
    closeCtxMenu()
    return
  }
  submitComposerMessage?.(t(`canvas.quoteActions.${actionKey}`))
  closeCtxMenu()
}

function openCtxMenu(e: MouseEvent) {
  const cell = cellFromTarget(e.target, currentPane())
  if (!cell) return
  const hit = expandRectToSpans(spanToRect(cell), ensureCellCache().map(c => c.span))
  if (!stickyRect || !rectsIntersect(stickyRect, spanToRect(cell))) {
    paintRect(hit)
  }
  if (!stickyRect) return
  e.preventDefault()
  e.stopPropagation()
  hideSelectionHint()
  placeCtxMenu(e.clientX, e.clientY)
  requestAnimationFrame(() => {
    ctxVisible.value = true
    refineCtxMenu(e.clientX, e.clientY)
  })
}

function closeCtxMenu() {
  ctxVisible.value = false
}

function onPointerDown(e: PointerEvent) {
  if (e.button !== 0) return
  const pane = currentPane()
  const start = cellFromTarget(e.target, pane)
  if (!start || !pane) {
    const inside = !!(pane && e.target instanceof Node && pane.contains(e.target))
    if (inside) clearSticky()
    return
  }
  e.preventDefault()
  invalidateCellCache()
  dragStart = start
  dragEnd = start
  paintRect(expandRectToSpans(spanToRect(start), ensureCellCache().map(c => c.span)))
  hideSelectionHint()
  bodyRef.value?.setPointerCapture(e.pointerId)
}

function onPointerMove(e: PointerEvent) {
  if (!dragStart) return
  const pane = currentPane()
  const hovered = cellFromPoint(e.clientX, e.clientY, pane)
  if (hovered) dragEnd = hovered
  const end = dragEnd ?? dragStart
  const raw = normalizeRect(spanToRect(dragStart), spanToRect(end))
  paintRect(expandRectToSpans(raw, ensureCellCache().map(c => c.span)))
}

function onPointerUp(e: PointerEvent) {
  if (!dragStart) return
  dragStart = null
  dragEnd = null
  try {
    bodyRef.value?.releasePointerCapture(e.pointerId)
  } catch {
    /* already released */
  }
  if (stickyRect) showSelectionHint()
}

async function loadFullPreview(): Promise<boolean> {
  const path = filePath.value
  if (!path || upgrading.value) return false
  const previewApi = window.electronAPI?.localFs?.previewArtifact
  if (!previewApi) return false
  upgrading.value = true
  try {
    const res = await previewApi(path, 'spreadsheet')
    if (res.success && typeof res.data === 'string' && res.data.includes('sheet-pane')) {
      artifactStore.updateContent(props.tabId, res.data, props.artifactId)
      return true
    }
  } finally {
    upgrading.value = false
  }
  return false
}

function syncVisibleSheet() {
  const root = bodyRef.value
  if (!root || !activeName.value) return
  applySpreadsheetActiveSheet(root, activeName.value)
}

watch(
  () => parsed.value.activeSheet,
  (name, prev) => {
    if (prev && name !== prev) userSheet.value = null
  }
)

watch(
  () => ({
    content: content.value,
    filePath: filePath.value,
    artifactId: props.artifactId,
    sheet: activeName.value
  }),
  async (curr, prev) => {
    const keep = shouldKeepSpreadsheetSelection(prev, curr) ? stickyRect : null
    invalidateCellCache()
    if (!keep) clearSticky()
    if (spreadsheetPreviewNeedsAllSheets(parsed.value) || (
      sheets.value.length > 1 && !content.value.includes('sheet-pane')
    )) {
      await loadFullPreview()
    }
    await nextTick()
    syncVisibleSheet()
    if (keep && selectionRectStillOnSheet(keep, ensureCellCache().map(c => c.span))) {
      paintRect(keep)
    } else if (keep) {
      clearSticky()
    }
  },
  { immediate: true }
)

async function selectSheet(name: string) {
  userSheet.value = name
  await nextTick()
  const shown = bodyRef.value ? applySpreadsheetActiveSheet(bodyRef.value, name) : false
  if (!shown) await loadFullPreview()
  await nextTick()
  syncVisibleSheet()
}

function pinIfPointerLeftPreview(target: EventTarget | null): void {
  const el = target as HTMLElement | null
  if (el?.closest?.('.md-ctx-menu')) return
  const inside = !!(rootRef.value && el && rootRef.value.contains(el))
  if (inside) {
    hideSelectionHint()
    return
  }
  if (stickyRect) hideSelectionHint()
}

function onGlobalKeydown(e: KeyboardEvent) {
  hideHintOnTyping(e)
  if (e.key === 'Escape') closeCtxMenu()
}

function onGlobalMouseDown(e: MouseEvent) {
  if (e.button !== 0) return
  const t = e.target as HTMLElement
  if (t.closest?.('.md-ctx-menu')) return
  closeCtxMenu()
  pinIfPointerLeftPreview(e.target)
}

function onWindowKeydown(e: KeyboardEvent) {
  const meta = e.metaKey || e.ctrlKey
  if (!meta || e.shiftKey || e.altKey) return
  if (e.key.toLowerCase() !== 'l') return
  if (!panelActive.value) return
  if (!stickyRect) return
  e.preventDefault()
  e.stopPropagation()
  setComposerDraft?.('')
  hideSelectionHint()
  closeCtxMenu()
}

let unregisterSelectionScope: (() => void) | null = null

onMounted(() => {
  unregisterSelectionScope = registerSelectionScopeProvider(props.tabId, {
    getScope: () => buildSelectionScope(),
    clearScope: () => clearSticky(),
    retainAfterConsume: true
  })
  rootRef.value?.addEventListener('contextmenu', openCtxMenu)
  window.addEventListener('keydown', onWindowKeydown, true)
  window.addEventListener('keydown', onGlobalKeydown)
  document.addEventListener('mousedown', onGlobalMouseDown, true)
})

onUnmounted(() => {
  unregisterSelectionScope?.()
  unregisterSelectionScope = null
  rootRef.value?.removeEventListener('contextmenu', openCtxMenu)
  clearSticky()
  window.removeEventListener('keydown', onWindowKeydown, true)
  window.removeEventListener('keydown', onGlobalKeydown)
  document.removeEventListener('mousedown', onGlobalMouseDown, true)
})
</script>

<template>
  <div ref="rootRef" class="spreadsheet-renderer">
    <div v-if="loadingFromDisk && !content.trim()" class="spreadsheet-loading">
      {{ t('canvas.htmlPreviewLoading') }}
    </div>
    <div
      v-else
      ref="bodyRef"
      class="spreadsheet-body"
      v-html="content"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
    ></div>
    <div v-if="sheets.length > 1" class="sheet-tabs">
      <button
        v-for="sheet in sheets"
        :key="sheet.name"
        type="button"
        class="sheet-tab"
        :class="{ active: sheet.name === activeName }"
        @click="selectSheet(sheet.name)"
      >
        {{ sheet.name }}
      </button>
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
        <div class="md-ctx-group">{{ t('canvas.quoteActionGroup', { name: assistantName }) }}</div>
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
.spreadsheet-renderer {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: #f3f3f3;
}

.spreadsheet-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 1;
  min-height: 200px;
  color: #666;
  font-size: 13px;
}

.spreadsheet-body {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 0;
}

.spreadsheet-body :deep(.sheet-tabs) {
  display: none;
}

.spreadsheet-body :deep(.sheet-pane[hidden]) {
  display: none;
}

.spreadsheet-body :deep(.sheet-pane:not([hidden])) {
  min-height: 100%;
}

.spreadsheet-body :deep(.sheet-empty) {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #333;
  font-size: 16px;
  font-weight: 600;
  font-family: 'Segoe UI', 'Helvetica Neue', Arial, sans-serif;
}

.spreadsheet-body :deep(.sheet-truncated) {
  margin: 0;
  padding: 10px 14px;
  background: #fff4cc;
  color: #5c4a00;
  font-size: 13px;
  font-weight: 600;
  font-family: 'Segoe UI', 'Helvetica Neue', Arial, sans-serif;
  border-top: 2px solid #d4a017;
}

.spreadsheet-body :deep(table) {
  border-collapse: collapse;
  font-size: 12px;
  font-family: 'Calibri', 'Segoe UI', 'Helvetica Neue', Arial, sans-serif;
  white-space: nowrap;
  background: #fff;
  user-select: none;
}

.spreadsheet-body :deep(th),
.spreadsheet-body :deep(td) {
  border: 1px solid #d4d4d4;
  padding: 3px 6px;
  text-align: left;
  min-width: 64px;
  max-width: 300px;
  overflow: hidden;
  text-overflow: ellipsis;
  height: 20px;
}

.spreadsheet-body :deep(th.row-header),
.spreadsheet-body :deep(td.row-header) {
  background: #f8f8f8;
  color: #555;
  text-align: center;
  min-width: 36px;
  max-width: 50px;
  font-weight: 400;
  font-size: 11px;
  border-color: #d4d4d4;
  position: sticky;
  left: 0;
  z-index: 1;
}

.spreadsheet-body :deep(th) {
  background: #f8f8f8;
  color: #555;
  font-weight: 500;
  font-size: 11px;
  text-align: center;
  border-color: #d4d4d4;
  position: sticky;
  top: 0;
  z-index: 2;
}

.spreadsheet-body :deep(th.corner) {
  z-index: 3;
  background: #f0f0f0;
}

.spreadsheet-body :deep(td) {
  color: #1a1a1a;
  background: #fff;
  vertical-align: bottom;
}

.spreadsheet-body :deep(td.num) {
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.spreadsheet-body :deep(td.merged) {
  max-width: none;
  height: auto;
  white-space: normal;
  word-break: break-word;
  vertical-align: middle;
}

.spreadsheet-body :deep(td.sf-ss-selected) {
  background-image: linear-gradient(rgba(79, 144, 217, 0.32), rgba(79, 144, 217, 0.32));
  box-shadow: inset 0 0 0 1.5px #4a90d9;
}

.spreadsheet-body :deep(td.modified) {
  background-image: linear-gradient(rgba(66, 133, 244, 0.18), rgba(66, 133, 244, 0.18));
}

.spreadsheet-body :deep(td.deleting) {
  background-image: linear-gradient(rgba(254, 202, 202, 0.72), rgba(254, 202, 202, 0.72));
  animation: cell-deleting-flash 1s ease-out;
}

@keyframes cell-deleting-flash {
  0% { background-image: linear-gradient(rgba(252, 165, 165, 0.85), rgba(252, 165, 165, 0.85)); }
  100% { background-image: linear-gradient(rgba(254, 202, 202, 0.72), rgba(254, 202, 202, 0.72)); }
}

.spreadsheet-body :deep(td.shifted) {
  animation: cell-slide-up 0.75s ease-out;
}

@keyframes cell-slide-up {
  from { transform: translateY(24px); opacity: 0; }
  to { transform: translateY(0); opacity: 1; }
}

.spreadsheet-body :deep(td.shifted-col) {
  animation: cell-slide-left 0.75s ease-out;
}

@keyframes cell-slide-left {
  from { transform: translateX(24px); opacity: 0; }
  to { transform: translateX(0); opacity: 1; }
}

.spreadsheet-body :deep(p) {
  margin: 4px 8px;
  font-family: 'Calibri', Arial, sans-serif;
}

.sheet-tabs {
  display: flex;
  flex-shrink: 0;
  gap: 0;
  padding: 0 4px;
  background: #e8e8e8;
  border-top: 1px solid #d4d4d4;
  overflow-x: auto;
}

.sheet-tab {
  appearance: none;
  padding: 5px 14px;
  font-size: 11px;
  line-height: 1.2;
  font-family: 'Calibri', 'Segoe UI', Arial, sans-serif;
  color: #555;
  background: #e0e0e0;
  border: 1px solid #d4d4d4;
  border-bottom: none;
  border-radius: 0;
  margin-top: 2px;
  cursor: pointer;
  user-select: none;
}

.sheet-tab:hover:not(.active) {
  background: #ececec;
}

.sheet-tab.active {
  color: #1a1a1a;
  background: #fff;
  font-weight: 500;
  border-bottom: 1px solid #fff;
  margin-bottom: -1px;
}
</style>
