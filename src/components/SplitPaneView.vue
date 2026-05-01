<script setup lang="ts">
import { ref, computed, onUnmounted } from 'vue'
import { useTerminalStore } from '../stores/terminal'
import type { SplitPane } from '../stores/terminal'
import Terminal from './Terminal.vue'

const props = defineProps<{
  tabId: string
  layout: SplitPane
  isActive: boolean
}>()

const emit = defineEmits<{
  sendToAi: [text: string]
}>()

const terminalStore = useTerminalStore()

// 递归渲染分屏布局
const isTerminal = computed(() => props.layout.type === 'terminal')
const isSplit = computed(() => props.layout.type === 'split')
const direction = computed(() => props.layout.direction || 'horizontal')
const children = computed(() => props.layout.children || [])

// 窗格样式
const paneStyle = computed(() => {
  if (props.layout.size) {
    return {
      flex: `${props.layout.size} 1 0%`
    }
  }
  return {
    flex: '1 1 0%'
  }
})

// 处理发送到 AI
function handleSendToAi(text: string) {
  emit('sendToAi', text)
}

// ==================== 分割线拖拽调整大小 ====================

const isResizing = ref(false)
const resizingIndex = ref(-1)

function startResize(index: number, event: MouseEvent) {
  isResizing.value = true
  resizingIndex.value = index

  document.addEventListener('mousemove', handleResize)
  document.addEventListener('mouseup', stopResize)
  document.body.style.cursor = direction.value === 'horizontal' ? 'col-resize' : 'row-resize'
  document.body.style.userSelect = 'none'

  event.preventDefault()
}

function handleResize(event: MouseEvent) {
  if (!isResizing.value || resizingIndex.value < 0) return

  // TODO: 实现实际的大小调整逻辑
  // 这里需要计算鼠标移动的距离，并更新相邻窗格的大小
  // 暂时先实现基础的拖拽交互
}

function stopResize() {
  isResizing.value = false
  resizingIndex.value = -1

  document.removeEventListener('mousemove', handleResize)
  document.removeEventListener('mouseup', stopResize)
  document.body.style.cursor = ''
  document.body.style.userSelect = ''
}

onUnmounted(() => {
  document.removeEventListener('mousemove', handleResize)
  document.removeEventListener('mouseup', stopResize)
})
</script>

<template>
  <div class="split-pane" :class="[direction, { terminal: isTerminal }]" :style="paneStyle">
    <!-- 终端窗格 -->
    <template v-if="isTerminal">
      <Terminal
        v-if="layout.ptyId"
        :tab-id="tabId"
        :pty-id="layout.ptyId"
        :type="(layout.terminalType as 'local' | 'ssh')"
        :is-active="isActive && layout.isActive"
        @send-to-ai="handleSendToAi"
      />
    </template>

    <!-- 分割容器（递归渲染子窗格）-->
    <template v-else-if="isSplit">
      <template v-for="(child, index) in children" :key="child.id">
        <!-- 递归渲染子窗格 -->
        <SplitPaneView
          :tab-id="tabId"
          :layout="child"
          :is-active="isActive"
          @send-to-ai="handleSendToAi"
        />

        <!-- 分割线（在子窗格之间）-->
        <div
          v-if="index < children.length - 1"
          class="split-handle"
          :class="[direction, { resizing: isResizing && resizingIndex === index }]"
          @mousedown="startResize(index, $event)"
        ></div>
      </template>
    </template>
  </div>
</template>

<style scoped>
.split-pane {
  display: flex;
  position: relative;
  overflow: hidden;
}

.split-pane.horizontal {
  flex-direction: row;
}

.split-pane.vertical {
  flex-direction: column;
}

.split-pane.terminal {
  min-width: 200px;
  min-height: 100px;
}

/* 分割线 */
.split-handle {
  flex-shrink: 0;
  background: var(--border-color, #404040);
  position: relative;
  z-index: 10;
}

.split-handle.horizontal {
  width: 4px;
  cursor: col-resize;
}

.split-handle.vertical {
  height: 4px;
  cursor: row-resize;
}

.split-handle:hover {
  background: var(--accent-primary, #4299e1);
}

.split-handle:active {
  background: var(--accent-primary, #4299e1);
}
</style>
