<script setup lang="ts">
/**
 * Canvas HtmlRenderer — 交互式 HTML 产出物预览（应用内嵌浏览器）
 *
 * 用 <webview>（独立渲染进程）渲染产出物 HTML：sanitize/背景注入后的最终 HTML
 * 推送到主进程缓存，webview 经 sailfish-artifact:// 协议加载。
 * 不用 iframe srcdoc：跨域无法视觉截图、不支持 live URL；不用 blob:/file:// 见 SPEC。
 * 注：复用 html 渲染器的 PPT 预览也走此组件（content 为内联 HTML，filePath 指向 .pptx）。
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { RotateCw, ExternalLink, Camera } from 'lucide-vue-next'
import type { DidFailLoadEvent, WebviewTag, WillNavigateEvent } from 'electron'
import { buildArtifactPreviewUrl } from '@shared/types'
import { useAssistantArtifactStore } from '../store'
import { useToast } from '@sailfish/workbench-sdk/toast'
import { normalizeHtmlPreviewContent } from '../domain/html-preview'
import { BUTTON_HOVER_TIP_DELAY_MS, useHoverTip } from '../ui/useHoverTip'
import HoverTipOverlay from '../ui/HoverTipOverlay.vue'

const props = defineProps<{
  tabId: string
  artifactId: string
}>()

/** 截图反馈：emit 给 ArtifactPanel（截图落盘 + 注入 Composer 图片与草稿） */
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
const content = computed(() => artifact.value?.content ?? '')
const filePath = computed(() => artifact.value?.filePath ?? null)
const canOpenExternal = computed(() => Boolean(filePath.value))
/** PPT 预览：预览内容是可滚动的幻灯片卡片列表，需要视觉留白；普通 HTML 产出物填满即可 */
const isPptPreview = computed(() => filePath.value?.toLowerCase().endsWith('.pptx') ?? false)

