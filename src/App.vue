<script setup lang="ts">
import { ref, onMounted, onUnmounted, provide, watch } from 'vue'
import { useTerminalStore } from './stores/terminal'
import { useConfigStore } from './stores/config'
import TabBar from './components/TabBar.vue'
import TerminalContainer from './components/TerminalContainer.vue'
import AiPanel from './components/AiPanel.vue'
import SessionManager from './components/SessionManager.vue'
import SettingsModal from './components/Settings/SettingsModal.vue'

const terminalStore = useTerminalStore()
const configStore = useConfigStore()

const showSidebar = ref(false)
const showAiPanel = ref(false)
const showSettings = ref(false)

// AI 面板宽度
const aiPanelWidth = ref(420)
const isResizing = ref(false)
const MIN_AI_WIDTH = 300
const MAX_AI_WIDTH = 800

// 提供给子组件
provide('showSettings', () => {
  showSettings.value = true
})

onMounted(async () => {
  // 加载配置
  await configStore.loadConfig()

  // 创建初始终端标签页
  await terminalStore.createTab('local')
})

// 切换侧边栏
const toggleSidebar = () => {
  showSidebar.value = !showSidebar.value
}

// 切换 AI 面板
const toggleAiPanel = () => {
  showAiPanel.value = !showAiPanel.value
}

// 监听右键菜单发送到 AI 的请求，自动打开 AI 面板
watch(() => terminalStore.pendingAiText, (text) => {
  if (text) {
    showAiPanel.value = true
  }
})

// AI 面板拖拽调整宽度
const startResize = (e: MouseEvent) => {
  isResizing.value = true
  document.addEventListener('mousemove', handleResize)
  document.addEventListener('mouseup', stopResize)
  document.body.style.cursor = 'col-resize'
  document.body.style.userSelect = 'none'
}

const handleResize = (e: MouseEvent) => {
  if (!isResizing.value) return
  
  // 计算新宽度（从右边缘到鼠标位置）
  const newWidth = window.innerWidth - e.clientX
  
  // 限制宽度范围
  if (newWidth >= MIN_AI_WIDTH && newWidth <= MAX_AI_WIDTH) {
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
</script>

<template>
  <div class="app-container" :class="{ 'sidebar-open': showSidebar, 'ai-open': showAiPanel }">
    <!-- 顶部工具栏 -->
    <header class="app-header">
      <div class="header-left">
        <button class="btn-icon" @click="toggleSidebar" data-tooltip="会话管理">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="3" y="3" width="7" height="7" rx="1"/>
            <rect x="14" y="3" width="7" height="7" rx="1"/>
            <rect x="14" y="14" width="7" height="7" rx="1"/>
            <rect x="3" y="14" width="7" height="7" rx="1"/>
          </svg>
        </button>
        <span class="app-title">旗鱼终端</span>
      </div>
      <div class="header-center">
        <TabBar />
      </div>
      <div class="header-right">
        <button class="btn-icon" @click="toggleAiPanel" data-tooltip="AI 助手">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M12 2a2 2 0 0 1 2 2c0 .74-.4 1.39-1 1.73V7h1a7 7 0 0 1 7 7h1a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-1v1a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-1H2a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1h1a7 7 0 0 1 7-7h1V5.73c-.6-.34-1-.99-1-1.73a2 2 0 0 1 2-2z"/>
            <circle cx="7.5" cy="14.5" r="1.5"/>
            <circle cx="16.5" cy="14.5" r="1.5"/>
          </svg>
        </button>
        <button class="btn-icon" @click="showSettings = true" data-tooltip="设置">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="3"/>
            <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>
          </svg>
        </button>
      </div>
    </header>

    <!-- 主体内容 -->
    <div class="app-body">
      <!-- 左侧边栏 - 主机管理 -->
      <aside v-show="showSidebar" class="sidebar">
        <div class="sidebar-header">
          <span>主机管理</span>
          <button class="btn-icon btn-sm" @click="showSidebar = false">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18"/>
              <line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
        <div class="sidebar-content">
          <SessionManager />
        </div>
      </aside>

      <!-- 终端区域 -->
      <main class="terminal-area">
        <TerminalContainer />
      </main>

      <!-- AI 面板 -->
      <template v-if="showAiPanel">
        <div 
          class="resize-handle" 
          @mousedown="startResize"
          :class="{ resizing: isResizing }"
        ></div>
        <aside class="ai-sidebar" :style="{ width: aiPanelWidth + 'px' }">
          <AiPanel @close="showAiPanel = false" />
        </aside>
      </template>
    </div>

    <!-- 设置弹窗 -->
    <SettingsModal v-if="showSettings" @close="showSettings = false" />
  </div>
</template>

<style scoped>
.app-container {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  background: var(--bg-primary);
}

/* 顶部工具栏 */
.app-header {
  display: flex;
  align-items: center;
  height: var(--header-height);
  padding: 0 12px;
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border-color);
  -webkit-app-region: drag;
}

.header-left,
.header-right {
  display: flex;
  align-items: center;
  gap: 8px;
  -webkit-app-region: no-drag;
}

.header-center {
  flex: 1;
  display: flex;
  justify-content: center;
  overflow: hidden;
  -webkit-app-region: no-drag;
}

.app-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
  margin-left: 8px;
}

/* 主体 */
.app-body {
  display: flex;
  flex: 1;
  overflow: hidden;
}

/* 侧边栏 */
.sidebar {
  width: var(--sidebar-width);
  background: var(--bg-secondary);
  border-right: 1px solid var(--border-color);
  display: flex;
  flex-direction: column;
}

.sidebar-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
  border-bottom: 1px solid var(--border-color);
}

.sidebar-content {
  flex: 1;
  overflow-y: auto;
}

/* 终端区域 */
.terminal-area {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* AI 侧边栏 */
.ai-sidebar {
  min-width: 280px;
  max-width: 600px;
  background: var(--bg-secondary);
  border-left: 1px solid var(--border-color);
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
}

/* 拖拽调整宽度手柄 */
.resize-handle {
  width: 4px;
  cursor: col-resize;
  background: transparent;
  transition: background 0.2s ease;
  flex-shrink: 0;
}

.resize-handle:hover,
.resize-handle.resizing {
  background: var(--accent-primary);
}

</style>

