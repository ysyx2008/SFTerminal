<script setup lang="ts">
import { ref, shallowRef, triggerRef, computed, watch, nextTick, onUnmounted, provide, defineAsyncComponent } from 'vue'
import { useI18n } from 'vue-i18n'
import { AlertCircle } from 'lucide-vue-next'
import { useTerminalStore } from '../stores/terminal'
import { useConfigStore } from '../stores/config'
import type { TerminalTab, SplitPane } from '../stores/terminal'
import { getAllTerminalPanes } from '../stores/split-pane-tree'
import Terminal from './Terminal.vue'
import SplitPaneView from './SplitPaneView.vue'
import { PANE_SLOT_REGISTRY_KEY, type PaneSlotRegistry } from './pane-slot-registry'

const AiPanel = defineAsyncComponent(() => import('./AiPanel.vue'))

const { t } = useI18n()
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

// ==================== Terminal 实例池（按 ptyId 维护，通过 Teleport 投影） ====================
//
// 关键设计：
//   Terminal 组件实例不再由 SplitPaneView 渲染——SplitPaneView 仅渲染占位 div 并通过
//   provide/inject 向这里上报占位 div 的 element 引用（registerPaneSlot）。
//   Terminal 实例在 v-for 按 ptyId 维护，Teleport 用 element 引用作 :to。
//   布局变化时 SplitPaneView 重渲染→新占位 div mount→register→Teleport 重新 patch
//   target→Terminal DOM 自动搬到新 element。Terminal 组件实例和 xterm 实例永不销毁。
//
//   关键：Teleport :to 必须用 element 引用而非 selector 字符串。selector 不变时
//   Vue 不会重新 resolve，会让 Terminal DOM 残留在已 detach 的旧 element 里。
const terminalPanes = computed<SplitPane[]>(() => {
  if (!props.tab.splitLayout) return []
  return getAllTerminalPanes(props.tab.splitLayout).filter(p => Boolean(p.ptyId))
})

// shallowRef：保存原始 HTMLElement 引用，不被 Vue 深度响应化（HTMLElement 不能 reactive）
const paneSlotElements = shallowRef<Record<string, HTMLElement>>({})

// 注册占位 div：覆盖式更新，不实现 unregister。
// 原因：分屏后 SplitPaneView 重渲染，旧占位 div 销毁 + 新占位 div 创建是同一渲染周期，
// 如果旧 div 立即 unregister 会让 v-if 短暂为 false，销毁 Terminal 组件实例。
// 改为：保留最后注册的引用，新 register 自然覆盖旧引用；ptyId 真正消失时由下面的
// watch 统一清理。
function registerPaneSlot(ptyId: string, el: HTMLElement) {
  if (paneSlotElements.value[ptyId] === el) return
  paneSlotElements.value = { ...paneSlotElements.value, [ptyId]: el }
  triggerRef(paneSlotElements)
}

provide<PaneSlotRegistry>(PANE_SLOT_REGISTRY_KEY, {
  register: registerPaneSlot,
  // unregister 兜底：仅当 ptyId 不再属于当前 tab 时才会真正释放，由 watch terminalPanes 处理
  unregister: () => { /* no-op */ }
})

// 清理已不存在的 ptyId 对应的 element 引用（避免内存泄漏）
watch(terminalPanes, (panes) => {
  const validPtyIds = new Set(panes.map(p => p.ptyId).filter(Boolean) as string[])
  const next: Record<string, HTMLElement> = {}
  let changed = false
  for (const [ptyId, el] of Object.entries(paneSlotElements.value)) {
    if (validPtyIds.has(ptyId)) {
      next[ptyId] = el
    } else {
      changed = true
    }
  }
  if (changed) {
    paneSlotElements.value = next
    triggerRef(paneSlotElements)
  }
})

// 分屏入口由各 Terminal 的右键菜单 + 全局快捷键 + 窗格右上角关闭按钮提供，
// 这里不再放浮动工具按钮，避免遮挡终端内容、与窗格关闭按钮重叠。
</script>

<template>
  <div ref="containerRef" class="terminal-tab" :class="`ai-panel-${aiPanelPosition}`">
    <template v-if="!isSteamBuild && aiPanelMounted">
      <div
        v-show="showAiPanel"
        class="tab-ai-sidebar"
        :style="{ width: aiPanelWidth + 'px' }"
      >
        <AiPanel
          ref="aiPanelRef"
          :tab-id="tab.id"
          :visible="showAiPanel"
          :tab-active="isActive"
          @close="showAiPanel = false"
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
      <!-- 终端布局：SplitPaneView 渲染嵌套结构与占位 div（不渲染 Terminal） -->
      <SplitPaneView
        v-if="tab.splitLayout"
        :tab-id="tab.id"
        :layout="tab.splitLayout"
        :is-active="isActive"
      />

      <!-- 加载中 -->
      <div v-else-if="tab.isLoading" class="terminal-loading">
        <div class="loading-spinner"></div>
        <span>{{ tab.loadingMessage || t('terminal.connecting') }}</span>
      </div>

      <!-- 连接错误 -->
      <div v-else class="terminal-error">
        <AlertCircle :size="48" />
        <span class="error-title">{{ t('terminal.connectionFailed') }}</span>
        <span v-if="tab.connectionError" class="error-detail">{{ tab.connectionError }}</span>
        <button class="btn btn-sm" @click="terminalStore.closeTab(tab.id)">{{ t('common.close') }}</button>
      </div>

      <!-- Terminal 实例池：v-for 按 ptyId 维护，Teleport target 用 element 引用
           占位 div element 由 SplitPaneView 通过 provide/inject 上报到 paneSlotElements -->
      <template v-for="pane in terminalPanes" :key="pane.ptyId">
        <Teleport
          v-if="pane.ptyId && paneSlotElements[pane.ptyId]"
          :to="paneSlotElements[pane.ptyId]"
        >
          <Terminal
            :tab-id="tab.id"
            :pty-id="pane.ptyId"
            :type="(pane.terminalType as 'local' | 'ssh')"
            :is-active="isActive && (pane.isActive ?? false)"
            @send-to-ai="handleSendToAi"
          />
        </Teleport>
      </template>
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
