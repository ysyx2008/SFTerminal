<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { X, Terminal, Monitor, Check, Send, Layers } from 'lucide-vue-next'
import { useTerminalStore } from '../stores/terminal'
import type { BatchCommandScope, BatchCommandTarget } from '../stores/terminal'

const { t } = useI18n()
const terminalStore = useTerminalStore()

const isOpen = ref(false)
const command = ref('')
const selectedKeys = ref<string[]>([])
const sendEnter = ref(true)
const inputRef = ref<HTMLInputElement | null>(null)

const scope = ref<BatchCommandScope>('all')
/** 本标签范围所绑定的 tab（打开面板时由 activeTab 决定） */
const scopeTabId = ref<string | undefined>(undefined)

const allTargets = computed(() => terminalStore.getAllBatchTargets())

const visibleTargets = computed(() => {
  if (scope.value === 'tab' && scopeTabId.value) {
    return terminalStore.getBatchTargetsForTab(scopeTabId.value)
  }
  return allTargets.value
})

const groupedTargets = computed(() => {
  const groups = new Map<string, { tabTitle: string; targets: BatchCommandTarget[] }>()
  for (const target of visibleTargets.value) {
    const existing = groups.get(target.tabId)
    if (existing) {
      existing.targets.push(target)
    } else {
      groups.set(target.tabId, { tabTitle: target.tabTitle, targets: [target] })
    }
  }
  return Array.from(groups.entries()).map(([tabId, group]) => ({ tabId, ...group }))
})

/** 全部标签 + 多窗格 Tab 才用分组头；单窗格或本标签范围均扁平列表 */
const shouldUseGroupLayout = (group: { targets: BatchCommandTarget[] }) =>
  scope.value === 'all' && group.targets.length > 1

const isAllSelected = computed(() => {
  const available = visibleTargets.value
  return available.length > 0 && selectedKeys.value.length === available.length
})

const targetDisplayName = (target: BatchCommandTarget, groupSize: number): string => {
  if (groupSize === 1) {
    return formatTargetLine(target, scope.value === 'all')
  }
  return formatTargetLine(target, false)
}

function formatTargetLine(target: BatchCommandTarget, includeTab: boolean): string {
  const parts: string[] = []
  if (includeTab) parts.push(target.tabTitle)
  if (target.paneLabel && (target.hostHint || getBatchPaneCountForTab(target.tabId) > 1)) {
    parts.push(target.paneLabel)
  }
  if (target.hostHint) parts.push(target.hostHint)
  if (parts.length === 0) return target.tabTitle
  return parts.join(' · ')
}

function getBatchPaneCountForTab(tabId: string): number {
  const tab = terminalStore.tabs.find(t => t.id === tabId)
  return tab ? terminalStore.getBatchPaneCount(tab) : 1
}

const toggleTarget = (key: string) => {
  const index = selectedKeys.value.indexOf(key)
  if (index === -1) {
    selectedKeys.value.push(key)
  } else {
    selectedKeys.value.splice(index, 1)
  }
}

const toggleGroup = (tabId: string) => {
  const keys = visibleTargets.value.filter(t => t.tabId === tabId).map(t => t.key)
  const allSelected = keys.every(k => selectedKeys.value.includes(k))
  if (allSelected) {
    selectedKeys.value = selectedKeys.value.filter(k => !keys.includes(k))
  } else {
    const merged = new Set(selectedKeys.value)
    for (const k of keys) merged.add(k)
    selectedKeys.value = Array.from(merged)
  }
}

const isGroupSelected = (tabId: string): boolean => {
  const keys = visibleTargets.value.filter(t => t.tabId === tabId).map(t => t.key)
  return keys.length > 0 && keys.every(k => selectedKeys.value.includes(k))
}

const isGroupIndeterminate = (tabId: string): boolean => {
  const keys = visibleTargets.value.filter(t => t.tabId === tabId).map(t => t.key)
  const selected = keys.filter(k => selectedKeys.value.includes(k)).length
  return selected > 0 && selected < keys.length
}

