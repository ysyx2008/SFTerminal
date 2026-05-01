<script setup lang="ts">
import { ref, computed, watch, inject, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { X } from 'lucide-vue-next'
import { useTerminalStore, type SplitPane } from '../stores/terminal'
import { PANE_SLOT_REGISTRY_KEY, type PaneSlotRegistry } from './pane-slot-registry'

const { t } = useI18n()
const terminalStore = useTerminalStore()

const props = defineProps<{
  tabId: string
  layout: SplitPane
  isActive: boolean
}>()

// SplitPaneView 内部不再渲染 Terminal：
//   Terminal 实例由 TerminalTabView 顶层按 ptyId 维护，通过 Teleport 投影到这里
//   渲染的占位 div。这样布局如何变化都不会销毁 Terminal 组件实例 / xterm 实例，
//   从根本上保护终端内容。
//
//   占位 div 的 element 引用通过 paneSlotRegistry 注册到 TerminalTabView，
//   后者用 element 引用作为 Teleport 的 :to——而非 selector 字符串——
//   element 变化时 Vue 自动 patch DOM 到新位置，避免孤儿化。
const paneSlotRegistry = inject<PaneSlotRegistry>(PANE_SLOT_REGISTRY_KEY)
const slotElRef = ref<HTMLElement | null>(null)

watch([slotElRef, () => props.layout.ptyId], ([el, ptyId]) => {
  if (el && ptyId && paneSlotRegistry) {
    paneSlotRegistry.register(ptyId, el)
  }
}, { immediate: true, flush: 'post' })

// ==================== 布局判断 ====================

const isTerminal = computed(() => props.layout.type === 'terminal')
const isSplit = computed(() => props.layout.type === 'split')
const direction = computed<'horizontal' | 'vertical'>(() => props.layout.direction || 'horizontal')
const children = computed(() => props.layout.children || [])

const paneStyle = computed(() => {
  if (props.layout.size) {
    return { flex: `${props.layout.size} 1 0%` }
  }
  return { flex: '1 1 0%' }
})

// 终端窗格被激活的视觉高亮
const isPaneActive = computed(() => isTerminal.value && (props.layout.isActive ?? false))

// ==================== 容器引用（用于拖拽时计算容器尺寸）====================

const containerRef = ref<HTMLElement | null>(null)

// ==================== 点击激活窗格 ====================

function handlePaneClick() {
  if (!isTerminal.value) return
  if (props.layout.isActive) return
  console.log('[SplitPaneView] handlePaneClick → activate pane', { paneId: props.layout.id, ptyId: props.layout.ptyId })
  terminalStore.setActivePaneInTab(props.tabId, props.layout.id)
}

// ==================== 关闭窗格 ====================

async function handleClosePane(e: Event) {
  e.stopPropagation()
  await terminalStore.closePane(props.tabId, props.layout.id)
}

// 右键菜单由 Terminal 组件统一接管（含分屏选项与快捷键标注）；
// SplitPaneView 不再弹自己的菜单，避免分屏后两套菜单叠加。

// ==================== 分割线拖拽 ====================

const isResizing = ref(false)
const resizingIndex = ref(-1)
let resizeStartCoord = 0
let resizeStartSizes: [number, number] = [50, 50]
let resizeContainerSize = 0

function startResize(index: number, e: MouseEvent) {
  if (!containerRef.value) return
  if (!props.layout.children || index < 0 || index >= props.layout.children.length - 1) return

  const left = props.layout.children[index]
  const right = props.layout.children[index + 1]
  resizeStartSizes = [left.size ?? 50, right.size ?? 50]

  const rect = containerRef.value.getBoundingClientRect()
  if (direction.value === 'horizontal') {
    resizeStartCoord = e.clientX
    resizeContainerSize = rect.width
  } else {
    resizeStartCoord = e.clientY
    resizeContainerSize = rect.height
  }
  if (resizeContainerSize <= 0) return

  isResizing.value = true
  resizingIndex.value = index

  document.addEventListener('mousemove', handleResize)
  document.addEventListener('mouseup', stopResize)
  document.body.style.cursor = direction.value === 'horizontal' ? 'col-resize' : 'row-resize'
  document.body.style.userSelect = 'none'
  e.preventDefault()
}

function handleResize(e: MouseEvent) {
  if (!isResizing.value || resizingIndex.value < 0 || !props.layout.children) return
  if (resizeContainerSize <= 0) return

  const cur = direction.value === 'horizontal' ? e.clientX : e.clientY
  const delta = cur - resizeStartCoord

  // size 是 flex-grow 比例，相邻两窗格之和近似当前两窗格占据的总份额
  const total = resizeStartSizes[0] + resizeStartSizes[1]
  const deltaPct = (delta / resizeContainerSize) * total

  let leftSize = resizeStartSizes[0] + deltaPct
  let rightSize = resizeStartSizes[1] - deltaPct

  // 各自最小 10，最大 90，溢出归还到对侧
  const min = 10
  if (leftSize < min) {
    rightSize -= (min - leftSize)
    leftSize = min
  }
  if (rightSize < min) {
    leftSize -= (min - rightSize)
    rightSize = min
  }

  const left = props.layout.children[resizingIndex.value]
  const right = props.layout.children[resizingIndex.value + 1]
  terminalStore.updatePaneSize(props.tabId, left.id, leftSize)
  terminalStore.updatePaneSize(props.tabId, right.id, rightSize)
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
  <div
    ref="containerRef"
    class="split-pane"
    :class="[direction, { terminal: isTerminal, 'pane-active': isPaneActive }]"
    :style="paneStyle"
    @click="handlePaneClick"
  >
    <!-- 终端窗格：仅渲染占位 div，Terminal 由 TerminalTabView 通过 Teleport 投入 -->
    <template v-if="isTerminal">
      <button
        v-if="layout.ptyId"
        class="pane-close-btn"
        :title="t('common.close')"
        @click="handleClosePane"
      >
        <X :size="14" />
      </button>
      <div
        v-if="layout.ptyId"
        ref="slotElRef"
        class="pane-slot"
      ></div>
    </template>

    <!-- 分割容器（递归渲染子窗格）-->
    <template v-else-if="isSplit">
      <template v-for="(child, index) in children" :key="child.id">
        <SplitPaneView
          :tab-id="tabId"
          :layout="child"
          :is-active="isActive"
        />
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

/* 占位 div：撑满 .split-pane.terminal，作为 Teleport 的目标
   Terminal 组件被 TerminalTabView 顶层 Teleport 投入这里 */
.pane-slot {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* 激活窗格视觉高亮 */
.split-pane.terminal.pane-active::before {
  content: '';
  position: absolute;
  inset: 0;
  border: 2px solid var(--accent-primary, #4299e1);
  pointer-events: none;
  z-index: 5;
  border-radius: 2px;
  box-sizing: border-box;
}

/* 关闭按钮（默认隐藏，hover 时显示）*/
.pane-close-btn {
  position: absolute;
  top: 4px;
  right: 4px;
  width: 22px;
  height: 22px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.4);
  color: rgba(255, 255, 255, 0.85);
  border: none;
  border-radius: 4px;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.15s ease, background 0.15s ease;
  z-index: 6;
}

.split-pane.terminal:hover .pane-close-btn {
  opacity: 1;
}

.pane-close-btn:hover {
  background: var(--accent-error, #e53e3e);
  color: #fff;
}

/* 分割线 */
.split-handle {
  flex-shrink: 0;
  background: var(--border-color, #404040);
  position: relative;
  z-index: 10;
  transition: background 0.15s ease;
}

.split-handle.horizontal {
  width: 4px;
  cursor: col-resize;
}

.split-handle.vertical {
  height: 4px;
  cursor: row-resize;
}

.split-handle:hover,
.split-handle.resizing {
  background: var(--accent-primary, #4299e1);
}

</style>
