<script setup lang="ts">
/**
 * 真终端宿主：分屏占位 + Teleport 实例池。
 * 终端页与助手换台共用，不含 AI 侧栏。
 */
import { shallowRef, triggerRef, computed, watch, provide, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { AlertCircle, ChevronDown, Monitor, Plus, Terminal as TerminalIcon, X } from 'lucide-vue-next'
import { useTerminalStore } from '../stores/terminal'
import type { SplitPane } from '../stores/terminal'
import { useConfigStore } from '../stores/config'
import { getAllTerminalPanes } from '../stores/split-pane-tree'
import { isWorkbenchAvailable } from '../workbench/registry'
import Terminal from './Terminal.vue'
import SplitPaneView from './SplitPaneView.vue'
import { PANE_SLOT_REGISTRY_KEY, type PaneSlotRegistry } from './pane-slot-registry'

const { t } = useI18n()
const terminalStore = useTerminalStore()
const configStore = useConfigStore()

const props = defineProps<{
  tab: { id: string }
  isActive: boolean
  /** 终端页连接失败时可关页；助手换台不要关对话 */
  showCloseOnError?: boolean
  /** 助手换台：顶栏做成终端页标签条，可拖窗口、可关回对话台 */
  showStageChrome?: boolean
}>()

const emit = defineEmits<{
  sendToAi: [text: string]
}>()

const liveTab = computed(() => terminalStore.tabs.find(t => t.id === props.tab.id) ?? props.tab)

const terminalPanes = computed<SplitPane[]>(() => {
  if (!liveTab.value.splitLayout) return []
  return getAllTerminalPanes(liveTab.value.splitLayout).filter(p => Boolean(p.ptyId))
})

const paneSlotElements = shallowRef<Record<string, HTMLElement>>({})

function registerPaneSlot(ptyId: string, el: HTMLElement) {
  if (paneSlotElements.value[ptyId] === el) return
  paneSlotElements.value = { ...paneSlotElements.value, [ptyId]: el }
  triggerRef(paneSlotElements)
}

provide<PaneSlotRegistry>(PANE_SLOT_REGISTRY_KEY, {
  register: registerPaneSlot,
  unregister: () => { /* no-op */ }
})

const canCreateLocal = isWorkbenchAvailable('local')
const canCreateSsh = isWorkbenchAvailable('ssh')
const canAddPane = canCreateLocal || canCreateSsh

const showNewMenu = ref(false)
const menuPosition = ref({ top: '0px', left: '0px' })
const newMenuBtnRef = ref<HTMLElement | null>(null)

function paneTitle(pane: SplitPane): string {
  if (pane.terminalType === 'ssh') {
    if (pane.sshSessionId) {
      const session = configStore.sshSessions.find(s => s.id === pane.sshSessionId)
      if (session?.name) return session.name
    }
    if (pane.sshConfig) return `${pane.sshConfig.username}@${pane.sshConfig.host}`
    return t('tabs.sshTerminal')
  }
  const locals = terminalPanes.value.filter(p => p.terminalType !== 'ssh')
  if (locals.length > 1) {
    const n = locals.findIndex(p => p.id === pane.id) + 1
    return `${t('terminal.localTerminal')} ${n}`
  }
  return t('terminal.localTerminal')
}

function activatePane(pane: SplitPane) {
  terminalStore.setActivePaneInTab(props.tab.id, pane.id)
}

async function closeHostedPane(pane: SplitPane, event: MouseEvent) {
  event.stopPropagation()
  await terminalStore.closePane(props.tab.id, pane.id)
}

async function addLocalPane() {
  if (!canCreateLocal) return
  showNewMenu.value = false
  await terminalStore.openTerminalOnTab(props.tab.id, { kind: 'local' })
}

async function addSshPane(sessionId: string) {
  if (!canCreateSsh) return
  showNewMenu.value = false
  await terminalStore.openTerminalOnTab(props.tab.id, { kind: 'ssh', sessionId })
}

function toggleNewMenu(event: MouseEvent) {
  if (!showNewMenu.value) {
    const button = (event.currentTarget as HTMLElement) || newMenuBtnRef.value
    const rect = button.getBoundingClientRect()
    menuPosition.value = {
      top: `${rect.bottom + 4}px`,
      left: `${Math.max(8, rect.right - 200)}px`
    }
  }
  showNewMenu.value = !showNewMenu.value
}

function hideNewMenu() {
  showNewMenu.value = false
}

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
</script>

<template>
  <div class="terminal-pane-host">
    <div v-if="showStageChrome" class="stage-header">
      <div class="stage-tabs">
        <div
          v-for="pane in terminalPanes"
          :key="pane.id"
          class="stage-tab"
          :class="{ active: pane.isActive }"
          :title="paneTitle(pane)"
          @click="activatePane(pane)"
        >
          <span class="stage-tab-icon">
            <Monitor v-if="pane.terminalType === 'ssh'" :size="14" />
            <TerminalIcon v-else :size="14" />
          </span>
          <span class="stage-tab-title">{{ paneTitle(pane) }}</span>
          <button
            type="button"
            class="stage-tab-close"
            :title="t('tabs.closeTab')"
            :aria-label="t('tabs.closeTab')"
            @click="closeHostedPane(pane, $event)"
          >
            <X :size="12" />
          </button>
        </div>
      </div>

      <div v-if="canAddPane" class="new-tab-wrapper">
        <button
          type="button"
          class="btn-new-tab"
          :title="canCreateLocal ? t('terminal.hosted.newLocal') : t('terminal.hosted.newSsh')"
          @click="canCreateLocal ? addLocalPane() : toggleNewMenu($event)"
        >
          <Plus :size="14" />
        </button>
        <button
          v-if="canCreateSsh"
          ref="newMenuBtnRef"
          type="button"
          class="btn-new-tab-dropdown"
          :title="t('tabs.selectShell')"
          @click="toggleNewMenu"
        >
          <ChevronDown :size="10" />
        </button>
      </div>
    </div>

    <Teleport to="body">
      <div v-if="showStageChrome && showNewMenu" class="shell-menu-overlay" @click="hideNewMenu" />
      <div v-if="showStageChrome && showNewMenu" class="shell-menu" :style="menuPosition">
        <div
          v-if="canCreateLocal"
          class="shell-menu-item"
          @click="addLocalPane"
        >
          <TerminalIcon :size="14" class="shell-icon-lucide" />
          <span>{{ t('terminal.hosted.newLocal') }}</span>
        </div>
        <div v-if="canCreateLocal && canCreateSsh" class="shell-menu-divider" />
        <template v-if="canCreateSsh">
          <div
            v-for="session in configStore.sshSessions"
            :key="session.id"
            class="shell-menu-item"
            @click="addSshPane(session.id)"
          >
            <Monitor :size="14" class="shell-icon-lucide" />
            <span>{{ session.name || `${session.username}@${session.host}` }}</span>
          </div>
          <div v-if="configStore.sshSessions.length === 0" class="shell-menu-item is-empty">
            {{ t('session.noHostsSaved') }}
          </div>
        </template>
      </div>
    </Teleport>

    <SplitPaneView
      v-if="liveTab.splitLayout"
      :tab-id="liveTab.id"
      :layout="liveTab.splitLayout"
      :is-active="isActive"
    />

    <div v-else-if="liveTab.isLoading" class="terminal-loading">
      <div class="loading-spinner"></div>
      <span>{{ liveTab.loadingMessage || t('terminal.connecting') }}</span>
    </div>

    <div v-else class="terminal-error">
      <AlertCircle :size="48" />
      <span class="error-title">{{ t('terminal.connectionFailed') }}</span>
      <span v-if="liveTab.connectionError" class="error-detail">{{ liveTab.connectionError }}</span>
      <button
        v-if="showCloseOnError"
        class="btn btn-sm"
        @click="terminalStore.closeTab(liveTab.id)"
      >{{ t('common.close') }}</button>
    </div>

    <template v-for="pane in terminalPanes" :key="pane.ptyId">
      <Teleport
        v-if="pane.ptyId && paneSlotElements[pane.ptyId]"
        :to="paneSlotElements[pane.ptyId]"
      >
        <Terminal
          :tab-id="liveTab.id"
          :pty-id="pane.ptyId"
          :type="(pane.terminalType as 'local' | 'ssh')"
          :is-active="isActive && (pane.isActive ?? false)"
          @send-to-ai="emit('sendToAi', $event)"
        />
      </Teleport>
    </template>
  </div>
</template>

<style scoped>
.terminal-pane-host {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  position: relative;
  min-width: 0;
  min-height: 0;
  height: 100%;
}

.terminal-pane-host > :deep(.split-pane) {
  flex: 1 1 auto;
  min-height: 0;
  min-width: 0;
}

.stage-header {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
  box-sizing: border-box;
  height: var(--workbench-panel-header-height, 38px);
  min-height: var(--workbench-panel-header-height, 38px);
  padding: 0 8px;
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border-color);
  -webkit-app-region: drag;
}

