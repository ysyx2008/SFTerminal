<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Pin, PinOff } from 'lucide-vue-next'
import type { AgentHistorySummary } from '@shared/types'
import { useConfigStore } from '../stores/config'

const props = defineProps<{
  record: AgentHistorySummary
  isPinned?: boolean
  isOpening?: boolean
  isEditing?: boolean
  editingTitle?: string
  formattedTime: string
}>()

const emit = defineEmits<{
  open: []
  'toggle-pin': [event: MouseEvent]
  'start-rename': [event: MouseEvent]
  'commit-rename': []
  'cancel-rename': []
  'update:editingTitle': [value: string]
}>()

const { t } = useI18n()
const configStore = useConfigStore()

const normalizeTitle = (text: string): string => text.trim().replace(/\s+/g, ' ')

const displayTitle = computed(() =>
  normalizeTitle(configStore.resolveConversationTitle(props.record.id, props.record.userTask))
)

const hasCustomTitle = computed(() => !!configStore.getConversationDisplayTitle(props.record.id))

const setEditInputRef = (el: unknown) => {
  const input = el as HTMLInputElement | null
  if (input && props.isEditing) {
    input.focus()
    input.select()
  }
}

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
    }"
  >
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
    <button
      type="button"
      class="conversation-item"
      :disabled="isOpening"
      :title="record.userTask"
      @click="emit('open')"
    >
      <input
        v-if="isEditing"
        :ref="setEditInputRef"
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
        :class="{ 'has-custom-title': hasCustomTitle }"
        :title="`${displayTitle}\n${t('welcome.conversations.doubleClickRename')}`"
        @dblclick.stop="emit('start-rename', $event)"
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

.conversation-row:hover {
  background: color-mix(in srgb, var(--bg-surface) 75%, transparent);
}

.conversation-row:hover .pin-btn {
  opacity: 0.65;
}

.conversation-row:hover .item-title {
  color: var(--text-secondary);
}

.pin-btn {
  flex-shrink: 0;
  width: 20px;
  height: 28px;
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

.conversation-row.is-pinned .item-title {
  color: var(--text-secondary);
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

.item-title.has-custom-title {
  color: var(--text-secondary);
  font-weight: 500;
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