const toggleSelectAll = () => {
  if (isAllSelected.value) {
    selectedKeys.value = []
  } else {
    selectedKeys.value = visibleTargets.value.map(t => t.key)
  }
}

const applyDefaultSelection = () => {
  selectedKeys.value = visibleTargets.value.map(t => t.key)
}

const setScope = (newScope: BatchCommandScope) => {
  if (scope.value === newScope) return
  scope.value = newScope
  if (newScope === 'tab') {
    scopeTabId.value = terminalStore.activeTabId ?? scopeTabId.value
    if (!scopeTabId.value) {
      scope.value = 'all'
      return
    }
  }
  applyDefaultSelection()
}

const sendCommand = async () => {
  if (!command.value.trim() || selectedKeys.value.length === 0) return

  const cmdToSend = sendEnter.value ? command.value + '\r' : command.value
  const keySet = new Set(selectedKeys.value)
  const targets = allTargets.value.filter(t => keySet.has(t.key))

  await Promise.all(
    targets.map(target => terminalStore.writeToPty(target.ptyId, target.terminalType, cmdToSend))
  )

  command.value = ''
}

const open = () => {
  const defaults = terminalStore.getDefaultBatchScope()
  scope.value = defaults.scope
  scopeTabId.value = defaults.tabId
  isOpen.value = true
  applyDefaultSelection()
  setTimeout(() => {
    inputRef.value?.focus()
  }, 100)
}

const close = () => {
  isOpen.value = false
  command.value = ''
}

const handleKeydown = (e: KeyboardEvent) => {
  if (e.key === 'Escape') {
    e.stopImmediatePropagation()
    close()
  } else if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    sendCommand()
  }
}

const handleToggleBatchPanel = () => {
  if (isOpen.value) {
    close()
  } else {
    open()
  }
}

const canUseTabScope = computed(() => {
  const tabId = terminalStore.activeTabId
  if (!tabId) return false
  const tab = terminalStore.tabs.find(t => t.id === tabId)
  return Boolean(tab && tab.type !== 'assistant' && terminalStore.getBatchTargetsForTab(tabId).length > 0)
})

onMounted(() => {
  window.addEventListener('toggle-batch-panel', handleToggleBatchPanel)
})

onUnmounted(() => {
  window.removeEventListener('toggle-batch-panel', handleToggleBatchPanel)
})

defineExpose({
  open,
  close,
  isOpen
})
</script>

