<script setup lang="ts">
/**
 * Canvas BrowserRenderer — URL 型产出物的应用内浏览器预览
 *
 * 承载「指向某个 URL 的实时预览」（典型：Agent 启动的本地 dev server）。
 * 与 HtmlRenderer（内容型，sailfish-artifact:// 协议供给）不同，本组件直接加载真实 URL，
 * 地址栏可编辑跳转；http/https 自由导航，其他协议转系统浏览器。
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { RotateCw, ExternalLink, Camera, Globe } from 'lucide-vue-next'
import type { DidFailLoadEvent, DidNavigateEvent, WebviewTag, WillNavigateEvent } from 'electron'
import { useAssistantArtifactStore } from '../store'
import { useToast } from '@sailfish/workbench-sdk/toast'
import { BUTTON_HOVER_TIP_DELAY_MS, useHoverTip } from '../ui/useHoverTip'
import HoverTipOverlay from '../ui/HoverTipOverlay.vue'

const props = defineProps<{
  tabId: string
  artifactId: string
}>()

const emit = defineEmits<{
  captureFeedback: [payload: { webContentsId: number; suggestedName: string }]
}>()

const { t } = useI18n()
const artifactStore = useAssistantArtifactStore()
const { error: toastError } = useToast()
const { hoverTip, showTip, hideTip } = useHoverTip({
  placement: 'bottom',
  delayMs: BUTTON_HOVER_TIP_DELAY_MS
})

const artifact = computed(() => artifactStore.getArtifactById(props.tabId, props.artifactId))
const targetUrl = computed(() => artifact.value?.url ?? '')

const webviewRef = ref<WebviewTag | null>(null)
const webviewAttached = ref(false)
const loadFailed = ref(false)
/** 地址栏显示值（跟随导航事件更新；编辑中不打断） */
const addressValue = ref('')
const addressEditing = ref(false)

function isHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url)
}

function attachWebview(url: string) {
  const wv = webviewRef.value
  if (!wv || !url) return
  webviewAttached.value = true
  wv.setAttribute('src', url)
}

// artifact.url 变化（含首次出现）：加载新地址
watch(targetUrl, (url) => {
  loadFailed.value = false
  if (!url) return
  if (!addressEditing.value) addressValue.value = url
  if (!webviewAttached.value) {
    // webview 元素由 v-if="targetUrl" 控制，等下一拍确保已挂载
    void nextTick(() => attachWebview(url))
  } else {
    webviewRef.value?.loadURL(url).catch(() => { loadFailed.value = true })
  }
}, { immediate: true })

function navigateFromAddressBar() {
  const url = addressValue.value.trim()
  if (!url || !isHttpUrl(url)) return
  addressEditing.value = false
  const wv = webviewRef.value
  if (!wv) return
  loadFailed.value = false
  wv.loadURL(url).catch(() => { loadFailed.value = true })
}

function onNavigate(e: DidNavigateEvent) {
  if (!addressEditing.value) addressValue.value = e.url
  loadFailed.value = false
}

/** 仅 http/https 允许在预览内导航；其他协议（file: 等）转系统浏览器。模板绑定只注册一次 */
function onWillNavigate(e: WillNavigateEvent) {
  if (!isHttpUrl(e.url)) {
    e.preventDefault()
    void window.electronAPI?.localFs?.openExternal?.(e.url)
  }
}

function onWebviewFailLoad(e: DidFailLoadEvent) {
  // -3 = ERR_ABORTED（连续导航打断上一次加载），非真实失败
  if (e.errorCode === -3) return
  loadFailed.value = true
}

function refresh() {
  const wv = webviewRef.value
  if (!wv || !webviewAttached.value) return
  loadFailed.value = false
  wv.reload()
}

async function openExternal() {
  // 打开地址栏当前地址（用户可能已导航到他页），而非仅初始 url
  const url = addressValue.value.trim() || targetUrl.value
  if (!url) return
  const api = window.electronAPI?.localFs
  if (!api?.openExternal) {
    toastError(t('canvas.openFailed'))
    return
  }
  const res = await api.openExternal(url)
  if (!res.success) {
    toastError(res.error || t('canvas.openFailed'))
  }
}

