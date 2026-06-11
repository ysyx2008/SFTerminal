<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Pin, Search, X } from 'lucide-vue-next'
import type { AgentHistorySummary, AgentRecord } from '@shared/types'
import ConversationRow from './ConversationRow.vue'
import { useConfigStore } from '../stores/config'
import { useTerminalStore } from '../stores/terminal'
import { toast } from '../composables/useToast'
import { showConfirm } from '../composables/useConfirm'

const { t, locale } = useI18n()
const configStore = useConfigStore()
const terminalStore = useTerminalStore()

const searchText = ref('')
const searchExpanded = ref(false)
const searchInputRef = ref<HTMLInputElement | null>(null)
const summaries = ref<AgentHistorySummary[]>([])
const isLoading = ref(false)
const openingId = ref<string | null>(null)
const hasLoaded = ref(false)
const DISPLAY_LIMIT = 20
const LOAD_MORE_STEP = 20
const displayCount = ref(DISPLAY_LIMIT)

const editingId = ref<string | null>(null)
const editingTitle = ref('')

const contextMenu = ref<{
  show: boolean
  x: number
  y: number
  record: AgentHistorySummary | null
}>({
  show: false,
  x: 0,
  y: 0,
  record: null,
})

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

const ensureLoaded = () => {
  if (hasLoaded.value) return
  hasLoaded.value = true
  void loadSummaries()
}

onMounted(() => {
  ensureLoaded()
})

watch(searchText, () => {
  displayCount.value = DISPLAY_LIMIT
})

const openSearch = async () => {
  searchExpanded.value = true
  await nextTick()
  searchInputRef.value?.focus()
}

const closeSearch = () => {
  searchExpanded.value = false
  searchText.value = ''
}

const toggleSearch = () => {
  if (searchExpanded.value) {
    if (searchText.value.trim()) {
      searchText.value = ''
      searchInputRef.value?.focus()
    } else {
      closeSearch()
    }
  } else {
    void openSearch()
  }
}

const handleSearchBlur = () => {
  if (!searchText.value.trim()) {
    closeSearch()
  }
}

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
    terminalStore.markAssistantSkipOnboarding(tabId)
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

const openContextMenu = (record: AgentHistorySummary, event: MouseEvent) => {
  contextMenu.value = {
    show: true,
    x: event.clientX,
    y: event.clientY,
    record,
  }
}

const closeContextMenu = () => {
  contextMenu.value.show = false
  contextMenu.value.record = null
}

const startRename = (record: AgentHistorySummary) => {
  editingId.value = record.id
  editingTitle.value = configStore.resolveConversationTitle(record.id, record.userTask)
}

const onMenuRename = () => {
  const record = contextMenu.value.record
  closeContextMenu()
  if (record) startRename(record)
}

const onMenuTogglePin = async () => {
  const record = contextMenu.value.record
  closeContextMenu()
  if (!record) return
  try {
    await configStore.togglePinConversation(record.id)
  } catch (e) {
    console.error('Failed to toggle pin:', e)
    toast.error(t('common.operationFailed'))
  }
}

const onMenuDelete = async () => {
  const record = contextMenu.value.record
  closeContextMenu()
  if (!record) return

  const title = configStore.resolveConversationTitle(record.id, record.userTask)
  const confirmed = await showConfirm({
    title: t('welcome.conversations.deleteTitle'),
    message: t('welcome.conversations.confirmDelete', { title }),
    type: 'danger',
    confirmText: t('welcome.conversations.delete'),
    cancelText: t('common.cancel'),
  })
  if (!confirmed) return

  try {
    const deleted = await window.electronAPI.history.deleteAgentRecord(record.id)
    if (!deleted) {
      toast.error(t('ai.agentWelcome.historyRecordMissing'))
      return
    }
    summaries.value = summaries.value.filter(s => s.id !== record.id)
    await configStore.pruneConversationMetadata(new Set(summaries.value.map(s => s.id)))
    if (editingId.value === record.id) {
      editingId.value = null
    }
  } catch (e) {
    console.error('Failed to delete conversation:', e)
    toast.error(t('common.operationFailed'))
  }
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
  displayCount.value += LOAD_MORE_STEP
}
</script>

