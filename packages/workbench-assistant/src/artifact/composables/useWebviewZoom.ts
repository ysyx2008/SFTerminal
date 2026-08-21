import { computed, ref, type Ref } from 'vue'
import type { WebviewTag } from 'electron'
import {
  WEBVIEW_ZOOM_DEFAULT,
  WEBVIEW_ZOOM_MAX,
  WEBVIEW_ZOOM_MIN,
  clampWebviewZoom,
  formatWebviewZoomPercent,
  stepWebviewZoom
} from '../domain/webview-zoom'

/**
 * 网页预览缩放。比例只存在组件实例上（当次打开），重启后回到 100%。
 * 每次 guest 就绪都重新套上当前比例，盖掉 Chromium 按站点记住的缩放。
 */
export function useWebviewZoom(webviewRef: Ref<WebviewTag | null>) {
  const zoomFactor = ref(WEBVIEW_ZOOM_DEFAULT)
  const zoomPercentLabel = computed(() => formatWebviewZoomPercent(zoomFactor.value))
  const isZoomed = computed(() => zoomFactor.value !== WEBVIEW_ZOOM_DEFAULT)

  function applyToGuest() {
    const wv = webviewRef.value
    if (!wv) return
    try {
      wv.setZoomFactor(zoomFactor.value)
      void wv.setVisualZoomLevelLimits(WEBVIEW_ZOOM_MIN, WEBVIEW_ZOOM_MAX)
    } catch {
      /* guest 未 attach */
    }
  }

  function setZoom(factor: number) {
    zoomFactor.value = clampWebviewZoom(factor)
    applyToGuest()
  }

  function zoomIn() {
    setZoom(stepWebviewZoom(zoomFactor.value, 1))
  }

  function zoomOut() {
    setZoom(stepWebviewZoom(zoomFactor.value, -1))
  }

  function resetZoom() {
    setZoom(WEBVIEW_ZOOM_DEFAULT)
  }

  function onDomReady() {
    applyToGuest()
  }

  function onZoomChanged() {
    const wv = webviewRef.value
    if (!wv) return
    try {
      zoomFactor.value = clampWebviewZoom(wv.getZoomFactor())
    } catch {
      /* guest 未 attach */
    }
  }

  return {
    zoomPercentLabel,
    isZoomed,
    zoomIn,
    zoomOut,
    resetZoom,
    onDomReady,
    onZoomChanged
  }
}
