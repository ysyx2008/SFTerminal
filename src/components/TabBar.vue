<script setup lang="ts">
import { ref } from 'vue'
import { useTerminalStore } from '../stores/terminal'

const terminalStore = useTerminalStore()

// 拖拽状态
const dragIndex = ref<number | null>(null)
const dragOverIndex = ref<number | null>(null)

const handleNewTab = () => {
  terminalStore.createTab('local')
}

const handleCloseTab = (tabId: string, event: MouseEvent) => {
  event.stopPropagation()
  terminalStore.closeTab(tabId)
}

// 拖拽开始
const handleDragStart = (index: number, event: DragEvent) => {
  dragIndex.value = index
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', index.toString())
  }
}

// 拖拽经过
const handleDragOver = (index: number, event: DragEvent) => {
  event.preventDefault()
  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = 'move'
  }
  dragOverIndex.value = index
}

// 拖拽离开
const handleDragLeave = () => {
  dragOverIndex.value = null
}

// 放置
const handleDrop = (toIndex: number, event: DragEvent) => {
  event.preventDefault()
  if (dragIndex.value !== null && dragIndex.value !== toIndex) {
    terminalStore.reorderTabs(dragIndex.value, toIndex)
  }
  dragIndex.value = null
  dragOverIndex.value = null
}

// 拖拽结束
const handleDragEnd = () => {
  dragIndex.value = null
  dragOverIndex.value = null
}
</script>

<template>
  <div class="tab-bar">
    <div class="tabs-container">
      <div
        v-for="(tab, index) in terminalStore.tabs"
        :key="tab.id"
        class="tab"
        :class="{ 
          active: tab.id === terminalStore.activeTabId,
          dragging: dragIndex === index,
          'drag-over': dragOverIndex === index && dragIndex !== index
        }"
        draggable="true"
        @click="terminalStore.setActiveTab(tab.id)"
        @dragstart="handleDragStart(index, $event)"
        @dragover="handleDragOver(index, $event)"
        @dragleave="handleDragLeave"
        @drop="handleDrop(index, $event)"
        @dragend="handleDragEnd"
      >
        <span class="tab-icon">
          <svg v-if="tab.type === 'local'" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="4 17 10 11 4 5"/>
            <line x1="12" y1="19" x2="20" y2="19"/>
          </svg>
          <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/>
            <line x1="8" y1="21" x2="16" y2="21"/>
            <line x1="12" y1="17" x2="12" y2="21"/>
          </svg>
        </span>
        <span class="tab-title">{{ tab.title }}</span>
        <span v-if="tab.isLoading" class="tab-loading">
          <svg class="spinner" width="12" height="12" viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3" fill="none" stroke-dasharray="60" stroke-linecap="round"/>
          </svg>
        </span>
        <button
          v-else
          class="tab-close"
          @click="handleCloseTab(tab.id, $event)"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"/>
            <line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>
    </div>
    <button class="btn-new-tab" @click="handleNewTab" data-tooltip="新建标签页">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <line x1="12" y1="5" x2="12" y2="19"/>
        <line x1="5" y1="12" x2="19" y2="12"/>
      </svg>
    </button>
  </div>
</template>

<style scoped>
.tab-bar {
  display: flex;
  align-items: center;
  gap: 4px;
  max-width: 100%;
  overflow: hidden;
}

.tabs-container {
  display: flex;
  gap: 2px;
  overflow-x: auto;
  scrollbar-width: none;
}

.tabs-container::-webkit-scrollbar {
  display: none;
}

.tab {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  min-width: 120px;
  max-width: 180px;
  background: var(--bg-tertiary);
  border-radius: 6px 6px 0 0;
  cursor: grab;
  transition: all 0.2s ease;
  user-select: none;
}

.tab:hover {
  background: var(--bg-surface);
}

.tab.active {
  background: var(--bg-primary);
}

.tab.dragging {
  opacity: 0.5;
  cursor: grabbing;
}

.tab.drag-over {
  border-left: 2px solid var(--accent-primary);
  margin-left: -2px;
}

.tab-icon {
  display: flex;
  align-items: center;
  color: var(--text-muted);
}

.tab.active .tab-icon {
  color: var(--accent-primary);
}

.tab-title {
  flex: 1;
  font-size: 12px;
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tab.active .tab-title {
  color: var(--text-primary);
}

.tab-close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  padding: 0;
  background: transparent;
  border: none;
  border-radius: 4px;
  color: var(--text-muted);
  cursor: pointer;
  opacity: 0;
  transition: all 0.2s ease;
}

.tab:hover .tab-close {
  opacity: 1;
}

.tab-close:hover {
  background: var(--bg-hover);
  color: var(--accent-error);
}

.tab-loading {
  display: flex;
  align-items: center;
  color: var(--accent-primary);
}

.spinner {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}

.btn-new-tab {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  background: transparent;
  border: none;
  border-radius: 6px;
  color: var(--text-muted);
  cursor: pointer;
  transition: all 0.2s ease;
}

.btn-new-tab:hover {
  background: var(--bg-surface);
  color: var(--text-primary);
}
</style>