function captureFeedback() {
  const wv = webviewRef.value
  if (!wv) return
  try {
    const webContentsId = wv.getWebContentsId()
    emit('captureFeedback', {
      webContentsId,
      suggestedName: artifact.value?.title || 'page'
    })
  } catch {
    /* webview 尚未 attach 时 getWebContentsId 抛错，按钮此时不可用 */
  }
}

onBeforeUnmount(() => {
  // 停止 guest 加载，加速 webview 进程回收
  try {
    webviewRef.value?.stop()
  } catch {
    /* webview 未 attach 时忽略 */
  }
})
</script>

<template>
  <div class="browser-renderer">
    <div class="browser-toolbar">
      <button
        type="button"
        class="browser-tool-btn"
        @mouseenter="showTip($event, t('canvas.htmlRefresh'))"
        @mouseleave="hideTip"
        @click="refresh"
      >
        <RotateCw :size="14" />
      </button>
      <div class="browser-address">
        <Globe :size="12" class="browser-address-icon" />
        <input
          v-model="addressValue"
          type="text"
          class="browser-address-input"
          :placeholder="t('canvas.browserAddressPlaceholder')"
          spellcheck="false"
          @focus="addressEditing = true"
          @blur="addressEditing = false"
          @keydown.enter.prevent="navigateFromAddressBar"
        />
      </div>
      <button
        type="button"
        class="browser-tool-btn"
        @mouseenter="showTip($event, t('canvas.browserOpenExternal'))"
        @mouseleave="hideTip"
        @click="openExternal"
      >
        <ExternalLink :size="14" />
      </button>
      <button
        type="button"
        class="browser-tool-btn"
        @mouseenter="showTip($event, t('canvas.htmlCaptureFeedback'), 'left')"
        @mouseleave="hideTip"
        @click="captureFeedback"
      >
        <Camera :size="14" />
      </button>
    </div>
    <div class="browser-body">
      <webview
        v-if="targetUrl"
        ref="webviewRef"
        class="browser-frame"
        :title="t('canvas.browserPreview')"
        allowpopups
        @will-navigate="onWillNavigate"
        @did-navigate="onNavigate"
        @did-navigate-in-page="onNavigate"
        @did-fail-load="onWebviewFailLoad"
      />
      <div v-else class="browser-empty">{{ t('canvas.browserPreviewEmpty') }}</div>
      <div v-if="loadFailed" class="browser-empty browser-empty--overlay">{{ t('canvas.htmlPreviewFailed') }}</div>
    </div>
    <HoverTipOverlay :tip="hoverTip" />
  </div>
</template>

<style scoped>
.browser-renderer {
  width: 100%;
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg-primary, #1a1a1e);
}

.browser-toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
  padding: 5px 10px;
  background: var(--bg-tertiary, var(--bg-secondary, #252525));
  border-bottom: 1px solid var(--border-color, rgba(255, 255, 255, 0.08));
}

.browser-tool-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--text-secondary, #888);
  cursor: pointer;
  transition: background 0.12s, color 0.12s;
  flex-shrink: 0;
}

.browser-tool-btn:hover {
  background: var(--hover-bg, rgba(255, 255, 255, 0.08));
  color: var(--text-primary, #ddd);
}

.browser-address {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 10px;
  height: 26px;
  border-radius: 6px;
  background: var(--bg-primary, rgba(0, 0, 0, 0.25));
  border: 1px solid var(--border-color, rgba(255, 255, 255, 0.08));
}

.browser-address-icon {
  color: var(--text-secondary, #888);
  flex-shrink: 0;
}

.browser-address-input {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  background: transparent;
  color: var(--text-primary, #ddd);
  font-size: 12px;
  font-family: inherit;
}

.browser-address-input::placeholder {
  color: var(--text-secondary, #888);
}

.browser-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  position: relative;
}

.browser-frame {
  flex: 1;
  width: 100%;
  border: none;
  background: var(--bg-primary, #1a1a1e);
}

.browser-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-secondary, #888);
  font-size: 13px;
}

.browser-empty--overlay {
  position: absolute;
  inset: 0;
  background: var(--bg-primary, #1a1a1e);
}
</style>
