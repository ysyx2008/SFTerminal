<script setup lang="ts">
/**
 * Canvas SlidesRenderer — Slide HTML 预览（iframe srcdoc，支持完整文档与多页滚动）
 */
import { computed, ref, watch, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAssistantArtifactStore } from '../store'

const props = defineProps<{
  tabId: string
  artifactId: string
}>()

const { t } = useI18n()
const artifactStore = useAssistantArtifactStore()
const content = computed(() => artifactStore.getArtifactById(props.tabId, props.artifactId)?.content ?? '')
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
      :title="t('canvas.slidesPreview')"
      sandbox="allow-same-origin"
      referrerpolicy="no-referrer"
    />
    <div v-else class="slides-empty">{{ t('canvas.slidesPreviewEmpty') }}</div>
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
  border: none;
  background: #fff;
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
