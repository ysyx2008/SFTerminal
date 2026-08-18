<script setup lang="ts">
import { ref, computed, watch, nextTick, onUnmounted, defineAsyncComponent } from 'vue'
import { useTerminalStore } from '../stores/terminal'
import { useConfigStore } from '../stores/config'
import type { TerminalTab } from '../stores/terminal'
import TerminalPaneHost from './TerminalPaneHost.vue'

/** 终端工作台侧栏对话：经 SDK 薄壳入口，与 assistant/companion 一致 */
const AiPanel = defineAsyncComponent(() =>
  import('@sailfish/workbench-sdk/ai-panel').then((m) => m.AiPanel)
)

const terminalStore = useTerminalStore()
const configStore = useConfigStore()
const isSteamBuild = typeof __STEAM_BUILD__ !== 'undefined' && __STEAM_BUILD__

// 助手面板位置：跟随终端设置，默认右侧
const aiPanelPosition = computed<'left' | 'right'>(
  () => configStore.terminalSettings.aiPanelPosition ?? 'right'
)

const props = defineProps<{
  tab: TerminalTab
  isActive: boolean
}>()

// ==================== AI 面板状态（每个 tab 独立） ====================

const showAiPanel = ref(isSteamBuild ? false : true)
// 延迟挂载：仅当 tab 激活时才挂载 AiPanel，挂载后不再销毁
const aiPanelMounted = ref(false)
const aiPanelWidth = ref(420)
const isResizing = ref(false)
const MIN_AI_WIDTH = 300
const getMaxAiWidth = () => window.innerWidth - 200

// AiPanel 实例引用
const aiPanelRef = ref<InstanceType<typeof AiPanel> | null>(null)
const containerRef = ref<HTMLElement | null>(null)

watch(() => props.isActive, (active) => {
  if (active && !aiPanelMounted.value) {
    aiPanelMounted.value = true
  }
}, { immediate: true })

// ==================== Terminal → AiPanel 通信 ====================

function handleSendToAi(text: string) {
  showAiPanel.value = true
  const addQuote = () => aiPanelRef.value?.addQuotedTerminalSelection(text, props.tab.title)
  nextTick(() => {
    if (!addQuote()) nextTick(addQuote)
  })
}

// ==================== AI 面板宽度拖拽 ====================

const startResize = (_e: MouseEvent) => {
  isResizing.value = true
  document.addEventListener('mousemove', handleResize)
  document.addEventListener('mouseup', stopResize)
  document.body.style.cursor = 'col-resize'
  document.body.style.userSelect = 'none'
}

const handleResize = (e: MouseEvent) => {
  if (!isResizing.value) return
  const rect = containerRef.value?.getBoundingClientRect()
  if (!rect) return
  // 助手面板在左：鼠标位置距容器左边的距离即面板宽度
  // 助手面板在右：鼠标位置到容器右边的距离即面板宽度
  const newWidth = aiPanelPosition.value === 'left'
    ? e.clientX - rect.left
    : rect.right - e.clientX
  const maxWidth = getMaxAiWidth()
  if (newWidth >= MIN_AI_WIDTH && newWidth <= maxWidth) {
    aiPanelWidth.value = newWidth
  }
}

const stopResize = () => {
  isResizing.value = false
  document.removeEventListener('mousemove', handleResize)
  document.removeEventListener('mouseup', stopResize)
  document.body.style.cursor = ''
  document.body.style.userSelect = ''
}

onUnmounted(() => {
  document.removeEventListener('mousemove', handleResize)
  document.removeEventListener('mouseup', stopResize)
})

// ==================== 对外暴露的方法 ====================

function toggleAiPanel() {
  showAiPanel.value = !showAiPanel.value
  if (!showAiPanel.value) {
    terminalStore.focusTerminal()
  }
}

function ensureAiPanel() {
  showAiPanel.value = true
}

defineExpose({ toggleAiPanel, ensureAiPanel, showAiPanel })
</script>

<template>
  <div ref="containerRef" class="terminal-tab" :class="`ai-panel-${aiPanelPosition}`">
    <template v-if="!isSteamBuild && aiPanelMounted">
      <div
        class="tab-ai-sidebar"
        :class="{ 'is-collapsed': !showAiPanel, 'is-resizing': isResizing }"
        :style="{ '--ai-panel-width': aiPanelWidth + 'px', width: showAiPanel ? aiPanelWidth + 'px' : '0px' }"
        :inert="showAiPanel ? undefined : true"
      >
        <AiPanel
          ref="aiPanelRef"
          :tab-id="tab.id"
          :visible="showAiPanel"
          :tab-active="isActive"
        />
        <!-- 拖拽手柄：绝对定位覆盖在 sidebar 朝 terminal 一侧的边缘，不占据 flex 流空间，
             这样 sidebar 与 terminal 视觉上紧贴，hover 时才显示拖拽提示 -->
        <div
          class="resize-handle"
          @mousedown="startResize"
          :class="{ resizing: isResizing }"
        ></div>
      </div>
    </template>
    <div class="terminal-main">
      <TerminalPaneHost :tab="tab" :is-active="isActive" show-close-on-error @send-to-ai="handleSendToAi" />
    </div>
  </div>
</template>

