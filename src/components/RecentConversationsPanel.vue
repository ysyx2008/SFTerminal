<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Pin } from 'lucide-vue-next'
import type { AgentHistorySummary, AgentRecord } from '@shared/types'
import ConversationRow from './ConversationRow.vue'
import { useConfigStore } from '../stores/config'
import { useTerminalStore } from '../stores/terminal'
import { toast } from '../composables/useToast'

const { t, locale } = useI18n()
const configStore = useConfigStore()
const terminalStore = useTerminalStore()

const props = defineProps<{
  visible?: boolean
}>()

const searchText = ref('')
const summaries = ref<AgentHistorySummary[]>([])
const isLoading = ref(false)
const openingId = ref<string | null>(null)
const DISPLAY_LIMIT = 50
const displayCount = ref(DISPLAY_LIMIT)

const editingId = ref<string | null>(null)
const editingTitle = ref('')

const summaryById = computed(() => {
  const map = new Map<string, AgentHistorySummary>()
  for (const s of summaries.value) map.set(s.id, s)
  return map
})

const matchesSearch = (record: AgentHistorySummary, kw: string): boolean => {
  if (!kw) return true
  const display = configStore.getConversationDisplayTitle(record.id)
  const haystack = [record.userTask, display].filter(Boolean).join(' ').toLowerCase()
  return haystack.includes(kw)
}

const filteredSummaries = computed(() => {
  const kw = searchText.value.trim().toLowerCase()
  const sorted = [...summaries.value].sort(
    (a, b) => (b.timestamp + b.duration) - (a.timestamp + a.duration)
  )
  if (!kw) return sorted
  return sorted.filter(s => matchesSearch(s, kw))
})

const pinnedItems = computed(() => {
  const kw = searchText.value.trim().toLowerCase()
  return configStore.pinnedConversationIds
    .map(id => summaryById.value.get(id))
    .filter((s): s is AgentHistorySummary => !!s && matchesSearch(s, kw))
})

const unpinnedForGrouping = computed(() => {
  const pinnedSet = new Set(configStore.pinnedConversationIds)
  return filteredSummaries.value.filter(s => !pinnedSet.has(s.id))
})

const visibleUnpinned = computed(() => unpinnedForGrouping.value.slice(0, displayCount.value))
const hasMore = computed(() => displayCount.value < unpinnedForGrouping.value.length)

interface DateGroup {
  key: string
  label: string
  items: AgentHistorySummary[]
}

const getDateKey = (ts: number) => {
  const d = new Date(ts)
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
}

const dateGroupLabel = (dateKey: string, activeAt: number): string => {
  const today = getDateKey(Date.now())
  const yesterday = getDateKey(Date.now() - 86400000)
  if (dateKey === today) return t('watch.today')
  if (dateKey === yesterday) return t('watch.yesterday')
  const localeTag = locale.value.startsWith('zh') ? 'zh-CN' : 'en-US'
  return new Date(activeAt).toLocaleDateString(localeTag, { month: 'short', day: 'numeric' })
}

const groupedSummaries = computed((): DateGroup[] => {
  const groups: DateGroup[] = []
  let currentKey = ''
  for (const item of visibleUnpinned.value) {
    const activeAt = item.timestamp + item.duration
    const key = getDateKey(activeAt)
    if (key !== currentKey) {
      currentKey = key
      groups.push({ key, label: dateGroupLabel(key, activeAt), items: [] })
    }
    groups[groups.length - 1].items.push(item)
  }
  return groups
})

const hasListContent = computed(
  () => pinnedItems.value.length > 0 || groupedSummaries.value.length > 0
)

const loadSummaries = async () => {
  if (isLoading.value || editingId.value) return
  isLoading.value = true
  try {
    await configStore.loadConversationPreferences()
    summaries.value = await window.electronAPI.history.listAgentSummaries(true)
    displayCount.value = DISPLAY_LIMIT
    if (summaries.value.length > 0) {
      await configStore.pruneConversationMetadata(new Set(summaries.value.map(s => s.id)))
    }
  } catch (e) {
    console.error('Failed to load conversation summaries:', e)
    summaries.value = []
  } finally {
    isLoading.value = false
  }
}

watch(
  () => props.visible,
  (show) => {
    if (show) void loadSummaries()
  },
  { immediate: true }
)

watch(searchText, () => {
  displayCount.value = DISPLAY_LIMIT
})

const formatTime = (timestamp: number): string => {
  const date = new Date(timestamp)
  const now = new Date()
  const isToday = date.toDateString() === now.toDateString()
  const localeTag = locale.value.startsWith('zh') ? 'zh-CN' : 'en-US'
  if (isToday) {
    return date.toLocaleTimeString(localeTag, { hour: '2-digit', minute: '2-digit' })
  }
  return date.toLocaleDateString(localeTag, { month: 'numeric', day: 'numeric' })
}

const openConversation = async (summary: AgentHistorySummary) => {
  if (editingId.value || openingId.value) return
  openingId.value = summary.id
  try {
    const record = (await window.electronAPI.history.getAgentRecordById(summary.id)) as AgentRecord | undefined
    if (!record) {
      toast.error(t('ai.agentWelcome.historyRecordMissing'))
      return
    }
    const tabId = terminalStore.createAssistantTab()
    const customTitle = configStore.getConversationDisplayTitle(summary.id)
    if (customTitle) {
      terminalStore.renameTab(tabId, customTitle)
    }
    terminalStore.restoreAgentHistory(tabId, record)
  } catch (e) {
    console.error('Failed to open conversation:', e)
    toast.error(t('ai.agentWelcome.historyRecordMissing'))
  } finally {
    openingId.value = null
  }
}

