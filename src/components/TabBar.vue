<script setup lang="ts">
import { ref, watch, onMounted, nextTick, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronLeft, ChevronRight, ChevronDown, Terminal, Monitor, Loader2, X, Plus, Layers, Radio, Bot } from 'lucide-vue-next'
import { useTerminalStore } from '../stores/terminal'
import BatchCommandPanel from './BatchCommandPanel.vue'

const { t } = useI18n()
const terminalStore = useTerminalStore()
const isSteamBuild = typeof __STEAM_BUILD__ !== 'undefined' && __STEAM_BUILD__

const emit = defineEmits<{
  'open-ssh': []
}>()

// 拖拽状态
const dragIndex = ref<number | null>(null)
const dragOverIndex = ref<number | null>(null)

// 新建终端下拉菜单
const showNewMenu = ref(false)
const menuPosition = ref({ top: '0px', left: '0px' })

// 滚动相关
const tabsContainerRef = ref<HTMLElement | null>(null)
const canScrollLeft = ref(false)
const canScrollRight = ref(false)

// Shell 选项（动态检测系统可用的 shell）
const shellOptions = ref<Array<{ label: string; value: string; icon: string }>>([])

// 加载可用的 shell 列表
const loadAvailableShells = async () => {
  try {
    const shells = await window.electronAPI.pty.getAvailableShells()
    shellOptions.value = shells
  } catch (e) {
    console.error('Failed to load available shells:', e)
    // 降级：使用默认列表
    const isWindows = navigator.platform.toLowerCase().includes('win')
    if (isWindows) {
      shellOptions.value = [
        { label: 'PowerShell', value: 'powershell.exe', icon: '⚡' },
        { label: 'CMD', value: 'cmd.exe', icon: '📟' }
      ]
    } else {
      // macOS 默认 zsh，排在最前；其他类 Unix 环境两者均列出
      const isMac = navigator.platform.toLowerCase().includes('mac')
      shellOptions.value = isMac
        ? [
            { label: 'Zsh', value: '/bin/zsh', icon: '🔮' },
            { label: 'Bash', value: '/bin/bash', icon: '🐚' }
          ]
        : [
            { label: 'Bash', value: '/bin/bash', icon: '🐚' },
            { label: 'Zsh', value: '/bin/zsh', icon: '🔮' }
          ]
    }
  }
}

// 检查滚动状态
const checkScrollState = () => {
  const container = tabsContainerRef.value
  if (!container) return
  
  canScrollLeft.value = container.scrollLeft > 0
  canScrollRight.value = container.scrollLeft < container.scrollWidth - container.clientWidth - 1
}

// 滚动到指定方向
const scroll = (direction: 'left' | 'right') => {
  const container = tabsContainerRef.value
  if (!container) return
  
  const scrollAmount = 200
  container.scrollBy({
    left: direction === 'left' ? -scrollAmount : scrollAmount,
    behavior: 'smooth'
  })
}

// 滚动到当前激活的 tab
const scrollToActiveTab = () => {
  nextTick(() => {
    const container = tabsContainerRef.value
    if (!container) return
    
    const activeTab = container.querySelector('.tab.active') as HTMLElement
    if (!activeTab) return
    
    const containerRect = container.getBoundingClientRect()
    const tabRect = activeTab.getBoundingClientRect()
    
    // 如果 tab 不在可见范围内，滚动到可见
    if (tabRect.left < containerRect.left) {
      container.scrollBy({
        left: tabRect.left - containerRect.left - 10,
        behavior: 'smooth'
      })
    } else if (tabRect.right > containerRect.right) {
      container.scrollBy({
        left: tabRect.right - containerRect.right + 10,
        behavior: 'smooth'
      })
    }
  })
}

// 监听 tab 变化和激活状态变化
watch(() => terminalStore.tabs.length, () => {
  nextTick(checkScrollState)
})

watch(() => terminalStore.activeTabId, () => {
  scrollToActiveTab()
})

onMounted(() => {
  checkScrollState()
  // 监听滚动事件
  tabsContainerRef.value?.addEventListener('scroll', checkScrollState)
  // 监听窗口大小变化
  window.addEventListener('resize', checkScrollState)
  // 加载可用的 shell 列表
  loadAvailableShells()
})

const handleNewTab = (shell?: string) => {
  terminalStore.createTab('local', undefined, shell)
  showNewMenu.value = false
}

const handleNewAssistant = () => {
  terminalStore.createAssistantTab()
  showNewMenu.value = false
}