<template>
  <div class="conversation-panel">
    <div class="panel-header" :class="{ 'is-search-open': searchExpanded }">
      <span v-if="!searchExpanded" class="panel-title">{{ t('header.recentConversations') }}</span>
      <input
        v-else
        ref="searchInputRef"
        v-model="searchText"
        type="text"
        class="input search-input"
        :placeholder="t('welcome.conversations.searchPlaceholder')"
        @blur="handleSearchBlur"
        @keydown.escape.prevent="closeSearch()"
      />
      <button
        type="button"
        class="search-toggle"
        :title="searchExpanded ? t('welcome.conversations.searchClose') : t('welcome.conversations.searchOpen')"
        @click="toggleSearch"
      >
        <X v-if="searchExpanded" :size="14" />
        <Search v-else :size="14" />
      </button>
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
              @context-menu="openContextMenu(record, $event)"
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
              @context-menu="openContextMenu(record, $event)"
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

    <Teleport to="body">
      <div v-if="contextMenu.show" class="context-menu-overlay" @click="closeContextMenu" />
      <div
        v-if="contextMenu.show"
        class="context-menu"
        :style="{ left: contextMenu.x + 'px', top: contextMenu.y + 'px' }"
        @click.stop
        @contextmenu.prevent
      >
        <button type="button" class="context-menu-item" @click="onMenuRename">
          {{ t('welcome.conversations.rename') }}
        </button>
        <button type="button" class="context-menu-item" @click="onMenuTogglePin">
          {{
            contextMenu.record && configStore.pinnedConversationIds.includes(contextMenu.record.id)
              ? t('welcome.conversations.unpin')
              : t('welcome.conversations.pin')
          }}
        </button>
        <div class="context-menu-separator" role="separator" />
        <button type="button" class="context-menu-item danger" @click="onMenuDelete">
          {{ t('welcome.conversations.delete') }}
        </button>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.conversation-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.panel-header {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 36px;
  padding: 0 8px 0 10px;
  flex-shrink: 0;
  border-bottom: 1px solid color-mix(in srgb, var(--border-color) 70%, transparent);
}

.panel-header.is-search-open {
  padding-left: 8px;
}

.panel-title {
  flex: 1;
  min-width: 0;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-muted);
  letter-spacing: 0.04em;
  text-transform: uppercase;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.search-input {
  flex: 1;
  min-width: 0;
  height: 26px;
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

.search-toggle {
  flex-shrink: 0;
  width: 26px;
  height: 26px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  color: var(--text-muted);
  background: transparent;
  border: none;
  border-radius: 5px;
  cursor: pointer;
  transition: color 0.12s ease, background 0.12s ease;
}

.search-toggle:hover {
  color: var(--text-secondary);
  background: color-mix(in srgb, var(--bg-surface) 75%, transparent);
}

.conversation-list {
  flex: 1;
  overflow-y: auto;
  padding: 4px 8px 10px;
  scrollbar-width: thin;
  scrollbar-color: transparent transparent;
  transition: scrollbar-color 0.2s ease;
}

.conversation-list:hover {
  scrollbar-color: color-mix(in srgb, var(--text-muted) 40%, transparent) transparent;
}

.conversation-list::-webkit-scrollbar {
  width: 8px;
}

.conversation-list::-webkit-scrollbar-thumb {
  background: transparent;
  border-radius: 4px;
  border: 2px solid transparent;
  background-clip: padding-box;
}

.conversation-list:hover::-webkit-scrollbar-thumb {
  background: color-mix(in srgb, var(--text-muted) 40%, transparent);
  background-clip: padding-box;
}

.list-section {
  margin-bottom: 2px;
  padding-top: 6px;
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
  height: 22px;
  padding: 0 4px;
  margin-bottom: 1px;
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
}

.load-more-btn {
  display: block;
  width: 100%;
  margin-top: 6px;
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
  padding: 28px 16px;
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

.context-menu {
  position: fixed;
  min-width: 120px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.28);
  padding: 3px;
  z-index: 10000;
  animation: contextMenuFadeIn 0.1s ease;
}

@keyframes contextMenuFadeIn {
  from {
    opacity: 0;
    transform: scale(0.97);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}

.context-menu-overlay {
  position: fixed;
  inset: 0;
  z-index: 9999;
}

.context-menu-item {
  display: block;
  width: 100%;
  padding: 5px 10px;
  font-size: 12px;
  font-family: inherit;
  line-height: 1.25;
  color: var(--text-primary);
  text-align: left;
  background: transparent;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.12s ease, color 0.12s ease;
}

.context-menu-item:hover {
  background: var(--bg-hover);
}

.context-menu-item.danger {
  color: var(--accent-error);
}

.context-menu-item.danger:hover {
  background: rgba(244, 63, 94, 0.1);
  color: var(--accent-error);
}

.context-menu-separator {
  height: 1px;
  margin: 2px 6px;
  background: color-mix(in srgb, var(--border-color) 85%, transparent);
}
</style>
