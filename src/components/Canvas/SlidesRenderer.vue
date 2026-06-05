<script setup lang="ts">
/**
 * Canvas SlidesRenderer — Slide HTML 预览（iframe srcdoc，支持完整文档与多页滚动）
 */
import { computed, ref, watch, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { useCanvasStore } from '../../stores/canvas'

const props = defineProps<{
  tabId: string
}>()

const { t } = useI18n()
const canvasStore = useCanvasStore()
const content = computed(() => canvasStore.getState(props.tabId).content)
const iframeRef = ref<HTMLIFrameElement | null>(null)

watch(content, () => {
  nextTick(() => {
    iframeRef.value?.contentWindow?.scrollTo(0, 0)
  })
})
</script>

<template>
  <div class="slides-renderer">
    <iframe
      v-if="content"
      ref="iframeRef"
      class="slides-frame"
      :srcdoc="content"
      :title="t('terminal.canvas.slidesPreview')"
      sandbox="allow-same-origin"
      referrerpolicy="no-referrer"
    />
    <div v-else class="slides-empty">{{ t('terminal.canvas.slidesPreviewEmpty') }}</div>
  </div>
</template>

<style scoped>
.slides-renderer {
  width: 100%;
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: #1a1a1e;
}

.slides-frame {
  flex: 1;
  width: 100%;
  height: 100%;
  border: none;
  background: #1a1a1e;
}

.slides-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-secondary, #888);
  font-size: 13px;
}
</style>
