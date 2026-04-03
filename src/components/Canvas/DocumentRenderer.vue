<script setup lang="ts">
/**
 * Canvas DocumentRenderer
 *
 * 渲染 Word 文档的 HTML 预览（由 mammoth.js 转换）。
 * 白纸效果模拟 Word 文档版式。
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
    <div class="document-page">
      <div class="document-content" v-html="content"></div>
    </div>
  </div>
</template>

<style scoped>
.document-renderer {
  width: 100%;
  height: 100%;
  overflow-y: auto;
  overflow-x: hidden;
  background: #2a2a2a;
  padding: 20px 16px;
}

/* 白纸容器 */
.document-page {
  max-width: 680px;
  margin: 0 auto;
  background: #fff;
  border-radius: 3px;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.3);
  padding: 48px 56px;
  min-height: 200px;
}

.document-content {
  color: #1a1a1a;
  font-family: 'Songti SC', 'SimSun', 'Times New Roman', serif;
  font-size: 14px;
  line-height: 1.8;
  word-wrap: break-word;
  text-align: justify;
}

/* mammoth 输出的 HTML 元素样式 */

/* 文档标题（Word Title 样式 → h1.document-title） */
.document-content :deep(h1.document-title) {
  font-family: 'STXiaoBiaoSong', 'PingFang SC', 'Microsoft YaHei', 'Helvetica Neue', sans-serif;
  font-size: 22px;
  font-weight: 700;
  margin: 0.5em 0 0.8em;
  color: #000;
  text-align: center;
}

/* 一级标题（Word Heading 1 → h1） */
.document-content :deep(h1) {
  font-family: 'STHeiti', 'Heiti SC', 'PingFang SC', 'Microsoft YaHei', 'Helvetica Neue', sans-serif;
  font-size: 18px;
  font-weight: 600;
  margin: 1em 0 0.5em;
  color: #000;
}

/* 二级标题（Word Heading 2 → h2） */
.document-content :deep(h2) {
  font-family: 'STKaiti', 'Kaiti SC', 'PingFang SC', 'Microsoft YaHei', 'Helvetica Neue', sans-serif;
  font-size: 16px;
  font-weight: 600;
  margin: 0.8em 0 0.4em;
  color: #111;
}

/* 三级标题（Word Heading 3 → h3） */
.document-content :deep(h3) {
  font-family: 'PingFang SC', 'Microsoft YaHei', 'Helvetica Neue', sans-serif;
  font-size: 15px;
  font-weight: 600;
  margin: 0.6em 0 0.3em;
  color: #222;
}

.document-content :deep(p) {
  margin: 0.4em 0;
  text-indent: 2em;
}

.document-content :deep(ul),
.document-content :deep(ol) {
  padding-left: 2em;
  margin: 0.4em 0;
}

.document-content :deep(li) {
  margin: 0.15em 0;
  text-indent: 0;
}

.document-content :deep(table) {
  width: 100%;
  table-layout: fixed;
  border-collapse: collapse;
  margin: 0.8em 0;
  font-size: 13px;
}

.document-content :deep(th),
.document-content :deep(td) {
  border: 1px solid #555;
  padding: 6px 10px;
  text-align: left;
  text-indent: 0;
  vertical-align: top;
}

.document-content :deep(th p),
.document-content :deep(td p) {
  text-indent: 0;
  margin: 0.15em 0;
}

.document-content :deep(th) {
  background: #f0f0f0;
  font-weight: 600;
  color: #111;
  text-align: center;
}

.document-content :deep(strong),
.document-content :deep(b) {
  font-weight: 700;
  color: #000;
}

.document-content :deep(em),
.document-content :deep(i) {
  font-style: italic;
}

.document-content :deep(u) {
  text-decoration: underline;
}

.document-content :deep(a) {
  color: #0563C1;
  text-decoration: underline;
}

.document-content :deep(img) {
  max-width: 100%;
  height: auto;
  margin: 0.5em 0;
}

.document-content :deep(blockquote) {
  border-left: 3px solid #ccc;
  padding-left: 12px;
  margin: 0.5em 0;
  color: #555;
}

.document-content :deep(hr) {
  border: none;
  border-top: 1px dashed #ccc;
  margin: 1.5em 0;
}

.document-content :deep(sup) {
  font-size: 0.75em;
  color: #666;
}
</style>
