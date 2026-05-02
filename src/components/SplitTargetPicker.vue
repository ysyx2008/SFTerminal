<script setup lang="ts">
/**
 * 分屏目标选择器
 *
 * 让用户在分屏前选择两件事：
 *   1. 方向：左右 / 上下
 *   2. 新窗格的连接目标：本地终端 / 已配置的某个 SSH 会话
 *
 * 默认值由调用方通过 props 控制（右键菜单的"水平分屏"/"垂直分屏"快捷项不会
 * 弹出此对话框，只有"分屏并连接到..."才会进来）。
 */
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useConfigStore, type SshSession } from '../stores/config'
import type { SplitTarget } from '../stores/terminal'

const { t } = useI18n()
const configStore = useConfigStore()

const props = defineProps<{
  visible: boolean
  defaultDirection?: 'horizontal' | 'vertical'
}>()

const emit = defineEmits<{
  cancel: []
  confirm: [direction: 'horizontal' | 'vertical', target: SplitTarget]
}>()

const direction = ref<'horizontal' | 'vertical'>(props.defaultDirection || 'horizontal')
const selectedKind = ref<'local' | 'ssh'>('local')
const selectedSessionId = ref<string>('')

// 每次打开都重置默认方向（从右键菜单携带）
watch(() => [props.visible, props.defaultDirection], ([visible, dir]) => {
  if (visible) {
    direction.value = (dir as 'horizontal' | 'vertical') || 'horizontal'
    // 默认选中第一个 SSH 会话（如果存在）让用户少点一次
    if (sessions.value.length > 0 && !selectedSessionId.value) {
      selectedSessionId.value = sessions.value[0].id
    }
  }
})

const sessions = computed<SshSession[]>(() => configStore.sshSessions || [])

const sessionsByGroup = computed(() => {
  const groups = new Map<string, SshSession[]>()
  for (const s of sessions.value) {
    const groupKey = s.groupId || s.group || ''
    if (!groups.has(groupKey)) groups.set(groupKey, [])
    groups.get(groupKey)!.push(s)
  }
  return Array.from(groups.entries())
})

const canConfirm = computed(() => {
  if (selectedKind.value === 'local') return true
  return Boolean(selectedSessionId.value)
})

function handleConfirm() {
  if (!canConfirm.value) return
  const target: SplitTarget = selectedKind.value === 'local'
    ? { kind: 'local' }
    : { kind: 'ssh', sessionId: selectedSessionId.value }
  emit('confirm', direction.value, target)
}

function handleCancel() {
  emit('cancel')
}

function handleKey(e: KeyboardEvent) {
  if (!props.visible) return
  if (e.key === 'Escape') {
    e.preventDefault()
    handleCancel()
  } else if (e.key === 'Enter' && canConfirm.value) {
    e.preventDefault()
    handleConfirm()
  }
}

onMounted(() => window.addEventListener('keydown', handleKey))
onUnmounted(() => window.removeEventListener('keydown', handleKey))
</script>

<template>
  <Teleport to="body">
    <div v-if="visible" class="picker-overlay" @click.self="handleCancel">
      <div class="picker-dialog">
        <div class="picker-header">{{ t('terminal.split.target.title') }}</div>

        <div class="picker-section">
          <div class="picker-label">{{ t('terminal.split.target.directionLabel') }}</div>
          <div class="picker-tabs">
            <button
              class="picker-tab"
              :class="{ active: direction === 'horizontal' }"
              @click="direction = 'horizontal'"
            >
              ▬ {{ t('terminal.split.target.directionHorizontal') }}
            </button>
            <button
              class="picker-tab"
              :class="{ active: direction === 'vertical' }"
              @click="direction = 'vertical'"
            >
              ▮ {{ t('terminal.split.target.directionVertical') }}
            </button>
          </div>
        </div>

        <div class="picker-section">
          <div class="picker-label">{{ t('terminal.split.target.targetLabel') }}</div>
          <div class="picker-target-list">
            <button
              class="picker-target-item"
              :class="{ active: selectedKind === 'local' }"
              @click="selectedKind = 'local'"
              @dblclick="selectedKind = 'local'; handleConfirm()"
            >
              <span class="target-icon">💻</span>
              <span class="target-name">{{ t('terminal.split.target.local') }}</span>
            </button>

            <div v-if="sessions.length > 0" class="picker-section-divider">
              {{ t('terminal.split.target.sshSection') }}
            </div>

            <template v-for="[groupKey, groupSessions] in sessionsByGroup" :key="groupKey || '__nogroup__'">
              <div v-if="groupKey" class="picker-group-label">{{ groupKey }}</div>
              <button
                v-for="session in groupSessions"
                :key="session.id"
                class="picker-target-item"
                :class="{ active: selectedKind === 'ssh' && selectedSessionId === session.id }"
                @click="selectedKind = 'ssh'; selectedSessionId = session.id"
                @dblclick="selectedKind = 'ssh'; selectedSessionId = session.id; handleConfirm()"
              >
                <span class="target-icon">🌐</span>
                <span class="target-name">{{ session.name }}</span>
                <span class="target-meta">{{ session.username }}@{{ session.host }}{{ session.port !== 22 ? `:${session.port}` : '' }}</span>
              </button>
            </template>

            <div v-if="sessions.length === 0" class="picker-empty">
              {{ t('terminal.split.target.noSessions') }}
            </div>
          </div>
        </div>

        <div class="picker-footer">
          <button class="picker-btn picker-btn-cancel" @click="handleCancel">{{ t('terminal.split.target.cancel') }}</button>
          <button class="picker-btn picker-btn-confirm" :disabled="!canConfirm" @click="handleConfirm">{{ t('terminal.split.target.confirm') }}</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.picker-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 9999;
}