.stage-tabs {
  display: flex;
  align-items: center;
  gap: 2px;
  flex: 1;
  min-width: 0;
  overflow-x: auto;
  scrollbar-width: none;
}

.stage-tabs::-webkit-scrollbar {
  display: none;
}

.stage-tab {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  min-width: 88px;
  max-width: 180px;
  background: transparent;
  border-radius: 0;
  cursor: pointer;
  transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1);
  user-select: none;
  flex-shrink: 0;
  position: relative;
  overflow: hidden;
  z-index: 1;
  -webkit-app-region: no-drag;
}

.stage-tab::before,
.stage-tab::after {
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

.stage-tab::before {
  top: 0;
  border-radius: 0 0 2px 2px;
}

.stage-tab::after {
  bottom: 0;
}

.stage-tab:hover {
  background: var(--bg-surface);
}

.stage-tab:hover::before,
.stage-tab:hover::after {
  width: 50%;
}

.stage-tab.active {
  background: var(--bg-primary);
  box-shadow:
    0 -4px 15px rgba(var(--accent-rgb, 137, 180, 250), 0.15),
    inset 0 1px 0 rgba(255, 255, 255, 0.05);
  z-index: 2;
}

.stage-tab.active::before,
.stage-tab.active::after {
  width: 100%;
  height: 3px;
  background: linear-gradient(90deg, var(--accent-primary), var(--accent-secondary));
  box-shadow: 0 0 10px var(--accent-primary);
}

.stage-tab-icon {
  display: flex;
  align-items: center;
  color: var(--text-muted);
  transition: all 0.25s ease;
}

.stage-tab:hover .stage-tab-icon {
  color: var(--text-secondary);
}

.stage-tab.active .stage-tab-icon {
  color: var(--accent-primary);
  filter: drop-shadow(0 0 4px var(--accent-primary));
}

.stage-tab-title {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  color: var(--text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  transition: color 0.2s ease;
}

.stage-tab:hover .stage-tab-title {
  color: var(--text-primary);
}

.stage-tab.active .stage-tab-title {
  color: var(--text-primary);
  font-weight: 600;
}

.stage-tab-close {
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
  opacity: 1;
  transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
  -webkit-app-region: no-drag;
}

.stage-tab-close:hover {
  background: rgba(var(--accent-error-rgb, 243, 139, 168), 0.2);
  color: var(--accent-error);
  transform: scale(1.1);
}

.stage-tab-close:active {
  transform: scale(0.9);
}

.new-tab-wrapper {
  position: relative;
  display: flex;
  flex-shrink: 0;
  margin-left: 4px;
  -webkit-app-region: no-drag;
}

.new-tab-wrapper:not(:has(.btn-new-tab-dropdown)) .btn-new-tab {
  border-radius: 8px;
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
  inset: 0;
  z-index: 1000;
}

.shell-menu {
  position: fixed;
  min-width: 180px;
  max-height: min(360px, calc(100vh - 48px));
  overflow-y: auto;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
  z-index: 1001;
}

.shell-menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  font-size: 13px;
  color: var(--text-primary);
  cursor: pointer;
}

.shell-menu-item:hover {
  background: var(--bg-surface);
}

.shell-menu-item.is-empty {
  color: var(--text-muted);
  cursor: default;
}

.shell-menu-item.is-empty:hover {
  background: transparent;
}

.shell-icon-lucide {
  flex-shrink: 0;
  color: var(--text-muted);
}

.shell-menu-divider {
  height: 1px;
  margin: 4px 0;
  background: var(--border-color);
}

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
</style>
