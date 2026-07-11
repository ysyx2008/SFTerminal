<script setup lang="ts">
import { ref, onMounted, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { Search, Loader2 } from 'lucide-vue-next'
import type { AgentHistorySummary, AgentRecord } from '@shared/types'

defineProps<{
  allHistory: AgentHistorySummary[]
  isLoadingAllHistory: boolean
  isHistorySearchLoading: boolean
  historyFullTextSearchActive: boolean
  historySearchTotalMatched: number
  historySearchKeyword: string
  hasMoreHistory: boolean
  formatHistoryTime: (ts: number) => string
  resolveTitle: (record: { id: string; userTask: string }) => string
}>()

const emit = defineEmits<{
  'update:keyword': [keyword: string]
  'search': []
  'clear-search': []
  'load-more': []
  'select': [record: AgentHistorySummary | AgentRecord]
  'close': []
}>()

const { t } = useI18n()

const historySearchInputRef = ref<HTMLInputElement | null>(null)

onMounted(async () => {
  await nextTick()
  historySearchInputRef.value?.focus()
})

const truncateText = (text: string, maxLength: number): string => {
  if (text.length <= maxLength) return text
  return text.slice(0, maxLength) + '...'
}

const escapeHtml = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

const highlightHistoryTaskHtml = (text: string, keyword: string, maxLen: number): string => {
  const truncated = truncateText(text, maxLen)
  const kw = keyword.trim()
  if (!kw) return escapeHtml(truncated)
  const escaped = escapeHtml(truncated)
  const safeKw = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  try {
    return escaped.replace(
      new RegExp(safeKw, 'gi'),
      m => `<mark class="history-search-mark">${escapeHtml(m)}</mark>`
    )
  } catch {
    return escaped
  }
}
</script>

<template>
  <div class="history-modal-overlay" @click.self="emit('close')">
    <div class="history-modal">
      <div class="history-modal-header">
        <h3>📜 {{ t('ai.agentWelcome.recentHistory') }}</h3>
        <button class="history-modal-close" @click="emit('close')">×</button>
      </div>
      <div class="history-modal-search">
        <input
          ref="historySearchInputRef"
          type="search"
          class="history-search-input"
          :placeholder="t('ai.agentWelcome.historySearchPlaceholder')"
          :value="historySearchKeyword"
          autocomplete="off"
          @input="emit('update:keyword', ($event.target as HTMLInputElement).value)"
          @keydown.enter.prevent="emit('search')"
        />
        <button
          type="button"
          class="history-search-submit"
          :title="t('ai.agentWelcome.historySearchSubmit')"
          :disabled="isLoadingAllHistory || isHistorySearchLoading"
          @click="emit('search')"
        >
          <Search :size="18" />
        </button>
        <button
          v-if="historySearchKeyword.trim()"
          type="button"
          class="history-search-clear"
          :title="t('ai.agentWelcome.historySearchClear')"
          @click="emit('clear-search')"
        >
          ×
        </button>
      </div>
      <div
        v-if="
          historyFullTextSearchActive &&
          historySearchKeyword.trim() &&
          !isLoadingAllHistory &&
          isHistorySearchLoading
        "
        class="history-search-in-progress"
        role="status"
        aria-live="polite"
      >
        <Loader2 class="history-search-loader-icon" :size="16" aria-hidden="true" />
        <span>{{ t('ai.agentWelcome.historySearchLoading') }}</span>
      </div>
      <p
        v-else-if="
          historyFullTextSearchActive &&
          historySearchKeyword.trim() &&
          !isLoadingAllHistory
        "
        class="history-search-matched-hint"
      >
        {{ t('ai.agentWelcome.historySearchMatchedCount', { count: historySearchTotalMatched }) }}
      </p>
      <div class="history-modal-body">
        <div v-if="isLoadingAllHistory" class="history-loading">
          {{ t('ai.agentWelcome.historyLoading') }}
        </div>
        <div
          v-else-if="
            historyFullTextSearchActive &&
            isHistorySearchLoading &&
            allHistory.length === 0
          "
          class="history-search-wait-area"
        ></div>
        <div v-else-if="allHistory.length === 0" class="history-empty">
          {{
            historySearchKeyword.trim()
              ? t('ai.agentWelcome.noSearchResult')
              : t('ai.agentWelcome.noRecentHistory')
          }}
        </div>
        <div v-else class="history-modal-list">
          <div
            v-for="record in allHistory"
            :key="record.id"
            class="history-card"
            @click="emit('select', record)"
          >
            <span class="history-status-icon" :class="record.status">
              {{ record.status === 'completed' ? '✓' : record.status === 'failed' ? '✗' : '!' }}
            </span>
            <span
              class="history-task"
              v-html="highlightHistoryTaskHtml(resolveTitle(record), historySearchKeyword, 80)"
            />
            <span class="history-meta">
              <span v-if="record.terminalType === 'ssh'" class="history-ssh">{{ record.sshHost }}</span>
              <span class="history-time">{{ formatHistoryTime(record.timestamp + record.duration) }}</span>
            </span>
          </div>
          <button
            v-if="hasMoreHistory"
            class="history-load-more"
            type="button"
            :disabled="isHistorySearchLoading"
            @click="emit('load-more')"
          >
            {{ t('ai.agentWelcome.loadMore', '加载更多...') }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.history-modal-overlay {
  --history-modal-top-gap: max(48px, min(10vh, 88px));
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.6);
  backdrop-filter: blur(4px);
  display: flex;
  justify-content: center;
  align-items: flex-start;
  padding-top: var(--history-modal-top-gap);
  padding-bottom: 24px;
  box-sizing: border-box;
  overflow-y: auto;
  z-index: 1000;
  animation: modalOverlayIn 0.2s ease;
}

@keyframes modalOverlayIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

.history-modal {
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 16px;
  width: 90%;
  max-width: 600px;
  max-height: min(80vh, calc(100vh - var(--history-modal-top-gap) - 24px));
  display: flex;
  flex-direction: column;
  overflow: hidden;
  flex-shrink: 0;
  box-shadow: 0 20px 50px rgba(0, 0, 0, 0.3), 0 0 0 1px rgba(255, 255, 255, 0.05) inset;
  animation: modalSlideIn 0.3s cubic-bezier(0.16, 1, 0.3, 1);
}

@keyframes modalSlideIn {
  from {
    opacity: 0;
    transform: scale(0.95) translateY(10px);
  }
  to {
    opacity: 1;
    transform: scale(1) translateY(0);
  }
}

.history-modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 18px 24px;
  border-bottom: 1px solid var(--border-color);
  background: linear-gradient(180deg, var(--bg-surface) 0%, transparent 100%);
  flex-shrink: 0;
}