<template>
  <Teleport to="body">
    <Transition name="fade">
      <div v-if="isOpen" class="batch-overlay" @click="close"></div>
    </Transition>

    <Transition name="slide-up">
      <div v-if="isOpen" class="batch-panel">
        <div class="batch-header">
          <div class="batch-title">
            <Layers :size="18" />
            <span>{{ t('batch.title') }}</span>
          </div>
          <button class="close-btn" @click="close" :title="t('common.close')">
            <X :size="16" />
          </button>
        </div>

        <div class="batch-content">
          <div class="scope-switch" role="tablist">
            <button
              type="button"
              class="scope-btn"
              :class="{ active: scope === 'tab' }"
              :disabled="!canUseTabScope"
              role="tab"
              :aria-selected="scope === 'tab'"
              @click="setScope('tab')"
            >
              {{ t('batch.scopeTab') }}
            </button>
            <button
              type="button"
              class="scope-btn"
              :class="{ active: scope === 'all' }"
              role="tab"
              :aria-selected="scope === 'all'"
              @click="setScope('all')"
            >
              {{ t('batch.scopeAll') }}
            </button>
          </div>

          <div class="terminal-selection">
            <div class="selection-header">
              <span class="selection-label">{{ t('batch.selectPanes') }}</span>
              <button class="select-all-btn" @click="toggleSelectAll">
                <span v-if="isAllSelected">{{ t('common.unselectAll') }}</span>
                <span v-else>{{ t('common.selectAll') }}</span>
              </button>
            </div>

            <div v-if="visibleTargets.length === 0" class="no-terminals">
              {{ t('batch.noActiveTerminals') }}
            </div>

            <div v-else class="terminal-list">
              <template v-for="group in groupedTargets" :key="group.tabId">
                <template v-if="shouldUseGroupLayout(group)">
                  <div
                    class="terminal-group"
                    :class="{ selected: isGroupSelected(group.tabId) }"
                    @click="toggleGroup(group.tabId)"
                  >
                    <div
                      class="terminal-checkbox"
                      :class="{ indeterminate: isGroupIndeterminate(group.tabId) }"
                    >
                      <Check v-if="isGroupSelected(group.tabId)" :size="14" />
                    </div>
                    <span class="terminal-name group-name">{{ group.tabTitle }}</span>
                    <span class="group-count">{{ group.targets.length }}</span>
                  </div>

                  <div
                    v-for="target in group.targets"
                    :key="target.key"
                    class="terminal-item nested"
                    :class="{ selected: selectedKeys.includes(target.key) }"
                    @click="toggleTarget(target.key)"
                  >
                    <div class="terminal-checkbox">
                      <Check v-if="selectedKeys.includes(target.key)" :size="14" />
                    </div>
                    <span class="terminal-icon">
                      <Terminal v-if="target.terminalType === 'local'" :size="14" />
                      <Monitor v-else :size="14" />
                    </span>
                    <span class="terminal-name">{{ targetDisplayName(target, group.targets.length) }}</span>
                  </div>
                </template>

                <div
                  v-else
                  v-for="target in group.targets"
                  :key="target.key"
                  class="terminal-item"
                  :class="{ selected: selectedKeys.includes(target.key) }"
                  @click="toggleTarget(target.key)"
                >
                  <div class="terminal-checkbox">
                    <Check v-if="selectedKeys.includes(target.key)" :size="14" />
                  </div>
                  <span class="terminal-icon">
                    <Terminal v-if="target.terminalType === 'local'" :size="14" />
                    <Monitor v-else :size="14" />
                  </span>
                  <span class="terminal-name">{{ targetDisplayName(target, group.targets.length) }}</span>
                </div>
              </template>
            </div>
          </div>

          <div class="command-input-section">
            <label class="input-label">{{ t('batch.commandInput') }}</label>
            <div class="input-wrapper">
              <input
                ref="inputRef"
                v-model="command"
                type="text"
                class="command-input"
                :placeholder="t('batch.commandPlaceholder')"
                @keydown="handleKeydown"
              />
              <button
                class="send-btn"
                :disabled="!command.trim() || selectedKeys.length === 0"
                @click="sendCommand"
                :title="t('batch.send')"
              >
                <Send :size="16" />
              </button>
            </div>

            <div class="input-options">
              <label class="checkbox-label">
                <input type="checkbox" v-model="sendEnter" />
                <span>{{ t('batch.sendEnter') }}</span>
              </label>
              <span class="selected-count">
                {{ t('batch.selectedCount', { count: selectedKeys.length }) }}
              </span>
            </div>
          </div>
        </div>

        <div class="batch-footer">
          <span class="shortcut-hint">{{ t('batch.shortcutHint') }}</span>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.batch-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.5);
  z-index: 1000;
}

.batch-panel {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  background: var(--bg-secondary);
  border-top: 1px solid var(--border-color);
  border-radius: 12px 12px 0 0;
  z-index: 1001;
  max-height: 70vh;
  display: flex;
  flex-direction: column;
  box-shadow: 0 -8px 32px rgba(0, 0, 0, 0.3);
}

.batch-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border-color);
  background: var(--bg-tertiary);
  border-radius: 12px 12px 0 0;
}

.batch-title {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary);
}

.batch-title svg {
  color: var(--accent-primary);
}

