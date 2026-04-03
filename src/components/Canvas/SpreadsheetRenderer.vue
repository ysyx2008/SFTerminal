<script setup lang="ts">
/**
 * Canvas SpreadsheetRenderer
 *
 * 渲染 Excel 表格的 HTML 预览，仿 Excel 白底绿色主题。
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
  background: #f3f3f3;
}

.spreadsheet-content {
  padding: 0;
  min-width: max-content;
}

.spreadsheet-content :deep(table) {
  border-collapse: collapse;
  font-size: 12px;
  font-family: 'Calibri', 'Segoe UI', 'Helvetica Neue', Arial, sans-serif;
  white-space: nowrap;
  background: #fff;
}

.spreadsheet-content :deep(th),
.spreadsheet-content :deep(td) {
  border: 1px solid #d4d4d4;
  padding: 3px 6px;
  text-align: left;
  min-width: 64px;
  max-width: 300px;
  overflow: hidden;
  text-overflow: ellipsis;
  height: 20px;
}

/* 行号列 */
.spreadsheet-content :deep(th.row-header),
.spreadsheet-content :deep(td.row-header) {
  background: #f8f8f8;
  color: #555;
  text-align: center;
  min-width: 36px;
  max-width: 50px;
  font-weight: 400;
  font-size: 11px;
  border-color: #d4d4d4;
  position: sticky;
  left: 0;
  z-index: 1;
}

/* 列头 (A, B, C...) */
.spreadsheet-content :deep(th) {
  background: #f8f8f8;
  color: #555;
  font-weight: 500;
  font-size: 11px;
  text-align: center;
  border-color: #d4d4d4;
  position: sticky;
  top: 0;
  z-index: 2;
}

/* 左上角 */
.spreadsheet-content :deep(th.corner) {
  z-index: 3;
  background: #f0f0f0;
}

/* 数据单元格 */
.spreadsheet-content :deep(td) {
  color: #1a1a1a;
  background: #fff;
}

/* 数字右对齐 */
.spreadsheet-content :deep(td.num) {
  text-align: right;
  font-variant-numeric: tabular-nums;
}

/* 新增 / 修改的单元格：静态蓝色底色 */
.spreadsheet-content :deep(td.modified) {
  background-color: #e8f0fe;
}

/* 即将被删除的行：红色高亮（1 秒） */
.spreadsheet-content :deep(td.deleting) {
  background-color: #fee2e2;
  animation: cell-deleting-flash 1s ease-out;
}

@keyframes cell-deleting-flash {
  0% { background-color: #fca5a5; }
  100% { background-color: #fee2e2; }
}

/* 删除行后上移填补：从下方滑入 */
.spreadsheet-content :deep(td.shifted) {
  animation: cell-slide-up 0.75s ease-out;
}

@keyframes cell-slide-up {
  from { transform: translateY(24px); opacity: 0; }
  to { transform: translateY(0); opacity: 1; }
}

/* 删除列后左移填补：从右侧滑入 */
.spreadsheet-content :deep(td.shifted-col) {
  animation: cell-slide-left 0.75s ease-out;
}

@keyframes cell-slide-left {
  from { transform: translateX(24px); opacity: 0; }
  to { transform: translateX(0); opacity: 1; }
}

/* 工作表标签栏 */
.spreadsheet-content :deep(.sheet-tabs) {
  display: flex;
  gap: 0;
  padding: 0 4px;
  background: #e8e8e8;
  border-top: 1px solid #d4d4d4;
  position: sticky;
  bottom: 0;
}

.spreadsheet-content :deep(.sheet-tab) {
  padding: 5px 14px;
  font-size: 11px;
  font-family: 'Calibri', 'Segoe UI', Arial, sans-serif;
  color: #555;
  background: #e0e0e0;
  border: 1px solid #d4d4d4;
  border-bottom: none;
  border-radius: 0 0 0 0;
  margin-top: 2px;
  cursor: default;
}

.spreadsheet-content :deep(.sheet-tab.active) {
  color: #1a1a1a;
  background: #fff;
  font-weight: 500;
  border-bottom: 1px solid #fff;
  margin-bottom: -1px;
}

/* 截断提示 */
.spreadsheet-content :deep(p) {
  margin: 4px 8px;
  font-family: 'Calibri', Arial, sans-serif;
}
</style>