.history-modal-header h3 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
  letter-spacing: 0.2px;
}

.history-modal-close {
  background: var(--bg-hover);
  border: none;
  font-size: 18px;
  color: var(--text-secondary);
  cursor: pointer;
  width: 32px;
  height: 32px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s ease;
}

.history-modal-close:hover {
  background: var(--accent-error);
  color: white;
}

.history-modal-search {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 24px;
  border-bottom: 1px solid var(--border-color);
  background: var(--bg-secondary);
  flex-shrink: 0;
}

.history-search-in-progress {
  margin: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 36px;
  padding: 0 24px;
  font-size: 11px;
  color: var(--text-muted);
  line-height: 1.4;
  background: color-mix(in srgb, var(--accent-primary) 8%, var(--bg-secondary));
  border-bottom: 1px solid color-mix(in srgb, var(--border-color) 65%, transparent);
  flex-shrink: 0;
}

.history-search-loader-icon {
  flex-shrink: 0;
  animation: spin 0.9s linear infinite;
  color: color-mix(in srgb, var(--accent-primary) 75%, var(--text-muted));
}

.history-search-wait-area {
  flex: 1;
  min-height: 120px;
}

.history-search-matched-hint {
  margin: 0;
  display: flex;
  align-items: center;
  min-height: 36px;
  padding: 0 24px;
  font-size: 11px;
  color: var(--text-muted);
  line-height: 1.4;
  background: var(--bg-secondary);
  border-bottom: 1px solid color-mix(in srgb, var(--border-color) 65%, transparent);
  flex-shrink: 0;
}

.history-search-input {
  flex: 1;
  min-width: 0;
  padding: 10px 14px;
  font-size: 14px;
  color: var(--text-primary);
  background: var(--bg-surface);
  border: 1px solid var(--border-color);
  border-radius: 10px;
  outline: none;
  transition: border-color 0.15s ease;
}

.history-search-input:focus {
  border-color: color-mix(in srgb, var(--accent-primary) 55%, var(--border-color));
}