const togglePin = async (event: MouseEvent, id: string) => {
  event.stopPropagation()
  try {
    await configStore.togglePinConversation(id)
  } catch (e) {
    console.error('Failed to toggle pin:', e)
    toast.error(t('common.operationFailed'))
  }
}

const startRename = (record: AgentHistorySummary, event: MouseEvent) => {
  event.stopPropagation()
  editingId.value = record.id
  editingTitle.value = configStore.resolveConversationTitle(record.id, record.userTask)
}

const commitRename = async () => {
  const id = editingId.value
  if (!id) return
  const next = editingTitle.value.trim()
  try {
    await configStore.setConversationDisplayTitle(id, next)
  } catch (e) {
    console.error('Failed to rename conversation:', e)
    toast.error(t('common.operationFailed'))
  } finally {
    editingId.value = null
  }
}

const cancelRename = () => {
  editingId.value = null
}

const loadMore = () => {
  displayCount.value += DISPLAY_LIMIT
}
</script>

<template>
  <div class="conversation-panel">
    <div class="panel-toolbar">
      <input
        v-model="searchText"
        type="text"
        class="input search-input"
        :placeholder="t('welcome.conversations.searchPlaceholder')"
      />
    </div>

    <div class="conversation-list">
      <div v-if="isLoading" class="empty-state">
        {{ t('ai.agentWelcome.historyLoading') }}
      </div>

      <template v-else-if="hasListContent">
        <section v-if="pinnedItems.length > 0" class="list-section list-section--pinned">
          <div class="section-header">
            <Pin :size="11" class="section-icon" />
            <span class="section-name">{{ t('welcome.conversations.pinned') }}</span>
          </div>
          <div class="section-items">
            <ConversationRow
              v-for="record in pinnedItems"
              :key="`pin-${record.id}`"
              :record="record"
              is-pinned
              :is-opening="openingId === record.id"
              :is-editing="editingId === record.id"
              :editing-title="editingTitle"
              :formatted-time="formatTime(record.timestamp + record.duration)"
              @open="openConversation(record)"
              @toggle-pin="togglePin($event, record.id)"
              @start-rename="startRename(record, $event)"
              @commit-rename="commitRename"
              @cancel-rename="cancelRename"
              @update:editing-title="editingTitle = $event"
            />
          </div>
        </section>

        <section
          v-for="group in groupedSummaries"
          :key="group.key"
          class="list-section"
        >
          <div class="section-header">
            <span class="section-name">{{ group.label }}</span>
          </div>
          <div class="section-items">
            <ConversationRow
              v-for="record in group.items"
              :key="record.id"
              :record="record"
              :is-opening="openingId === record.id"
              :is-editing="editingId === record.id"
              :editing-title="editingTitle"
              :formatted-time="formatTime(record.timestamp + record.duration)"
              @open="openConversation(record)"
              @toggle-pin="togglePin($event, record.id)"
              @start-rename="startRename(record, $event)"
              @commit-rename="commitRename"
              @cancel-rename="cancelRename"
              @update:editing-title="editingTitle = $event"
            />
          </div>
        </section>

        <button v-if="hasMore" type="button" class="load-more-btn" @click="loadMore">
          {{ t('welcome.conversations.loadMore') }}
        </button>
      </template>

      <div v-else class="empty-state">
        <template v-if="searchText.trim()">
          <p>{{ t('welcome.conversations.noMatching') }}</p>
        </template>
        <template v-else>
          <p>{{ t('ai.agentWelcome.noRecentHistory') }}</p>
          <p class="tip">{{ t('welcome.conversations.emptyHint') }}</p>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.conversation-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.panel-toolbar {
  padding: 8px 10px;
  border-bottom: 1px solid color-mix(in srgb, var(--border-color) 70%, transparent);
}

.search-input {
  width: 100%;
  height: 28px;
  padding: 0 8px;
  font-size: 12px;
  color: var(--text-secondary);
  background: color-mix(in srgb, var(--bg-surface) 60%, transparent);
  border-color: color-mix(in srgb, var(--border-color) 80%, transparent);
  box-sizing: border-box;
}

.search-input::placeholder {
  color: var(--text-muted);
  opacity: 0.85;
}

.conversation-list {
  flex: 1;
  overflow-y: auto;
  padding: 6px 8px 12px;
}

.list-section {
  margin-bottom: 4px;
  padding-top: 8px;
  border-top: 1px solid color-mix(in srgb, var(--border-color) 55%, transparent);
}

.list-section:first-child {
  padding-top: 2px;
  border-top: none;
}

.section-header {
  display: flex;
  align-items: center;
  gap: 5px;
  height: 24px;
  padding: 0 8px;
  margin-bottom: 2px;
}

.section-icon {
  flex-shrink: 0;
  color: var(--text-muted);
  opacity: 0.75;
}

.section-name {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--text-secondary);
}

.section-items {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding-left: 10px;
}

.load-more-btn {
  display: block;
  width: 100%;
  margin-top: 8px;
  padding: 4px;
  font-size: 11px;
  font-family: inherit;
  color: var(--text-muted);
  opacity: 0.75;
  background: transparent;
  border: none;
  cursor: pointer;
}

.load-more-btn:hover {
  opacity: 1;
}

.empty-state {
  padding: 32px 16px;
  text-align: center;
  color: var(--text-muted);
  font-size: 12px;
  opacity: 0.85;
}

.empty-state .tip {
  margin-top: 6px;
  font-size: 11px;
  opacity: 0.7;
  line-height: 1.5;
}
</style>
