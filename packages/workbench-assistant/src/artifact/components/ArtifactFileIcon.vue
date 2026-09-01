<script setup lang="ts">
/**
 * 产出物类型图标：优先系统图标，否则退回通用类型图标。
 */
import { computed } from 'vue'
import type { CanvasRendererType } from '@shared/types'
import SystemFileIcon from './SystemFileIcon.vue'
import { getRendererIcon } from '../renderers/ui-registry'

const props = withDefaults(defineProps<{
  filePath?: string | null
  renderer: CanvasRendererType
  size?: number
}>(), {
  size: 18,
})

const fallbackIcon = computed(() => getRendererIcon(props.renderer))
</script>

<template>
  <SystemFileIcon :file-path="filePath" :size="size">
    <component
      :is="fallbackIcon"
      class="artifact-file-icon artifact-file-icon--fallback"
      :size="size"
    />
  </SystemFileIcon>
</template>

<style scoped>
.artifact-file-icon {
  display: block;
  flex-shrink: 0;
}

.artifact-file-icon--fallback {
  color: var(--text-secondary, #aaa);
}
</style>