.history-search-input::-webkit-search-cancel-button {
  display: none;
}

.history-search-submit {
  flex-shrink: 0;
  width: 36px;
  height: 36px;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-primary);
  background: color-mix(in srgb, var(--accent-primary) 22%, var(--bg-hover));
  border: 1px solid color-mix(in srgb, var(--accent-primary) 35%, var(--border-color));
  border-radius: 10px;
  cursor: pointer;
  transition: background 0.15s ease, opacity 0.15s ease;
}

.history-search-submit:hover:not(:disabled) {
  background: color-mix(in srgb, var(--accent-primary) 32%, var(--bg-hover));
}

.history-search-submit:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.history-search-clear {
  flex-shrink: 0;
  width: 32px;
  height: 32px;
  padding: 0;
  font-size: 18px;
  line-height: 1;
  color: var(--text-secondary);
  background: var(--bg-hover);
  border: none;
  border-radius: 8px;
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
}

.history-search-clear:hover {
  background: var(--bg-active);
  color: var(--text-primary);
}

.history-modal-list .history-search-mark {
  background: color-mix(in srgb, var(--accent-primary) 38%, transparent);
  color: inherit;
  border-radius: 3px;
  padding: 0 2px;
}

.history-modal-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 20px 24px;
}

.history-modal-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.history-loading,
.history-empty {
  color: var(--text-muted);
  font-size: 12px;
  padding: 16px;
  text-align: center;
  background: var(--bg-surface);
  border-radius: 8px;
  border: 1px dashed var(--border-color);
}

.history-card {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  cursor: pointer;
  border-radius: 10px;
  background: var(--bg-surface);
  border: 1px solid var(--border-color);
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
  position: relative;
  overflow: hidden;
}

.history-card::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 3px;
  background: var(--accent-primary);
  opacity: 0;
  transition: opacity 0.2s ease;
}

.history-card:hover {
  border-color: color-mix(in srgb, var(--accent-primary) 40%, transparent);
  background: var(--bg-hover);
  transform: translateX(2px);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
}

.history-card:hover::before {
  opacity: 1;
}

.history-card:active {
  transform: translateX(2px) scale(0.99);
}

.history-status-icon {
  flex-shrink: 0;
  width: 20px;
  height: 20px;
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  font-weight: 700;
  transition: transform 0.2s ease;
}

.history-card:hover .history-status-icon {
  transform: scale(1.1);
}

.history-status-icon.completed {
  background: linear-gradient(135deg, rgba(var(--brand-vital-rgb), 0.2) 0%, rgba(var(--brand-vital-rgb), 0.1) 100%);
  color: var(--brand-vital);
  box-shadow: 0 0 0 1px rgba(var(--brand-vital-rgb), 0.3);
}

.history-status-icon.failed {
  background: linear-gradient(135deg, rgba(var(--color-error-rgb), 0.2) 0%, rgba(var(--color-error-rgb), 0.1) 100%);
  color: var(--color-error);
  box-shadow: 0 0 0 1px rgba(var(--color-error-rgb), 0.3);
}

.history-status-icon.aborted {
  background: linear-gradient(135deg, rgba(var(--color-warning-rgb), 0.2) 0%, rgba(var(--color-warning-rgb), 0.1) 100%);
  color: var(--color-warning);
  box-shadow: 0 0 0 1px rgba(var(--color-warning-rgb), 0.3);
}

.history-task {
  flex: 1;
  font-size: 12.5px;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 450;
  letter-spacing: 0.1px;
}

.history-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.history-ssh {
  font-size: 10px;
  color: var(--accent-primary);
  background: color-mix(in srgb, var(--accent-primary) 12%, transparent);
  padding: 2px 6px;
  border-radius: 4px;
  font-weight: 500;
}

.history-time {
  font-size: 11px;
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
  opacity: 0.8;
}

.history-load-more {
  width: 100%;
  padding: 10px;
  margin-top: 4px;
  border: 1px dashed var(--border-color);
  border-radius: 8px;
  background: transparent;
  color: var(--text-secondary);
  font-size: 13px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.history-load-more:hover:not(:disabled) {
  background: var(--bg-surface);
  color: var(--text-primary);
  border-color: var(--accent-primary);
}

.history-load-more:disabled {
  opacity: 0.5;
  cursor: default;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}
</style>