const handleOpenSsh = () => {
  emit('open-ssh')
  showNewMenu.value = false
}

const toggleNewMenu = (event: MouseEvent) => {
  if (!showNewMenu.value) {
    // 计算菜单位置
    const button = event.currentTarget as HTMLElement
    const rect = button.getBoundingClientRect()
    menuPosition.value = {
      top: `${rect.bottom + 4}px`,
      left: `${rect.right - 150}px`  // 150 是菜单宽度
    }
  }
  showNewMenu.value = !showNewMenu.value
}

const hideNewMenu = () => {
  showNewMenu.value = false
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

// 批量命令面板引用
const batchPanelRef = ref<InstanceType<typeof BatchCommandPanel> | null>(null)

// 是否有多个活跃终端
const hasMultipleTerminals = computed(() => {
  return terminalStore.tabs.filter(tab => tab.isConnected && tab.ptyId).length > 1
})

// 打开批量命令面板
const openBatchPanel = () => {
  batchPanelRef.value?.open()
}

/** 非激活 tab 上的标签栏提示（待确认 / 后台任务已结束） */
const tabAttentionTooltip = (tabId: string): string | undefined => {
  if (tabId === terminalStore.activeTabId) return undefined
  const pending = terminalStore.hasPendingConfirm(tabId)
  const unseen = terminalStore.hasAgentCompletedUnseen(tabId)
  if (!pending && !unseen) return undefined
  if (pending && unseen) {
    return `${t('tabs.needsAttentionConfirm')} · ${t('tabs.needsAttentionTaskFinished')}`
  }
  if (pending) return t('tabs.needsAttentionConfirm')
  return t('tabs.needsAttentionTaskFinished')
}
</script>

<template>
  <div class="tab-bar">
    <!-- 左滚动按钮 -->
    <button 
      v-show="canScrollLeft" 
      class="scroll-btn scroll-left" 
      @click="scroll('left')"
      :title="t('tabs.scrollLeft')"
    >
      <ChevronLeft :size="12" />
    </button>
    
    <div ref="tabsContainerRef" class="tabs-container" @scroll="checkScrollState">
      <div
        v-for="(tab, index) in terminalStore.tabs"
        :key="tab.id"
        class="tab"
        :title="tabAttentionTooltip(tab.id)"
        :class="{ 
          active: tab.id === terminalStore.activeTabId,
          dragging: dragIndex === index,
          'drag-over': dragOverIndex === index && dragIndex !== index,
          'needs-attention': tab.id !== terminalStore.activeTabId && terminalStore.hasTabAgentAttention(tab.id)
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
          <Radio v-if="tab.isRemote" :size="14" class="remote-icon" />
          <Bot v-else-if="tab.type === 'assistant'" :size="14" />
          <Terminal v-else-if="tab.type === 'local'" :size="14" />
          <Monitor v-else :size="14" />
        </span>
        <span class="tab-title">{{ tab.title }}</span>
        <span v-if="tab.isLoading" class="tab-loading">
          <Loader2 class="spinner" :size="12" />
        </span>
        <button
          v-else
          class="tab-close"
          @click="handleCloseTab(tab.id, $event)"
          :title="t('tabs.closeTab')"
        >
          <X :size="12" />
        </button>
      </div>
    </div>
    
    <!-- 右滚动按钮 -->
    <button 
      v-show="canScrollRight" 
      class="scroll-btn scroll-right" 
      @click="scroll('right')"
      :title="t('tabs.scrollRight')"
    >
      <ChevronRight :size="12" />
    </button>
    
    <!-- 批量操作按钮 -->
    <button 
      v-if="hasMultipleTerminals"
      class="btn-batch" 
      @click="openBatchPanel" 
      :title="t('batch.title')"
    >
      <Layers :size="14" />
    </button>
    
    <!-- 新建终端按钮（带下拉菜单） -->
    <div class="new-tab-wrapper">
      <button
        class="btn-new-tab"
        @click="isSteamBuild ? handleNewTab() : handleNewAssistant()"
        :title="isSteamBuild ? t('tabs.newTab') : t('tabs.assistant', 'AI 助手')"
      >
        <Plus :size="14" />
      </button>
      <button class="btn-new-tab-dropdown" @click="toggleNewMenu" :title="t('tabs.selectShell')">
        <ChevronDown :size="10" />
      </button>
      
    </div>
    
    <!-- Shell 选择菜单（使用 Teleport 避免 overflow 裁剪） -->
    <Teleport to="body">
      <div v-if="showNewMenu" class="shell-menu-overlay" @click="hideNewMenu"></div>
      <div v-if="showNewMenu" class="shell-menu" :style="menuPosition">
        <template v-if="!isSteamBuild">
          <div 
            class="shell-menu-item"
            @click="handleNewAssistant"
          >
            <span class="shell-icon">🤖</span>
            <span>{{ t('tabs.assistant', 'AI 助手') }}</span>
          </div>
          <div class="shell-menu-divider"></div>
        </template>
        <div 
          v-for="option in shellOptions" 
          :key="option.value"
          class="shell-menu-item"
          @click="handleNewTab(option.value)"
        >
          <span class="shell-icon">{{ option.icon }}</span>
          <span>{{ option.label }}</span>
        </div>
        <div class="shell-menu-divider"></div>
        <div class="shell-menu-item" @click="handleOpenSsh">
          <Monitor :size="14" class="shell-icon-lucide" />
          <span>{{ t('tabs.sshConnect') }}</span>
        </div>
      </div>
    </Teleport>
    
    <!-- 批量命令面板 -->
    <BatchCommandPanel ref="batchPanelRef" />
  </div>
</template>

<style scoped>
.tab-bar {
  display: flex;
  align-items: center;
  gap: 2px;
  max-width: 100%;
  overflow: hidden;
  /* 空白区域继承父级 drag，使 TabBar 两侧/间隙可拖动窗口与双击最大化 */
}

.scroll-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 28px;
  padding: 0;
  background: var(--bg-tertiary);
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  transition: all 0.2s ease;
  flex-shrink: 0;
  -webkit-app-region: no-drag;
}

