<script setup lang="ts">
import { computed, ref, watch, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { Pin, PinOff, Loader2, CircleDot } from 'lucide-vue-next'
import type { AgentHistorySummary } from '@shared/types'
import type { HistoryConversationTabStatus } from '../stores/terminal'
import { useConfigStore } from '../stores/config'

const props = defineProps<{
  record: AgentHistorySummary
  isPinned?: boolean
  isOpening?: boolean
  tabStatus?: HistoryConversationTabStatus
  statusTooltip?: string
  isEditing?: boolean
  editingTitle?: string
  formattedTime: string
  /** 侧栏静默刷新后新出现的行：淡入动画 */
  fadeIn?: boolean
}>()

const emit = defineEmits<{
  open: []
  'toggle-pin': [event: MouseEvent]
  'context-menu': [event: MouseEvent]
  'commit-rename': []
  'cancel-rename': []
  'update:editingTitle': [value: string]
}>()

const { t } = useI18n()
const configStore = useConfigStore()

const tabStatus = computed(() => props.tabStatus ?? 'closed')
const showStatusIcon = computed(() => tabStatus.value !== 'closed')

const handleItemClick = () => {
  if (props.isOpening || props.isEditing) return
  emit('open')
}

const handleContextMenu = (event: MouseEvent) => {
  if (props.isEditing) return
  event.preventDefault()
  emit('context-menu', event)
}

const normalizeTitle = (text: string): string => text.trim().replace(/\s+/g, ' ')

const displayTitle = computed(() =>
  normalizeTitle(configStore.resolveConversationTitle(props.record.id, props.record.userTask))
)

const editInputRef = ref<HTMLInputElement | null>(null)

watch(
  () => props.isEditing,
  async (editing) => {
    if (!editing) return
    await nextTick()
    const input = editInputRef.value
    if (!input) return
    input.focus()
    input.select()
  },
  { flush: 'post' }
)

const handleRenameKeydown = (event: KeyboardEvent) => {
  if (event.key === 'Enter') {
    event.preventDefault()
    emit('commit-rename')
  } else if (event.key === 'Escape') {
    emit('cancel-rename')
  }
}
</script>

<template>
  <div
    class="conversation-row"
    :class="{
      'is-pinned': isPinned,
      'is-opening': isOpening,
      'is-failed': record.status === 'failed',
      'is-aborted': record.status === 'aborted',
      'needs-attention': tabStatus === 'attention',
      'is-fade-in': fadeIn,
    }"
  >
    <div class="leading-slot">
      <button
        type="button"
        class="pin-btn"
        :class="{ 'is-visible': isPinned }"
        :title="isPinned ? t('welcome.conversations.unpin') : t('welcome.conversations.pin')"
        @click="emit('toggle-pin', $event)"
      >
        <PinOff v-if="isPinned" :size="12" />
        <Pin v-else :size="12" />
      </button>
      <span
        v-if="showStatusIcon"
        class="status-indicator"
        :class="`status-${tabStatus}`"
        :title="statusTooltip"
        :aria-label="statusTooltip"
        role="img"
      >
        <Loader2 v-if="tabStatus === 'running'" class="status-spinner" :size="11" />
        <span v-else-if="tabStatus === 'attention'" class="attention-dot" />
        <CircleDot v-else :size="11" :stroke-width="2" />
      </span>
    </div>
    <button
      type="button"
      class="conversation-item"
      :disabled="isOpening"
      :title="record.userTask"
      @click="handleItemClick"
      @contextmenu="handleContextMenu"
    >
      <input
        v-if="isEditing"
        ref="editInputRef"
        :value="editingTitle"
        class="title-input"
        :placeholder="t('welcome.conversations.renameClearHint')"
        @input="emit('update:editingTitle', ($event.target as HTMLInputElement).value)"
        @click.stop
        @keydown="handleRenameKeydown"
        @blur="emit('commit-rename')"
      />
      <span
        v-else
        class="item-title"
        :title="displayTitle"
      >{{ displayTitle }}</span>
      <span class="item-time">{{ formattedTime }}</span>
    </button>
  </div>
</template>

<style scoped>
.conversation-row {
  display: flex;
  align-items: center;
  gap: 0;
  border-radius: 5px;
  transition: background 0.12s ease, opacity 0.12s ease;
}

.conversation-row.is-opening {
  opacity: 0.55;
  pointer-events: none;
}

.conversation-row.is-fade-in {
  animation: conversation-row-fade-in 0.42s ease-out;
}

@keyframes conversation-row-fade-in {
  from {
    opacity: 0;
    transform: translateY(-5px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.conversation-row:hover {
  background: color-mix(in srgb, var(--bg-surface) 75%, transparent);
}

.conversation-row:hover .pin-btn {
  opacity: 0.65;
}

.conversation-row:hover .status-indicator {
  opacity: 0;
  pointer-events: none;
}

.conversation-row:hover .item-title {
  color: var(--text-secondary);
}

.conversation-row.needs-attention {
  background: rgba(var(--color-warning-rgb), 0.1);
}

.conversation-row.needs-attention .item-title {
  color: var(--color-warning);
}

/* 置顶与状态图标共用左侧 20px 槽位（始终保留缩进，与改版前 pin 列一致） */
.leading-slot {
  position: relative;
  flex-shrink: 0;
  width: 20px;
  height: 28px;
}

.pin-btn {
  position: absolute;
  inset: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  color: var(--text-muted);
  background: transparent;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  opacity: 0;
  z-index: 2;
  transition: opacity 0.12s ease, color 0.12s ease, background 0.12s ease;
}

.pin-btn.is-visible {
  opacity: 0.55;
}

.pin-btn:hover {
  opacity: 1 !important;
  color: var(--text-secondary);
  background: color-mix(in srgb, var(--bg-hover, var(--bg-surface)) 80%, transparent);
}

.status-indicator {
  position: absolute;
  inset: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  z-index: 1;
  transition: opacity 0.12s ease;
}

.status-open {
  color: var(--accent-primary);
  opacity: 0.85;
}

.status-running {
  color: var(--accent-primary);
}

.status-attention {
  color: var(--color-warning);
}

.status-spinner {
  animation: spin 1s linear infinite;
}

.attention-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--color-warning);
  animation: attention-pulse 1.5s ease-in-out infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

@keyframes attention-pulse {
  0%, 100% {
    box-shadow: 0 0 0 0 rgba(var(--color-warning-rgb), 0.45);
  }
  50% {
    box-shadow: 0 0 0 4px rgba(var(--color-warning-rgb), 0);
  }
}

.conversation-item {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  height: 28px;
  padding: 0 4px 0 0;
  font-family: inherit;
  text-align: left;
  background: transparent;
  border: none;
  border-radius: 5px;
  cursor: pointer;
}

.conversation-item:disabled {
  cursor: wait;
}

.conversation-row.is-failed .item-title,
.conversation-row.is-aborted .item-title {
  opacity: 0.65;
}

.item-title {
  flex: 1;
  min-width: 0;
  font-size: 12.5px;
  font-weight: 400;
  line-height: 1.2;
  color: var(--text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  transition: color 0.12s ease;
}

.title-input {
  flex: 1;
  min-width: 0;
  height: 22px;
  padding: 0 4px;
  font-size: 12.5px;
  font-family: inherit;
  color: var(--text-primary);
  background: var(--bg-primary);
  border: 1px solid var(--accent-primary);
  border-radius: 4px;
  box-sizing: border-box;
}

.item-time {
  flex-shrink: 0;
  font-size: 10.5px;
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
  opacity: 0.6;
}
</style>
