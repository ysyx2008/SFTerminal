<script setup lang="ts">
/**
 * Canvas HtmlRenderer — 交互式 HTML 产出物预览
 *
 * 用 iframe srcdoc 渲染产出物的 HTML 源码，开启脚本以支持图表/动画/Tab 等交互。
 * 出于安全考虑不加 allow-same-origin：iframe 以不透明源运行，脚本无法访问父页面。
 * 注：复用 html 渲染器的 PPT 预览也走此组件（content 为内联 HTML，filePath 指向 .pptx）。
 */
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { RotateCw, ExternalLink } from 'lucide-vue-next'
import { useAssistantArtifactStore } from '../store'
import { useToast } from '../../../../composables/useToast'

const props = defineProps<{
  tabId: string
  artifactId: string
}>()

const { t } = useI18n()
const artifactStore = useAssistantArtifactStore()
const { error: toastError } = useToast()

const artifact = computed(() => artifactStore.getArtifactById(props.tabId, props.artifactId))
const content = computed(() => artifact.value?.content ?? '')
const filePath = computed(() => artifact.value?.filePath ?? null)
const canOpenExternal = computed(() => Boolean(filePath.value))
/** PPT 预览：iframe 内容是可滚动的幻灯片卡片列表，需要视觉留白；普通 HTML 产出物填满即可 */
const isPptPreview = computed(() => filePath.value?.toLowerCase().endsWith('.pptx') ?? false)

const iframeRef = ref<HTMLIFrameElement | null>(null)
/** 改变 key 强制重建 iframe → 重新加载页面（重跑动画/脚本） */
const reloadKey = ref(0)

watch(content, () => {
  reloadKey.value += 1
  nextTick(() => {
    iframeRef.value?.contentWindow?.scrollTo(0, 0)
  })
})

function refresh() {
  reloadKey.value += 1
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
</script>

<template>
  <div class="html-renderer">
    <div class="html-toolbar">
      <button
        type="button"
        class="html-tool-btn"
        :title="t('canvas.htmlRefresh')"
        @click="refresh"
      >
        <RotateCw :size="14" />
      </button>
      <button
        v-if="canOpenExternal"
        type="button"
        class="html-tool-btn"
        :title="t('canvas.htmlOpenExternal')"
        @click="openExternal"
      >
        <ExternalLink :size="14" />
      </button>
    </div>
    <div class="html-body" :class="{ 'html-body--ppt': isPptPreview }">
      <iframe
        v-if="content"
        :key="reloadKey"
        ref="iframeRef"
        class="html-frame"
        :srcdoc="content"
        :title="t('canvas.htmlPreview')"
        sandbox="allow-scripts allow-popups allow-forms allow-modals"
        referrerpolicy="no-referrer"
      />
      <div v-else class="html-empty">{{ t('canvas.htmlPreviewEmpty') }}</div>
    </div>
  </div>
</template>

<style scoped>
.html-renderer {
  width: 100%;
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: #16161a;
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

.html-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: #16161a;
  overflow: hidden;
}

/* PPT 预览：iframe 周围加留白，让幻灯片卡片不贴边；滚动依然在 iframe 内部进行 */
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
  background: #16161a;
}

.html-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-secondary, #888);
  font-size: 13px;
}
</style>