.scroll-btn:hover {
  background: var(--bg-surface);
  color: var(--text-primary);
}

.scroll-left {
  border-radius: 4px 0 0 4px;
}

.scroll-right {
  border-radius: 0 4px 4px 0;
}

.tabs-container {
  display: flex;
  gap: 2px;
  overflow-x: auto;
  scrollbar-width: none;
  flex: 1;
  min-width: 0;
}

.tabs-container::-webkit-scrollbar {
  display: none;
}

.tab {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  min-width: 120px;
  max-width: 180px;
  background: transparent;
  border-radius: 0;
  cursor: grab;
  transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1);
  user-select: none;
  flex-shrink: 0;
  position: relative;
  overflow: hidden;
  z-index: 1;
  -webkit-app-region: no-drag;
}

/* Tab 顶部 & 底部渐变指示线（宽度动画） */
.tab::before,
.tab::after {
  content: '';
  position: absolute;
  left: 50%;
  width: 0;
  height: 2px;
  background: linear-gradient(90deg, var(--accent-primary), var(--accent-secondary));
  transition: all 0.25s ease;
  transform: translateX(-50%);
  border-radius: 1px;
}

.tab::before {
  top: 0;
  border-radius: 0 0 2px 2px;
}

.tab::after {
  bottom: 0;
  border-radius: 1px;
}

.tab:hover {
  background: var(--bg-surface);
}

.tab:hover::before,
.tab:hover::after {
  width: 50%;
}

.tab.active {
  background: var(--bg-primary);
  box-shadow: 
    0 -4px 15px rgba(var(--accent-rgb, 137, 180, 250), 0.15),
    inset 0 1px 0 rgba(255, 255, 255, 0.05);
  position: relative;
  z-index: 2;
}

.tab.active::before,
.tab.active::after {
  width: 100%;
  height: 3px;
  background: linear-gradient(90deg, var(--accent-primary), var(--accent-secondary));
  box-shadow: 0 0 10px var(--accent-primary);
}

.tab.dragging {
  opacity: 0.5;
  cursor: grabbing;
}

.tab.drag-over {
  border-left: 2px solid var(--accent-primary);
  margin-left: -2px;
}

/* 需要注意的状态：有待确认操作，或后台 tab 上 Agent 任务刚结束 */
.tab.needs-attention {
  animation: tab-attention-pulse 1.5s ease-in-out infinite;
  border-color: var(--color-warning);
  background: rgba(var(--color-warning-rgb), 0.15);
}

.tab.needs-attention .tab-title {
  color: var(--color-warning);
}

.tab.needs-attention .tab-icon {
  color: var(--color-warning);
}

