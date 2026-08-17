<script setup lang="ts">
/**
 * 产出物类型图标：有磁盘路径时用系统文件图标，否则退回通用类型图标。
 */
import { computed, ref, watch } from 'vue'
import type { CanvasRendererType } from '@shared/types'
import { getRendererIcon } from '../renderers/ui-registry'

const iconUrlCache = new Map<string, string | null>()

const props = withDefaults(defineProps<{
  filePath?: string | null
  renderer: CanvasRendererType
  size?: number
}>(), {
  size: 16,
})

const dataUrl = ref<string | null>(null)

const fallbackIcon = computed(() => getRendererIcon(props.renderer))

async function loadIcon(filePath: string | null | undefined) {
  if (!filePath) {
    dataUrl.value = null
    return
  }
  const ext = filePath.split(/[./\\]/).pop()?.toLowerCase() || filePath
  if (iconUrlCache.has(ext)) {
    dataUrl.value = iconUrlCache.get(ext) ?? null
    return
  }
  try {
    const res = await window.electronAPI?.localFs?.getFileIcon?.(filePath)
    const url = res?.success && res.dataUrl ? res.dataUrl : null
    iconUrlCache.set(ext, url)
    dataUrl.value = url
  } catch {
    iconUrlCache.set(ext, null)
    dataUrl.value = null
  }
}

watch(() => props.filePath, (path) => { void loadIcon(path) }, { immediate: true })
</script>

<template>
  <img
    v-if="dataUrl"
    class="artifact-file-icon"
    :src="dataUrl"
    :width="size"
    :height="size"
    alt=""
    draggable="false"
  >
  <component
    v-else
    :is="fallbackIcon"
    class="artifact-file-icon artifact-file-icon--fallback"
    :size="size"
  />
</template>

<style scoped>
.artifact-file-icon {
  display: block;
  flex-shrink: 0;
  width: v-bind('`${size}px`');
  height: v-bind('`${size}px`');
  object-fit: contain;
}

.artifact-file-icon--fallback {
  color: var(--text-secondary, #aaa);
}
</style>
