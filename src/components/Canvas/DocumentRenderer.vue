<script setup lang="ts">
/**
 * Canvas DocumentRenderer
 *
 * 渲染 Word 文档的 HTML 预览（由 mammoth.js 转换）。
 * 只读展示，内容通过 canvas store 的 content 字段获取。
 */
import { computed } from 'vue'
import { useCanvasStore } from '../../stores/canvas'

const props = defineProps<{
  tabId: string
}>()

const canvasStore = useCanvasStore()
const content = computed(() => canvasStore.getState(props.tabId).content)
</script>

<template>
  <div class="document-renderer">
    <div class="document-content" v-html="content"></div>
  </div>
</template>

<style scoped>
.document-renderer {
  width: 100%;
  height: 100%;
  overflow-y: auto;
  overflow-x: hidden;
  background: var(--bg-primary, #1e1e1e);
  padding: 16px 20px;
}

.document-content {
  max-width: 700px;
  margin: 0 auto;
  color: var(--text-primary, #e0e0e0);
  font-size: 14px;
  line-height: 1.7;
  word-wrap: break-word;
}

/* mammoth 输出的 HTML 元素样式 */
.document-content :deep(h1) {
  font-size: 1.6em;
  font-weight: 700;
  margin: 1.2em 0 0.6em;
  color: var(--text-primary, #fff);
  border-bottom: 1px solid var(--border-color, rgba(255, 255, 255, 0.1));
  padding-bottom: 0.3em;
}

.document-content :deep(h2) {
  font-size: 1.35em;
  font-weight: 600;
  margin: 1em 0 0.5em;
  color: var(--text-primary, #fff);
}

.document-content :deep(h3) {
  font-size: 1.15em;
  font-weight: 600;
  margin: 0.8em 0 0.4em;
  color: var(--text-primary, #fff);
}

.document-content :deep(p) {
  margin: 0.5em 0;
}

.document-content :deep(ul),
.document-content :deep(ol) {
  padding-left: 1.5em;
  margin: 0.5em 0;
}

.document-content :deep(li) {
  margin: 0.2em 0;
}

.document-content :deep(table) {
  width: 100%;
  border-collapse: collapse;
  margin: 0.8em 0;
  font-size: 13px;
}

.document-content :deep(th),
.document-content :deep(td) {
  border: 1px solid var(--border-color, rgba(255, 255, 255, 0.15));
  padding: 6px 10px;
  text-align: left;
}

.document-content :deep(th) {
  background: var(--bg-secondary, #252525);
  font-weight: 600;
}

.document-content :deep(strong) {
  font-weight: 600;
  color: var(--text-primary, #fff);
}

.document-content :deep(em) {
  font-style: italic;
}

.document-content :deep(a) {
  color: var(--accent-color, #4a9eff);
  text-decoration: none;
}

.document-content :deep(a:hover) {
  text-decoration: underline;
}

.document-content :deep(img) {
  max-width: 100%;
  height: auto;
  border-radius: 4px;
  margin: 0.5em 0;
}

.document-content :deep(blockquote) {
  border-left: 3px solid var(--accent-color, #4a9eff);
  padding-left: 12px;
  margin: 0.5em 0;
  color: var(--text-secondary, #aaa);
}
</style>