@keyframes tab-attention-pulse {
  0%, 100% {
    box-shadow: 0 0 0 0 rgba(var(--color-warning-rgb), 0.4);
  }
  50% {
    box-shadow: 0 0 0 4px rgba(var(--color-warning-rgb), 0);
  }
}

.tab-icon {
  display: flex;
  align-items: center;
  color: var(--text-muted);
  transition: all 0.25s ease;
}

.tab:hover .tab-icon {
  color: var(--text-secondary);
}

.tab.active .tab-icon {
  color: var(--accent-primary);
  filter: drop-shadow(0 0 4px var(--accent-primary));
}

/* 远程 Agent 标签页图标 —— 走 --brand-vital，让"远程在线"信号跨主题保持饱满 */
.remote-icon {
  color: var(--brand-vital);
}

.tab.active .remote-icon {
  color: var(--brand-vital);
  filter: drop-shadow(0 0 4px var(--brand-vital));
}

.tab-title {
  flex: 1;
  font-size: 12px;
  color: var(--text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  transition: all 0.2s ease;
}

.tab:hover .tab-title {
  color: var(--text-primary);
}

.tab.active .tab-title {
  color: var(--text-primary);
  font-weight: 600;
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
  border-radius: 6px;
  color: var(--text-muted);
  cursor: pointer;
  opacity: 0;
  transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
  transform: scale(0.8);
}

.tab:hover .tab-close {
  opacity: 1;
  transform: scale(1);
}

.tab-close:hover {
  background: rgba(var(--accent-error-rgb, 243, 139, 168), 0.2);
  color: var(--accent-error);
  transform: scale(1.1);
}

.tab-close:active {
  transform: scale(0.9);
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

.btn-batch {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  margin-left: 4px;
  background: transparent;
  border: none;
  border-radius: 8px;
  color: var(--text-muted);
  cursor: pointer;
  transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1);
  position: relative;
  overflow: hidden;
  flex-shrink: 0;
  -webkit-app-region: no-drag;
}

.btn-batch::before {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(135deg, var(--accent-primary), var(--accent-secondary));
  opacity: 0;
  transition: opacity 0.25s ease;
}

.btn-batch:hover::before {
  opacity: 0.15;
}

.btn-batch:hover {
  background: var(--bg-surface);
  color: var(--accent-primary);
  transform: scale(1.05);
}

.btn-batch:hover svg {
  filter: drop-shadow(0 0 4px var(--accent-primary));
}

.btn-batch:active {
  transform: scale(0.95);
}

.new-tab-wrapper {
  position: relative;
  display: flex;
  flex-shrink: 0;
  margin-left: 4px;
  -webkit-app-region: no-drag;
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
  border-radius: 8px 0 0 8px;
  color: var(--text-muted);
  cursor: pointer;
  transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1);
  position: relative;
  overflow: hidden;
}

/* 新建按钮悬停光效 */
.btn-new-tab::before {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(135deg, var(--accent-primary), var(--accent-secondary));
  opacity: 0;
  transition: opacity 0.25s ease;
}

.btn-new-tab:hover::before {
  opacity: 0.15;
}

.btn-new-tab:hover {
  background: var(--bg-surface);
  color: var(--accent-primary);
  transform: scale(1.05);
}

.btn-new-tab:hover svg {
  filter: drop-shadow(0 0 4px var(--accent-primary));
}

.btn-new-tab:active {
  transform: scale(0.95);
}

.btn-new-tab-dropdown {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 28px;
  padding: 0;
  background: transparent;
  border: none;
  border-left: 1px solid var(--border-color);
  border-radius: 0 8px 8px 0;
  color: var(--text-muted);
  cursor: pointer;
  transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1);
}

.btn-new-tab-dropdown:hover {
  background: var(--bg-surface);
  color: var(--accent-primary);
}

.btn-new-tab-dropdown:active {
  transform: scale(0.95);
}

.shell-menu-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 1000;
}

.shell-menu {
  position: fixed;
  min-width: 150px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
  z-index: 1001;
  overflow: hidden;
}

.shell-menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  font-size: 12px;
  color: var(--text-primary);
  cursor: pointer;
  transition: background 0.15s;
}

.shell-menu-item:hover {
  background: var(--bg-hover);
}

.shell-icon {
  font-size: 14px;
}

.shell-icon-lucide {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  color: var(--text-secondary);
}

.shell-menu-divider {
  height: 1px;
  background: var(--border-color);
  margin: 4px 0;
}
</style>