<style scoped>
.terminal-tab {
  display: flex;
  flex-direction: row;
  width: 100%;
  height: 100%;
}

/* 助手面板在右：把行方向反过来，让 sidebar 出现在右侧。
   由于 DOM 顺序固定（sidebar → resize-handle → main），row-reverse 同时
   把 resize-handle 和 main 一起翻到 sidebar 左边，正好达到"main + handle + sidebar"的视觉布局。 */
.terminal-tab.ai-panel-right {
  flex-direction: row-reverse;
}

.terminal-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  position: relative;
}

/* 终端 Tab 内的 AI 侧栏（位置由 .ai-panel-left / .ai-panel-right 控制）
   sidebar 与 handle 接壤一侧画一条 1px border-color 分隔线，配合内侧 ::before
   亮带形成「sidebar 渐变 → 1px 亮带 → 1px 暗线 → handle」的层次。 */
.tab-ai-sidebar {
  min-width: 280px;
  background: linear-gradient(180deg, var(--bg-secondary) 0%, var(--bg-tertiary) 100%);
  border-right: 1px solid var(--border-color);
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  position: relative;
  /* 收起是把面板推出视野，不是让它凭空消失：宽度归零、内容被裁掉。
     收起后元素仍留在 DOM 里（display:none 没法过渡），靠 inert 挡住键盘焦点。 */
  overflow: hidden;
  transition: width 0.24s cubic-bezier(0.16, 1, 0.3, 1);
}

/* 内容按展开宽度定住，收缩时是被裁走而不是挤成一团；拖宽手柄贴着边缘，不参与定宽 */
.tab-ai-sidebar > :not(.resize-handle) {
  width: var(--ai-panel-width);
}

/* 折叠到零：最小宽度、内边距、边框和那条装饰线都得让开，否则会留下一道缝 */
.tab-ai-sidebar.is-collapsed {
  min-width: 0;
  padding: 0;
  border-width: 0;
}

.tab-ai-sidebar.is-collapsed::before {
  display: none;
}

/* 拖宽时宽度每帧都在变，过渡会让它跟不上手 */
.tab-ai-sidebar.is-resizing {
  transition: none;
}

/* 在右侧时换为左边框，左右布局完全镜像 */
.terminal-tab.ai-panel-right .tab-ai-sidebar {
  border-right: none;
  border-left: 1px solid var(--border-color);
}

/* 左侧布局：sidebar 右缘是 AiPanel 滚动条与 resize-handle 的重合区。
   留 3px padding 让 AiPanel 内容（含滚动条）向内偏移，避开 handle 的 hit area。
   右侧布局滚动条在 viewport 最右、handle 在 sidebar 最左，天然不冲突，无需 padding。 */
.terminal-tab.ai-panel-left .tab-ai-sidebar {
  padding-right: 3px;
}

.tab-ai-sidebar::before {
  content: '';
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  width: 1px;
  background: linear-gradient(180deg, transparent, rgba(var(--accent-secondary-rgb, 116, 199, 236), 0.15), transparent);
  pointer-events: none;
}

/* 在右侧时把装饰条挪到左边缘 */
.terminal-tab.ai-panel-right .tab-ai-sidebar::before {
  right: auto;
  left: 0;
}

/* 终端 loading / error 状态 */
.terminal-loading,
.terminal-error {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 16px;
  color: var(--text-muted);
}

.loading-spinner {
  width: 40px;
  height: 40px;
  border: 3px solid var(--bg-surface);
  border-top-color: var(--accent-primary);
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.terminal-error svg {
  color: var(--accent-error);
  opacity: 0.8;
}

.terminal-error .error-title {
  font-size: 16px;
  font-weight: 500;
  color: var(--text-primary);
}

.terminal-error .error-detail {
  font-size: 13px;
  color: var(--text-secondary);
  max-width: 400px;
  text-align: center;
  line-height: 1.5;
  padding: 8px 16px;
  background: var(--bg-surface);
  border-radius: 6px;
  border: 1px solid var(--border-primary);
}

/* 拖拽手柄：绝对定位覆盖在 sidebar 朝 terminal 一侧的最外 5px，
   平时透明、不占视觉空间，hover/resizing 时显示渐变背景与中间小竖条作为可拖拽提示。 */
.resize-handle {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 5px;
  cursor: col-resize;
  background: transparent;
  transition: background 0.25s ease;
  z-index: 5;
}

/* 左侧布局：handle 贴在 sidebar 的最右 5px */
.terminal-tab.ai-panel-left .resize-handle {
  right: 0;
}

/* 右侧布局：handle 贴在 sidebar 的最左 5px */
.terminal-tab.ai-panel-right .resize-handle {
  left: 0;
}

.resize-handle::after {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 3px;
  height: 40px;
  background: var(--border-color);
  border-radius: 2px;
  opacity: 0;
  transition: opacity 0.2s ease;
}

.resize-handle:hover::after,
.resize-handle.resizing::after {
  opacity: 1;
}

.resize-handle:hover,
.resize-handle.resizing {
  background: linear-gradient(180deg, transparent, rgba(var(--accent-rgb, 137, 180, 250), 0.3), transparent);
}

.resize-handle.resizing::after {
  background: var(--accent-primary);
  box-shadow: 0 0 10px var(--accent-primary);
}
</style>
