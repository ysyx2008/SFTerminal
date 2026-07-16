<script setup lang="ts">
/**
 * 附件类型图标：Lucide 线框 + 按类型着色（跨平台一致）
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
import { getAttachmentIconMeta, type AttachmentIconKind } from '../utils/attachment-icon'

const props = withDefaults(defineProps<{
  fileType?: string
  filename?: string
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
</script>

<template>
  <component
    :is="icon"
    class="attachment-file-icon"
    :size="size"
    :stroke-width="2"
    :style="{ color: meta.color }"
    aria-hidden="true"
  />
</template>

<style scoped>
.attachment-file-icon {
  flex-shrink: 0;
  display: block;
}
</style>
