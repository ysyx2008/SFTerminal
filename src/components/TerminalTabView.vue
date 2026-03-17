<script setup lang="ts">
import { ref, computed, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { AlertCircle } from 'lucide-vue-next'
import { useTerminalStore } from '../stores/terminal'
import type { TerminalTab } from '../stores/terminal'
import Terminal from './Terminal.vue'
import AiPanel from './AiPanel.vue'

const { t } = useI18n()
const terminalStore = useTerminalStore()
const isSteamBuild = typeof __STEAM_BUILD__ !== 'undefined' && __STEAM_BUILD__

const props = defineProps<{
  tab: TerminalTab
  isActive: boolean
}>()

// ==================== AI 面板状态（每个 tab 独立） ====================

const showAiPanel = ref(isSteamBuild ? false : true)
const aiPanelWidth = ref(420)
const isResizing = ref(false)
const MIN_AI_WIDTH = 300
const getMaxAiWidth = () => window.innerWidth - 200

// AiPanel 实例引用
const aiPanelRef = ref<InstanceType<typeof AiPanel> | null>(null)

// ==================== Terminal → AiPanel 通信 ====================

function handleSendToAi(text: string) {
  showAiPanel.value = true
  // nextTick 不需要：Vue 在同一 tick 内 v-show 切换后 ref 已可用
  // 因为 AiPanel 始终挂载（v-show 不销毁），ref 一直存在
  aiPanelRef.value?.analyzeText(text)
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
  const newWidth = window.innerWidth - e.clientX
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

const aiPanelVisible = computed(() => props.isActive && showAiPanel.value)

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
  <div class="terminal-tab">
    <div class="terminal-main">
      <Terminal
        v-if="tab.ptyId"
        :tab-id="tab.id"
        :pty-id="tab.ptyId"
        :type="(tab.type as 'local' | 'ssh')"
        :is-active="isActive"
        @send-to-ai="handleSendToAi"
      />
      <div v-else-if="tab.isLoading" class="terminal-loading">
        <div class="loading-spinner"></div>
        <span>{{ tab.loadingMessage || t('terminal.connecting') }}</span>
      </div>
      <div v-else class="terminal-error">
        <AlertCircle :size="48" />
        <span class="error-title">{{ t('terminal.connectionFailed') }}</span>
        <span v-if="tab.connectionError" class="error-detail">{{ tab.connectionError }}</span>
        <button class="btn btn-sm" @click="terminalStore.closeTab(tab.id)">{{ t('common.close') }}</button>
      </div>
    </div>
    <template v-if="!isSteamBuild">
      <div
        v-show="showAiPanel"
        class="resize-handle"
        @mousedown="startResize"
        :class="{ resizing: isResizing }"
      ></div>
      <div
        v-show="showAiPanel"
        class="tab-ai-sidebar"
        :style="{ width: aiPanelWidth + 'px' }"
      >
        <AiPanel
          ref="aiPanelRef"
          :tab-id="tab.id"
          :visible="aiPanelVisible"
          @close="showAiPanel = false"
        />
      </div>
    </template>
  </div>
</template>

<style scoped>
.terminal-tab {
  display: flex;
  flex-direction: row;
  width: 100%;
  height: 100%;
}

.terminal-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* 终端 Tab 内的 AI 侧栏 */
.tab-ai-sidebar {
  min-width: 280px;
  background: linear-gradient(180deg, var(--bg-secondary) 0%, var(--bg-tertiary) 100%);
  border-left: 1px solid var(--border-color);
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  position: relative;
}

.tab-ai-sidebar::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  bottom: 0;
  width: 1px;
  background: linear-gradient(180deg, transparent, rgba(var(--accent-secondary-rgb, 116, 199, 236), 0.15), transparent);
  pointer-events: none;
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

/* 拖拽调整宽度手柄 */
.resize-handle {
  width: 5px;
  cursor: col-resize;
  background: transparent;
  transition: all 0.25s ease;
  flex-shrink: 0;
  position: relative;
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
