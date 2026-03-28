<script setup lang="ts">
/**
 * Canvas SpreadsheetRenderer
 *
 * 渲染 Excel 表格的 HTML 预览。
 * 后端将 ExcelJS 工作表数据转为 HTML table 推送到 canvas store。
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
  <div class="spreadsheet-renderer">
    <div class="spreadsheet-content" v-html="content"></div>
  </div>
</template>

<style scoped>
.spreadsheet-renderer {
  width: 100%;
  height: 100%;
  overflow: auto;
  background: var(--bg-primary, #1e1e1e);
}

.spreadsheet-content {
  padding: 8px;
  min-width: max-content;
}

.spreadsheet-content :deep(table) {
  border-collapse: collapse;
  font-size: 12px;
  font-family: 'SF Mono', 'Menlo', 'Monaco', 'Consolas', monospace;
  white-space: nowrap;
}

.spreadsheet-content :deep(th),
.spreadsheet-content :deep(td) {
  border: 1px solid var(--border-color, rgba(255, 255, 255, 0.12));
  padding: 4px 8px;
  text-align: left;
  min-width: 60px;
  max-width: 300px;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 行号列 */
.spreadsheet-content :deep(th.row-header),
.spreadsheet-content :deep(td.row-header) {
  background: var(--bg-tertiary, #2a2a2a);
  color: var(--text-secondary, #888);
  text-align: center;
  min-width: 40px;
  max-width: 40px;
  font-weight: 400;
  position: sticky;
  left: 0;
  z-index: 1;
}

/* 列头 */
.spreadsheet-content :deep(th) {
  background: var(--bg-secondary, #252525);
  color: var(--text-secondary, #aaa);
  font-weight: 500;
  position: sticky;
  top: 0;
  z-index: 2;
}

/* 左上角单元格 */
.spreadsheet-content :deep(th.corner) {
  z-index: 3;
}

.spreadsheet-content :deep(td) {
  color: var(--text-primary, #e0e0e0);
}

/* 数字右对齐 */
.spreadsheet-content :deep(td.num) {
  text-align: right;
  font-variant-numeric: tabular-nums;
}

/* 工作表标签 */
.spreadsheet-content :deep(.sheet-tabs) {
  display: flex;
  gap: 1px;
  margin-bottom: 8px;
  border-bottom: 1px solid var(--border-color, rgba(255, 255, 255, 0.1));
}

.spreadsheet-content :deep(.sheet-tab) {
  padding: 4px 12px;
  font-size: 11px;
  color: var(--text-secondary, #aaa);
  background: var(--bg-secondary, #252525);
  border-radius: 4px 4px 0 0;
}

.spreadsheet-content :deep(.sheet-tab.active) {
  color: var(--text-primary, #fff);
  background: var(--bg-primary, #1e1e1e);
  border-bottom: 2px solid var(--accent-color, #4a9eff);
}
</style>
