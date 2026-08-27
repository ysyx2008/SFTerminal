<script setup lang="ts">
/**
 * Canvas SpreadsheetRenderer
 *
 * 渲染 Excel 表格的 HTML 预览，仿 Excel 白底绿色主题。
 * 预览只读；多 sheet 时底部标签由本组件绘制，点击切换（不改文件）。
 */
import { computed, nextTick, ref, toRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAssistantArtifactStore } from '../store'
import { useArtifactContentHydration } from '../composables/useArtifactContentHydration'
import {
  applySpreadsheetActiveSheet,
  parseSpreadsheetPreviewHtml,
  spreadsheetPreviewNeedsAllSheets
} from '../domain/spreadsheet-preview'

const props = defineProps<{
  tabId: string
  artifactId: string
}>()

const { t } = useI18n()
const artifactStore = useAssistantArtifactStore()
const { loadingFromDisk } = useArtifactContentHydration(props.tabId, toRef(props, 'artifactId'))
const artifact = computed(() => artifactStore.getArtifactById(props.tabId, props.artifactId))
const content = computed(() => artifact.value?.content ?? '')
const filePath = computed(() => artifact.value?.filePath ?? null)

const parsed = computed(() => parseSpreadsheetPreviewHtml(content.value))
const sheets = computed(() => parsed.value.sheets.filter(s => s.name))
const userSheet = ref<string | null>(null)
const upgrading = ref(false)
const bodyRef = ref<HTMLElement | null>(null)

const activeName = computed(() => {
  const names = new Set(sheets.value.map(s => s.name))
  if (userSheet.value && names.has(userSheet.value)) return userSheet.value
  return parsed.value.activeSheet || sheets.value[0]?.name || ''
})

watch(
  () => parsed.value.activeSheet,
  (name, prev) => {
    if (prev && name !== prev) userSheet.value = null
  }
)

async function loadFullPreview(): Promise<boolean> {
  const path = filePath.value
  if (!path || upgrading.value) return false
  const previewApi = window.electronAPI?.localFs?.previewArtifact
  if (!previewApi) return false
  upgrading.value = true
  try {
    const res = await previewApi(path, 'spreadsheet')
    if (res.success && typeof res.data === 'string' && res.data.includes('sheet-pane')) {
      artifactStore.updateContent(props.tabId, res.data, props.artifactId)
      return true
    }
  } finally {
    upgrading.value = false
  }
  return false
}

function syncVisibleSheet() {
  const root = bodyRef.value
  if (!root || !activeName.value) return
  applySpreadsheetActiveSheet(root, activeName.value)
}

watch(
  () => [content.value, filePath.value, props.artifactId] as const,
  async () => {
    if (spreadsheetPreviewNeedsAllSheets(parsed.value) || (
      sheets.value.length > 1 && !content.value.includes('sheet-pane')
    )) {
      await loadFullPreview()
    }
    await nextTick()
    syncVisibleSheet()
  },
  { immediate: true }
)

watch(activeName, async () => {
  await nextTick()
  syncVisibleSheet()
})

async function selectSheet(name: string) {
  userSheet.value = name
  await nextTick()
  const shown = bodyRef.value ? applySpreadsheetActiveSheet(bodyRef.value, name) : false
  if (!shown) await loadFullPreview()
  await nextTick()
  syncVisibleSheet()
}
</script>

<template>
  <div class="spreadsheet-renderer">
    <div v-if="loadingFromDisk && !content.trim()" class="spreadsheet-loading">
      {{ t('canvas.htmlPreviewLoading') }}
    </div>
    <div v-else ref="bodyRef" class="spreadsheet-body" v-html="content"></div>
    <div v-if="sheets.length > 1" class="sheet-tabs">
      <button
        v-for="sheet in sheets"
        :key="sheet.name"
        type="button"
        class="sheet-tab"
        :class="{ active: sheet.name === activeName }"
        @click="selectSheet(sheet.name)"
      >
        {{ sheet.name }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.spreadsheet-renderer {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: #f3f3f3;
}

.spreadsheet-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 1;
  min-height: 200px;
  color: #666;
  font-size: 13px;
}

.spreadsheet-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 0;
}

.spreadsheet-body :deep(.sheet-tabs) {
  display: none;
}

.spreadsheet-body :deep(.sheet-pane[hidden]) {
  display: none;
}

.spreadsheet-body :deep(table) {
  border-collapse: collapse;
  font-size: 12px;
  font-family: 'Calibri', 'Segoe UI', 'Helvetica Neue', Arial, sans-serif;
  white-space: nowrap;
  background: #fff;
}

.spreadsheet-body :deep(th),
.spreadsheet-body :deep(td) {
  border: 1px solid #d4d4d4;
  padding: 3px 6px;
  text-align: left;
  min-width: 64px;
  max-width: 300px;
  overflow: hidden;
  text-overflow: ellipsis;
  height: 20px;
}

.spreadsheet-body :deep(th.row-header),
.spreadsheet-body :deep(td.row-header) {
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

.spreadsheet-body :deep(th) {
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

.spreadsheet-body :deep(th.corner) {
  z-index: 3;
  background: #f0f0f0;
}

.spreadsheet-body :deep(td) {
  color: #1a1a1a;
  background: #fff;
}

.spreadsheet-body :deep(td.num) {
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.spreadsheet-body :deep(td.merged) {
  max-width: none;
  height: auto;
  white-space: normal;
  word-break: break-word;
  vertical-align: middle;
}

.spreadsheet-body :deep(td.modified) {
  background-color: #e8f0fe;
}

.spreadsheet-body :deep(td.deleting) {
  background-color: #fee2e2;
  animation: cell-deleting-flash 1s ease-out;
}

@keyframes cell-deleting-flash {
  0% { background-color: #fca5a5; }
  100% { background-color: #fee2e2; }
}

.spreadsheet-body :deep(td.shifted) {
  animation: cell-slide-up 0.75s ease-out;
}

@keyframes cell-slide-up {
  from { transform: translateY(24px); opacity: 0; }
  to { transform: translateY(0); opacity: 1; }
}

.spreadsheet-body :deep(td.shifted-col) {
  animation: cell-slide-left 0.75s ease-out;
}

@keyframes cell-slide-left {
  from { transform: translateX(24px); opacity: 0; }
  to { transform: translateX(0); opacity: 1; }
}

.spreadsheet-body :deep(p) {
  margin: 4px 8px;
  font-family: 'Calibri', Arial, sans-serif;
}

.sheet-tabs {
  display: flex;
  flex-shrink: 0;
  gap: 0;
  padding: 0 4px;
  background: #e8e8e8;
  border-top: 1px solid #d4d4d4;
  overflow-x: auto;
}

.sheet-tab {
  appearance: none;
  padding: 5px 14px;
  font-size: 11px;
  line-height: 1.2;
  font-family: 'Calibri', 'Segoe UI', Arial, sans-serif;
  color: #555;
  background: #e0e0e0;
  border: 1px solid #d4d4d4;
  border-bottom: none;
  border-radius: 0;
  margin-top: 2px;
  cursor: pointer;
  user-select: none;
}

.sheet-tab:hover:not(.active) {
  background: #ececec;
}

.sheet-tab.active {
  color: #1a1a1a;
  background: #fff;
  font-weight: 500;
  border-bottom: 1px solid #fff;
  margin-bottom: -1px;
}
</style>