/** 历史 PPT 预览若仍引用 jsDelivr echarts，外链可能失效；主进程内联修复 */
function previewNeedsSanitize(html: string): boolean {
  if (/src\s*=\s*["'](?:https?:)?\/\/[^"']*echarts/i.test(html)) return true
  if (/echarts\.(init|registerMap)/i.test(html)) {
    const hasInlineBundle = /<script(?![^>]*\bsrc=)[^>]*>[\s\S]{50000,}/i.test(html)
    if (!hasInlineBundle) return true
  }
  return false
}

const sanitizedBase = ref('')
const loadingFromDisk = ref(false)

async function loadContentFromDisk(path: string): Promise<string | null> {
  const previewApi = window.electronAPI?.localFs?.previewArtifact
  const readApi = window.electronAPI?.localFs?.readFile
  try {
    if (previewApi) {
      const res = await previewApi(path, 'html')
      if (res.success && typeof res.data === 'string' && res.data.trim()) {
        return res.data
      }
    }
    if (readApi) {
      const res = await readApi(path)
      if (res.success && typeof res.data === 'string' && res.data.trim()) {
        return res.data
      }
    }
  } catch {
    /* 读盘失败由空态提示 */
  }
  return null
}

async function ensureContentLoaded() {
  const path = filePath.value
  if (!path || content.value.trim()) return

  loadingFromDisk.value = true
  try {
    const data = await loadContentFromDisk(path)
    if (data) {
      artifactStore.updateContent(props.tabId, data, props.artifactId)
    }
  } finally {
    loadingFromDisk.value = false
  }
}

watch([content, filePath], () => {
  void ensureContentLoaded()
}, { immediate: true })

watch(
  [content, isPptPreview],
  async () => {
    const raw = content.value
    if (!raw.trim()) {
      sanitizedBase.value = ''
      return
    }
    if (isPptPreview.value && previewNeedsSanitize(raw)) {
      try {
        sanitizedBase.value = await window.electronAPI.ppt.sanitizePreview(raw)
      } catch {
        sanitizedBase.value = raw
      }
    } else {
      sanitizedBase.value = normalizeHtmlPreviewContent(raw, isPptPreview.value)
    }
  },
  { immediate: true }
)

/**
 * PPT 预览时，把宿主页面的 --bg-primary 注入预览 <head>，
 * 让预览 body 背景与外层容器完全一致，消除色差。
 */
const previewHtml = computed(() => {
  const base = sanitizedBase.value
  if (!isPptPreview.value || !base) return base
  const bgPrimary = getComputedStyle(document.documentElement)
    .getPropertyValue('--bg-primary').trim() || '#1a1a1e'
  const override = `<style>html,body{background:${bgPrimary}!important;}</style>`
  return base.includes('</head>')
    ? base.replace('</head>', `${override}</head>`)
    : override + base
})

const previewUrl = computed(() => buildArtifactPreviewUrl(props.tabId, props.artifactId))

const webviewRef = ref<WebviewTag | null>(null)
/** webview 是否已完成首次 src 设置（之后内容更新走 reload） */
const webviewAttached = ref(false)
const loadFailed = ref(false)

/** 推送内容到主进程缓存，确认就绪后加载/刷新 webview（await 消除与协议请求的竞态） */
async function syncAndRender(html: string) {
  const api = window.electronAPI?.artifactPreview
  if (!api || !html) return
  await api.sync({
    tabId: props.tabId,
    artifactId: props.artifactId,
    content: html
  })
  const wv = webviewRef.value
  if (!wv) return
  if (!webviewAttached.value) {
    webviewAttached.value = true
    wv.setAttribute('src', previewUrl.value)
  } else {
    wv.reload()
  }
}

watch(previewHtml, (html) => {
  loadFailed.value = false
  if (!html) return
  // webview 元素由 v-if="previewHtml" 控制，此处等下一拍确保元素已挂载
  void nextTick(() => syncAndRender(html))
}, { immediate: true })

/**
 * 内容型预览：外链导航转系统浏览器，预览停留在产出物本身。
 * （window.open / target=_blank 由主进程 web-contents-created 统一拦截，见 artifact-preview.service）
 * 模板 @will-navigate 绑定在元素上只注册一次，无监听器累积问题。
 */
function onWillNavigate(e: WillNavigateEvent) {
  let same: boolean
  try {
    const target = new URL(e.url)
    const self = new URL(previewUrl.value)
    same = target.protocol === self.protocol && target.host === self.host && target.pathname === self.pathname
  } catch {
    same = false
  }
  if (!same) {
    e.preventDefault()
    void window.electronAPI?.localFs?.openExternal?.(e.url)
  }
}

function onWebviewFailLoad(e: DidFailLoadEvent) {
  // -3 = ERR_ABORTED（连续 reload 打断上一次加载），非真实失败
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

function captureFeedback() {
  const wv = webviewRef.value
  if (!wv) return
  try {
    const webContentsId = wv.getWebContentsId()
    emit('captureFeedback', {
      webContentsId,
      suggestedName: artifact.value?.title || 'artifact'
    })
  } catch {
    /* webview 尚未 attach（无内容）时 getWebContentsId 抛错，按钮此时不可见 */
  }
}

onBeforeUnmount(() => {
  // 切换产出物/关闭面板时清掉自己的缓存条目（tab 关闭时由 store.cleanup 整 tab 清理）
  window.electronAPI?.artifactPreview?.clear(props.tabId, props.artifactId)
})
</script>

<template>
  <div class="html-renderer">
    <div class="html-toolbar" :class="{ 'html-toolbar--ppt': isPptPreview }">
      <button
        type="button"
        class="html-tool-btn"
        @mouseenter="showTip($event, t('canvas.htmlRefresh'))"
        @mouseleave="hideTip"
        @click="refresh"
      >
        <RotateCw :size="14" />
      </button>
      <button
        v-if="canOpenExternal && !isPptPreview"
        type="button"
        class="html-tool-btn"
        @mouseenter="showTip($event, t('canvas.htmlOpenExternal'))"
        @mouseleave="hideTip"
        @click="openExternal"
      >
        <ExternalLink :size="14" />
      </button>
      <button
        v-if="previewHtml"
        type="button"
        class="html-tool-btn html-toolbar-feedback"
        @mouseenter="showTip($event, t('canvas.htmlCaptureFeedback'), 'left')"
        @mouseleave="hideTip"
        @click="captureFeedback"
      >
        <Camera :size="14" />
      </button>
    </div>
    <div class="html-body" :class="{ 'html-body--ppt': isPptPreview }">
      <webview
        v-if="previewHtml"
        ref="webviewRef"
        class="html-frame"
        :title="t('canvas.htmlPreview')"
        allowpopups
        @will-navigate="onWillNavigate"
        @did-fail-load="onWebviewFailLoad"
      />
      <div v-else-if="loadingFromDisk" class="html-empty">{{ t('canvas.htmlPreviewLoading') }}</div>
      <div v-else class="html-empty">{{ t('canvas.htmlPreviewEmpty') }}</div>
      <div v-if="loadFailed" class="html-empty html-empty--overlay">{{ t('canvas.htmlPreviewFailed') }}</div>
    </div>
    <HoverTipOverlay :tip="hoverTip" />
  </div>
</template>

<style scoped>
.html-renderer {
  width: 100%;
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg-primary, #1a1a1e);
}

.html-toolbar {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
  padding: 5px 10px;
  background: var(--bg-tertiary, var(--bg-secondary, #252525));
  border-bottom: 1px solid var(--border-color, rgba(255, 255, 255, 0.08));
}

/* PPT 预览：工具栏与主体背景对齐，消除色差；外部打开由 ArtifactPanel 头部负责 */
.html-toolbar--ppt {
  background: var(--bg-primary, #1a1a1e);
  border-bottom-color: rgba(255, 255, 255, 0.05);
}

.html-tool-btn {
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
}

.html-tool-btn:hover {
  background: var(--hover-bg, rgba(255, 255, 255, 0.08));
  color: var(--text-primary, #ddd);
}

/* 反馈动作与预览操作分区：推到工具栏右侧 */
.html-toolbar-feedback {
  margin-left: auto;
}

.html-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg-primary, #1a1a1e);
  overflow: hidden;
  position: relative;
}

/* PPT 预览：预览周围加留白，让幻灯片卡片不贴边；滚动依然在 webview 内部进行 */
.html-body--ppt {
  padding: 20px;
}

.html-body--ppt .html-frame {
  border-radius: 8px;
}

.html-frame {
  flex: 1;
  width: 100%;
  border: none;
  background: var(--bg-primary, #1a1a1e);
}

.html-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-secondary, #888);
  font-size: 13px;
}

.html-empty--overlay {
  position: absolute;
  inset: 0;
  background: var(--bg-primary, #1a1a1e);
}
</style>
