import { computed, inject, onMounted, onUnmounted, ref, watch, type Ref } from 'vue'
import type { IpcMessageEvent, WebviewTag } from 'electron'
import { artifactBasename } from '../domain/artifact-actions'
import {
  HTML_PREVIEW_SELECTION_CHANNEL,
  HTML_PREVIEW_SELECTION_CMD_CHANNEL,
  hostBoxFromGuest,
  htmlPreviewSelectionGuestScript,
  isHtmlFilePreviewSelectionEnabled,
  parseHtmlPreviewSelectionReport,
  type HtmlPreviewSelectionCmd
} from '../domain/html-preview-selection'
import { SET_COMPOSER_DRAFT_KEY, type ArtifactComposerQuote } from '../composer-quote'
import { registerSelectionScopeProvider } from '../selection-scope'
import { useSelectionActionHint } from './useSelectionActionHint'
import type { ContextMenuBox } from '../domain/context-menu-position'

export function useHtmlPreviewSelection(opts: {
  tabId: string
  artifactId: Ref<string>
  filePath: Ref<string | null>
  title: Ref<string>
  isPptPreview: Ref<boolean>
  rootRef: Ref<HTMLElement | null>
  webviewRef: Ref<WebviewTag | null>
}) {
  const setComposerDraft = inject(SET_COMPOSER_DRAFT_KEY, undefined)
  const guestPreloadUrl = ref('')
  const preloadResolved = ref(!window.electronAPI?.artifactPreview?.guestPreloadUrl)
  let lastExcerpt = ''
  let lastBox: ContextMenuBox | null = null
  let unregisterSelectionScope: (() => void) | null = null

  const enabled = computed(() => isHtmlFilePreviewSelectionEnabled({
    isPptPreview: opts.isPptPreview.value
  }))

  const {
    anchor: hintAnchor,
    show: showSelectionHint,
    hide: hideSelectionHint,
    refresh: refreshSelectionHint,
    hideOnTyping: hideHintOnTyping
  } = useSelectionActionHint(
    () => opts.rootRef.value,
    () => lastBox
  )

  void window.electronAPI?.artifactPreview?.guestPreloadUrl?.()
    .then((url) => {
      if (typeof url === 'string' && url) guestPreloadUrl.value = url
    })
    .finally(() => {
      preloadResolved.value = true
    })

  function currentZoom(): number {
    try {
      return opts.webviewRef.value?.getZoomFactor() ?? 1
    } catch {
      return 1
    }
  }

  function updateBoxFromGuest(box: { left: number; top: number; right: number; bottom: number } | null) {
    const wv = opts.webviewRef.value
    if (!box || !wv) {
      lastBox = null
      return
    }
    lastBox = hostBoxFromGuest(box, wv.getBoundingClientRect(), currentZoom())
  }

  function sendCmd(cmd: HtmlPreviewSelectionCmd) {
    const wv = opts.webviewRef.value
    if (!wv) return
    try {
      wv.send(HTML_PREVIEW_SELECTION_CMD_CHANNEL, cmd)
    } catch {
      /* guest 未 attach */
    }
  }

  function clearSticky() {
    lastExcerpt = ''
    lastBox = null
    hideSelectionHint()
    sendCmd({ op: 'clear' })
  }

  function pinSticky() {
    if (!lastExcerpt) return
    hideSelectionHint()
    sendCmd({ op: 'pin' })
  }

  function buildSelectionScope(): ArtifactComposerQuote | null {
    const trimmed = lastExcerpt.trim()
    if (!trimmed || !enabled.value) return null
    const fp = opts.filePath.value
    const title = opts.title.value
    return {
      label: fp ? artifactBasename(fp) : (title || 'HTML'),
      sourcePath: fp || null,
      sourceLinesAccurate: false,
      quoteOrigin: 'canvas',
      startLine: null,
      endLine: null,
      excerpt: trimmed
    }
  }

  function onGuestReport(raw: unknown) {
    const report = parseHtmlPreviewSelectionReport(raw)
    if (!report || !enabled.value) return
    if (report.kind === 'scroll') {
      hideSelectionHint()
      return
    }
    if (report.excerpt) {
      lastExcerpt = report.excerpt
      updateBoxFromGuest(report.box)
      if (report.kind === 'mouseup') showSelectionHint()
      else refreshSelectionHint()
      return
    }
    if (report.kind === 'mouseup') clearSticky()
  }

  function onIpcMessage(e: IpcMessageEvent) {
    if (e.channel !== HTML_PREVIEW_SELECTION_CHANNEL) return
    onGuestReport(e.args[0])
  }

  async function installGuest() {
    if (!enabled.value) return
    const wv = opts.webviewRef.value
    if (!wv) return
    try {
      await wv.executeJavaScript(htmlPreviewSelectionGuestScript())
    } catch {
      /* guest 未就绪或已销毁 */
    }
  }

  function pinIfPointerLeftPreview(target: EventTarget | null) {
    if (!enabled.value || !lastExcerpt) return
    const el = target as HTMLElement | null
    const inside = !!(opts.rootRef.value && el && opts.rootRef.value.contains(el))
    if (inside) {
      hideSelectionHint()
      return
    }
    pinSticky()
  }

  function onGlobalMouseDown(e: MouseEvent) {
    if (e.button !== 0) return
    pinIfPointerLeftPreview(e.target)
  }

  function onFocusIn(e: FocusEvent) {
    pinIfPointerLeftPreview(e.target)
  }

  function onGlobalKeydown(e: KeyboardEvent) {
    hideHintOnTyping(e)
    if (e.key === 'Escape') clearSticky()
  }

  function onWindowKeydown(e: KeyboardEvent) {
    const meta = e.metaKey || e.ctrlKey
    if (!meta || e.shiftKey || e.altKey) return
    if (e.key.toLowerCase() !== 'l') return
    if (!lastExcerpt.trim() || !enabled.value) return
    e.preventDefault()
    e.stopPropagation()
    setComposerDraft?.('')
    hideSelectionHint()
  }

  watch(enabled, (on) => {
    if (!on) clearSticky()
  })

  watch(() => opts.artifactId.value, () => {
    lastExcerpt = ''
    lastBox = null
    hideSelectionHint()
  })

  onMounted(() => {
    unregisterSelectionScope = registerSelectionScopeProvider(opts.tabId, {
      getScope: () => buildSelectionScope(),
      clearScope: () => clearSticky()
    })
    document.addEventListener('focusin', onFocusIn)
    document.addEventListener('mousedown', onGlobalMouseDown, true)
    window.addEventListener('keydown', onWindowKeydown, true)
    window.addEventListener('keydown', onGlobalKeydown)
  })

  onUnmounted(() => {
    unregisterSelectionScope?.()
    unregisterSelectionScope = null
    document.removeEventListener('focusin', onFocusIn)
    document.removeEventListener('mousedown', onGlobalMouseDown, true)
    window.removeEventListener('keydown', onWindowKeydown, true)
    window.removeEventListener('keydown', onGlobalKeydown)
    lastExcerpt = ''
    lastBox = null
  })

  return {
    hintAnchor,
    selectionPreload: computed(() => (enabled.value ? guestPreloadUrl.value : '')),
    selectionBridgeReady: computed(() => !enabled.value || !!guestPreloadUrl.value || preloadResolved.value),
    onGuestDomReady: installGuest,
    onGuestIpcMessage: onIpcMessage,
    onGuestNavigating: clearSticky
  }
}