.picker-dialog {
  background: var(--bg-secondary, #2a2a2a);
  color: var(--text-primary, #e0e0e0);
  border: 1px solid var(--border-color, #404040);
  border-radius: 8px;
  width: 420px;
  max-width: 90vw;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
}

.picker-header {
  font-size: 14px;
  font-weight: 600;
  padding: 14px 16px;
  border-bottom: 1px solid var(--border-color, #404040);
}

.picker-section {
  padding: 12px 16px;
}

.picker-section + .picker-section {
  border-top: 1px solid var(--border-color, #404040);
}

.picker-label {
  font-size: 12px;
  color: var(--text-secondary, #a0a0a0);
  margin-bottom: 6px;
}

.picker-tabs {
  display: flex;
  gap: 6px;
}

.picker-tab {
  flex: 1;
  padding: 8px 12px;
  background: var(--bg-tertiary, #1f1f1f);
  border: 1px solid var(--border-color, #404040);
  border-radius: 4px;
  color: inherit;
  cursor: pointer;
  font-size: 13px;
  transition: background 0.15s ease, border-color 0.15s ease;
}

.picker-tab:hover {
  background: var(--bg-hover, #333);
}

.picker-tab.active {
  background: var(--accent-primary, #4299e1);
  border-color: var(--accent-primary, #4299e1);
  color: #fff;
}

.picker-target-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 320px;
  overflow-y: auto;
}

.picker-target-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  background: var(--bg-tertiary, #1f1f1f);
  border: 1px solid transparent;
  border-radius: 4px;
  color: inherit;
  cursor: pointer;
  text-align: left;
  font-size: 13px;
  transition: background 0.15s ease, border-color 0.15s ease;
}

.picker-target-item:hover {
  background: var(--bg-hover, #333);
}

.picker-target-item.active {
  background: var(--accent-primary, #4299e1);
  border-color: var(--accent-primary, #4299e1);
  color: #fff;
}

.target-icon {
  flex-shrink: 0;
  font-size: 14px;
}

.target-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.target-meta {
  flex-shrink: 0;
  font-size: 11px;
  opacity: 0.7;
  font-family: monospace;
}

.picker-section-divider {
  font-size: 11px;
  color: var(--text-secondary, #a0a0a0);
  margin: 8px 0 4px;
  padding-left: 4px;
}

.picker-group-label {
  font-size: 11px;
  color: var(--text-secondary, #a0a0a0);
  padding: 6px 4px 2px;
}

.picker-empty {
  font-size: 12px;
  color: var(--text-secondary, #a0a0a0);
  padding: 12px;
  text-align: center;
  font-style: italic;
}

.picker-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--border-color, #404040);
}

.picker-btn {
  padding: 7px 16px;
  border-radius: 4px;
  border: 1px solid var(--border-color, #404040);
  background: var(--bg-tertiary, #1f1f1f);
  color: inherit;
  cursor: pointer;
  font-size: 13px;
  transition: background 0.15s ease;
}

.picker-btn:hover:not(:disabled) {
  background: var(--bg-hover, #333);
}

.picker-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.picker-btn-confirm {
  background: var(--accent-primary, #4299e1);
  border-color: var(--accent-primary, #4299e1);
  color: #fff;
}

.picker-btn-confirm:hover:not(:disabled) {
  background: var(--accent-primary-hover, #3182ce);
}
</style>
