<script setup lang="ts">
/**
 * 系统文件图标：有磁盘路径时显示本机图标，否则走默认插槽。
 */
import { ref, watch } from 'vue'
import { loadSystemFileIconUrl } from '../system-file-icon'

const props = withDefaults(defineProps<{
  filePath?: string | null
  cacheKey?: string
  size?: number
}>(), {
  size: 16,
})

const dataUrl = ref<string | null>(null)
let loadGen = 0

async function loadIcon() {
  const gen = ++loadGen
  const url = await loadSystemFileIconUrl({
    filePath: props.filePath,
    cacheKey: props.cacheKey,
  })
  if (gen === loadGen) dataUrl.value = url
}

watch(
  () => [props.filePath, props.cacheKey],
  () => { void loadIcon() },
  { immediate: true },
)
</script>

<template>
  <img
    v-if="dataUrl"
    class="system-file-icon"
    :src="dataUrl"
    :width="size"
    :height="size"
    alt=""
    draggable="false"
    aria-hidden="true"
  >
  <slot v-else />
</template>

<style scoped>
.system-file-icon {
  display: block;
  flex-shrink: 0;
  width: v-bind('`${size}px`');
  height: v-bind('`${size}px`');
  object-fit: contain;
}
</style>