.close-btn {
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

.close-btn:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.batch-content {
  flex: 1;
  overflow-y: auto;
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.scope-switch {
  display: flex;
  gap: 4px;
  padding: 4px;
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  width: fit-content;
}

.scope-btn {
  padding: 6px 14px;
  font-size: 13px;
  background: transparent;
  border: none;
  border-radius: 6px;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.2s ease;
}

.scope-btn:hover:not(:disabled) {
  color: var(--text-primary);
  background: var(--bg-hover);
}

.scope-btn.active {
  background: var(--accent-primary);
  color: white;
}

.scope-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.terminal-selection {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.selection-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.selection-label {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-secondary);
}

.select-all-btn {
  padding: 4px 10px;
  font-size: 12px;
  background: transparent;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.2s ease;
}

.select-all-btn:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
  border-color: var(--accent-primary);
}

.no-terminals {
  padding: 20px;
  text-align: center;
  color: var(--text-muted);
  font-size: 13px;
}

.terminal-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.terminal-group {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.2s ease;
  user-select: none;
}

.terminal-group:hover {
  border-color: var(--accent-primary);
}

.terminal-group.selected {
  border-color: var(--accent-primary);
  background: rgba(var(--accent-rgb, 137, 180, 250), 0.1);
}

.group-name {
  flex: 1;
  font-weight: 600;
}

.group-count {
  font-size: 11px;
  color: var(--text-muted);
  background: var(--bg-primary);
  padding: 2px 8px;
  border-radius: 10px;
}

.terminal-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.2s ease;
  user-select: none;
}

.terminal-item.nested {
  margin-left: 16px;
}

.terminal-item:hover {
  border-color: var(--accent-primary);
  background: var(--bg-surface);
}

.terminal-item.selected {
  border-color: var(--accent-primary);
  background: rgba(var(--accent-rgb, 137, 180, 250), 0.15);
}

.terminal-checkbox {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border: 2px solid var(--border-color);
  border-radius: 4px;
  background: var(--bg-primary);
  transition: all 0.2s ease;
  flex-shrink: 0;
}

.terminal-checkbox.indeterminate {
  background: var(--accent-primary);
  border-color: var(--accent-primary);
  opacity: 0.6;
}

.terminal-item.selected .terminal-checkbox,
.terminal-group.selected .terminal-checkbox {
  background: var(--accent-primary);
  border-color: var(--accent-primary);
  color: white;
}

.terminal-icon {
  display: flex;
  align-items: center;
  color: var(--text-muted);
}

.terminal-item.selected .terminal-icon {
  color: var(--accent-primary);
}

.terminal-name {
  font-size: 13px;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.command-input-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.input-label {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-secondary);
}

.input-wrapper {
  display: flex;
  gap: 8px;
}

.command-input {
  flex: 1;
  padding: 12px 16px;
  font-size: 14px;
  font-family: 'SF Mono', 'Menlo', 'Monaco', 'Consolas', monospace;
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  color: var(--text-primary);
  outline: none;
  transition: all 0.2s ease;
}

.command-input:focus {
  border-color: var(--accent-primary);
  box-shadow: 0 0 0 3px rgba(var(--accent-rgb, 137, 180, 250), 0.2);
}

.command-input::placeholder {
  color: var(--text-muted);
}

.send-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 48px;
  height: 48px;
  padding: 0;
  background: var(--accent-primary);
  border: none;
  border-radius: 8px;
  color: white;
  cursor: pointer;
  transition: all 0.2s ease;
}

.send-btn:hover:not(:disabled) {
  background: var(--accent-secondary);
  transform: scale(1.05);
}

.send-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.input-options {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.checkbox-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--text-secondary);
  cursor: pointer;
}

.checkbox-label input[type="checkbox"] {
  width: 16px;
  height: 16px;
  accent-color: var(--accent-primary);
}

.selected-count {
  font-size: 12px;
  color: var(--text-muted);
}

.batch-footer {
  padding: 12px 20px;
  border-top: 1px solid var(--border-color);
  background: var(--bg-tertiary);
}

.shortcut-hint {
  font-size: 12px;
  color: var(--text-muted);
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

.slide-up-enter-active,
.slide-up-leave-active {
  transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
}

.slide-up-enter-from,
.slide-up-leave-to {
  transform: translateY(100%);
  opacity: 0;
}
</style>
