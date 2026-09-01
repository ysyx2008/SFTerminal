<script setup lang="ts">
/**
 * 聊天附件图标：优先系统图标，否则 Lucide 类型图标。
 */
import { computed, type Component } from 'vue'
import {
  File,
  FileText,
  FileSpreadsheet,
  FileImage,
  FileAudio,
  FileVideo,
  FileArchive,
  FileCode,
  Presentation,
} from 'lucide-vue-next'
import SystemFileIcon from '@sailfish/workbench-assistant/artifact/components/SystemFileIcon.vue'
import { getAttachmentIconMeta, resolveAttachmentExt, type AttachmentIconKind } from '../utils/attachment-icon'

const props = withDefaults(defineProps<{
  fileType?: string
  filename?: string
  filePath?: string | null
  size?: number
}>(), {
  size: 14,
})

const ICON_BY_KIND: Record<AttachmentIconKind, Component> = {
  pdf: FileText,
  word: FileText,
  sheet: FileSpreadsheet,
  slides: Presentation,
  text: FileText,
  code: FileCode,
  image: FileImage,
  audio: FileAudio,
  video: FileVideo,
  archive: FileArchive,
  file: File,
}

const meta = computed(() => getAttachmentIconMeta(props.fileType, props.filename))
const icon = computed(() => ICON_BY_KIND[meta.value.kind])
const cacheKey = computed(() => resolveAttachmentExt(props.fileType, props.filePath || props.filename))
</script>

<template>
  <SystemFileIcon :file-path="filePath" :cache-key="cacheKey" :size="size">
    <component
      :is="icon"
      class="attachment-file-icon"
      :size="size"
      :stroke-width="2"
      :style="{ color: meta.color }"
      aria-hidden="true"
    />
  </SystemFileIcon>
</template>

<style scoped>
.attachment-file-icon {
  flex-shrink: 0;
  display: block;
}
</style>
