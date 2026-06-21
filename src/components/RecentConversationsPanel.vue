<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronLeft, ChevronRight, Pin, Plus, Search, X, Radio } from 'lucide-vue-next'
import type { AgentHistorySummary, AgentRecord } from '@shared/types'
import type { HistoryConversationTabStatus } from '../stores/terminal'
import {
  CLOSED_HISTORY_CONVERSATION_META,
  formatHistoryConversationTooltip,
} from '../utils/agent-tab-ui-meta'
import ConversationRow from './ConversationRow.vue'
import { useConfigStore } from '../stores/config'
import { useTerminalStore, COMPANION_TAB_AGENT_ID } from '../stores/terminal'
import { toast } from '../composables/useToast'
import { showConfirm } from '../composables/useConfirm'
import { useOpenConversationInTab } from '../composables/useConversationDragDrop'

const props = defineProps<{
  collapsed?: boolean
}>()

const emit = defineEmits<{
  'toggle-collapse': []
}>()

const { t, locale } = useI18n()
const configStore = useConfigStore()
const terminalStore = useTerminalStore()

const searchText = ref('')
const searchExpanded = ref(false)
const searchInputRef = ref<HTMLInputElement | null>(null)
const summaries = ref<AgentHistorySummary[]>([])
const isLoading = ref(false)
const openingId = ref<string | null>(null)
const { openConversationInTab } = useOpenConversationInTab(openingId)
const hasLoaded = ref(false)

/** 新建对话：回到欢迎页，右侧清空等待输入 */
const handleNewConversation = () => {
  terminalStore.goToHome()
}

/** 联络常驻 tab */
const companionTab = computed(() =>
  terminalStore.tabs.find(t => t.agentId === COMPANION_TAB_AGENT_ID) ?? null
)

const isCompanionActive = computed(() =>
  !!companionTab.value && companionTab.value.id === terminalStore.activeTabId
)

const handleOpenCompanion = () => {
  if (!companionTab.value) return
  terminalStore.setActiveTab(companionTab.value.id)
}
const DISPLAY_LIMIT = 60
const LOAD_MORE_STEP = 40
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

/**
 * 正在进行中但尚未落盘到历史的"实时"会话（来自 terminalStore.tabs）。
 * 对话一启动就出现在列表中，完成后由 summaries 接管（sessionId 相同，两者不重复）。
 */
const liveSessionSummaries = computed((): AgentHistorySummary[] => {
  return terminalStore.tabs
    .filter(tab =>
      tab.type === 'assistant' &&
      !tab.isRemote &&
      !!tab.agentState?.userTask &&
      !!tab.agentState?.sessionId &&
      !summaryById.value.has(tab.agentState.sessionId)
    )
    .map(tab => ({
      id: tab.agentState!.sessionId!,
      timestamp: tab.agentState!.sessionStartTime ?? Date.now(),
      duration: 0,
      userTask: tab.agentState!.userTask!,
      terminalType: tab.type,
      status: 'completed' as const, // 运行状态来自 meta，status 字段不用于显示
    }))
    .sort((a, b) => b.timestamp - a.timestamp)
})

const matchesSearch = (record: AgentHistorySummary, kw: string): boolean => {
  if (!kw) return true
  const display = configStore.getConversationDisplayTitle(record.id)
  const haystack = [record.userTask, display].filter(Boolean).join(' ').toLowerCase()
  return haystack.includes(kw)
}

const filteredSummaries = computed(() => {
  const kw = searchText.value.trim().toLowerCase()
  // 实时会话放最前面，已完成历史按时间倒序排在后面
  const liveSorted = kw
    ? liveSessionSummaries.value.filter(s => matchesSearch(s, kw))
    : [...liveSessionSummaries.value]
  const sorted = [...summaries.value].sort(
    (a, b) => (b.timestamp + b.duration) - (a.timestamp + a.duration)
  )
  const histSorted = kw ? sorted.filter(s => matchesSearch(s, kw)) : sorted
  return [...liveSorted, ...histSorted]
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

/** 扁平列表（含分组标题） */
type HistoryListEntry =
  | { type: 'header'; key: string; label: string; showPinIcon?: boolean; withDivider?: boolean }
  | { type: 'row'; key: string; record: AgentHistorySummary; pinned?: boolean }

const flatListEntries = computed((): HistoryListEntry[] => {
  const entries: HistoryListEntry[] = []
  let headerCount = 0

  if (pinnedItems.value.length > 0) {
    entries.push({
      type: 'header',
      key: 'header-pinned',
      label: t('welcome.conversations.pinned'),
      showPinIcon: true,
      withDivider: headerCount++ > 0,
    })
    for (const record of pinnedItems.value) {
      entries.push({ type: 'row', key: record.id, record, pinned: true })
    }
  }

  for (const group of groupedSummaries.value) {
    entries.push({
      type: 'header',
      key: `header-${group.key}`,
      label: group.label,
      withDivider: headerCount++ > 0,
    })
    for (const record of group.items) {
      entries.push({ type: 'row', key: record.id, record })
    }
  }

  return entries
})

/** silent：后台增量刷新，不触发全屏 loading、不重置「加载更多」计数 */
const loadSummaries = async (options?: { silent?: boolean }) => {
  const silent = options?.silent ?? false
  if (editingId.value) return
  if (!silent && isLoading.value) return
  if (!silent) isLoading.value = true
  try {
    if (!silent) await configStore.loadConversationPreferences()
    const next = await window.electronAPI.history.listAgentSummaries(true)
    summaries.value = next
    if (!silent) {
      displayCount.value = DISPLAY_LIMIT
    }
    if (next.length > 0) {
      await configStore.pruneConversationMetadata(new Set(next.map(s => s.id)))
    }
  } catch (e) {
    console.error('Failed to load conversation summaries:', e)
    if (!silent) summaries.value = []
  } finally {
    if (!silent) isLoading.value = false
  }
}

const ensureLoaded = () => {
  if (hasLoaded.value) return
  hasLoaded.value = true
  void loadSummaries()
}

let cleanupAgentCompleteForHistory: (() => void) | null = null
let cleanupAgentErrorForHistory: (() => void) | null = null
let silentRefreshTimer: ReturnType<typeof setTimeout> | null = null

const scheduleSilentRefresh = () => {
  if (silentRefreshTimer) clearTimeout(silentRefreshTimer)
  silentRefreshTimer = setTimeout(() => {
    silentRefreshTimer = null
    void loadSummaries({ silent: true })
  }, 200)
}

onMounted(() => {
  ensureLoaded()
  // 新会话落盘后静默刷新侧栏，避免 isLoading 替换整表导致闪烁
  cleanupAgentCompleteForHistory = window.electronAPI.agent.onComplete(() => {
    scheduleSilentRefresh()
  })
  cleanupAgentErrorForHistory = window.electronAPI.agent.onError(() => {
    scheduleSilentRefresh()
  })
})

onUnmounted(() => {
  if (silentRefreshTimer) clearTimeout(silentRefreshTimer)
  cleanupAgentCompleteForHistory?.()
  cleanupAgentErrorForHistory?.()
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

const displayedRecordIds = computed(() => {
  const ids: string[] = []
  for (const r of pinnedItems.value) ids.push(r.id)
  for (const g of groupedSummaries.value) {
    for (const r of g.items) ids.push(r.id)
  }
  return ids
})

/**
 * 当前可见行的状态规则：
 * - 用户正在看的对话（Hub 焦点 / activeTab）：只显示 running 或无状态，不显示 attention
 * - 后台运行的对话：正常显示 running / attention
 * - 非提升 tab 的 open 状态：降级为 closed（无独立 tab 概念）
 */
const conversationMetaById = computed(() => {
  const historyMeta = terminalStore.historyConversationMetaBySessionId
  const map = new Map<string, { status: HistoryConversationTabStatus; tooltip: string }>()
  for (const id of displayedRecordIds.value) {
    const rawMeta = historyMeta.get(id) ?? CLOSED_HISTORY_CONVERSATION_META
    const tab = terminalStore.findTabByHistoryId(id)

    const isVisible = tab && (
      tab.id === terminalStore.activeTabId ||
      tab.id === terminalStore.hubFocusedAssistantTabId
    )

    let meta: HistoryConversationMeta
    if (isVisible) {
      // 用户正在看：只显示 running，其余均无需提醒
      const status: HistoryConversationTabStatus = rawMeta.status === 'running' ? 'running' : 'closed'
      meta = { ...CLOSED_HISTORY_CONVERSATION_META, status }
    } else if (!tab?.isPromoted && rawMeta.status === 'open') {
      // 非提升 tab 的 open 状态无意义，降级
      meta = CLOSED_HISTORY_CONVERSATION_META
    } else {
      meta = rawMeta
    }

    map.set(id, { status: meta.status, tooltip: formatHistoryConversationTooltip(meta, t) })
  }
  return map
})

const getRecordMeta = (id: string) =>
  conversationMetaById.value.get(id) ?? {
    status: 'closed' as const,
    tooltip: formatHistoryConversationTooltip(CLOSED_HISTORY_CONVERSATION_META, t),
  }

/**
 * 判断某条历史对话是否为当前"激活"状态：
 * - Hub 焦点（非提升）：当前在主区展示的会话
 * - promoted tab：当前 activeTabId 与该 tab 匹配
 * 用于侧栏高亮，仅视觉，不含状态图标语义。
 */
const isActiveSurface = (historyId: string): boolean => {
  const tab = terminalStore.findTabByHistoryId(historyId)
  if (!tab) return false
  if (tab.isPromoted) return terminalStore.activeTabId === tab.id
  // Hub 焦点：agentState.sessionId 对应 historyId
  const focused = terminalStore.hubFocusedTab
  return !!focused && focused.agentState?.sessionId === historyId
}

const openConversation = async (summary: AgentHistorySummary) => {
  if (editingId.value || openingId.value) return

  const existingTab = terminalStore.findTabByHistoryId(summary.id)
  if (existingTab) {
    // 已提升为独立 tab → 激活该 tab；否则在 Hub 主区聚焦（停留首页视图，侧栏保留）
    if (existingTab.isPromoted) {
      terminalStore.setActiveTab(existingTab.id)
    } else {
      terminalStore.focusHubConversation(existingTab.id)
    }
    return
  }

  openingId.value = summary.id
  try {
    const record = (await window.electronAPI.history.getAgentRecordById(summary.id)) as AgentRecord | undefined
    if (!record) {
      toast.error(t('ai.agentWelcome.historyRecordMissing'))
      return
    }
    terminalStore.openHistoryConversation(record)
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

const onMenuOpenInTab = async () => {
  const record = contextMenu.value.record
  closeContextMenu()
  if (!record) return
  await openConversationInTab(record.id)
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

const isHistoryOpenInTab = (historyId: string) => !!terminalStore.findTabByHistoryId(historyId)

/** 是否是当前在 Hub 主区聚焦的会话（用于高亮） */
const isHubFocused = (historyId: string): boolean => {
  const focused = terminalStore.hubFocusedTab
  if (!focused) return false
  return focused.agentState?.sessionId === historyId
}

const onMenuDelete = async () => {
  const record = contextMenu.value.record
  closeContextMenu()
  if (!record) return

  const existingTab = terminalStore.findTabByHistoryId(record.id)
  // 已提升为独立 tab：阻止删除，让用户先关 tab
  if (existingTab?.isPromoted) {
    toast.warning(t('welcome.conversations.deleteBlockedTabOpen'))
    return
  }

  // 实时会话（尚未落盘）：直接关闭 tab 即可，无需调 history.delete
  const isLiveSession = liveSessionSummaries.value.some(s => s.id === record.id)
  if (isLiveSession) {
    if (existingTab) {
      const title = configStore.resolveConversationTitle(record.id, record.userTask)
      const confirmed = await showConfirm({
        title: t('welcome.conversations.deleteTitle'),
        message: t('welcome.conversations.confirmDelete', { title }),
        type: 'danger',
        confirmText: t('welcome.conversations.delete'),
        cancelText: t('common.cancel'),
      })
      if (confirmed) {
        await terminalStore.closeTab(existingTab.id, true)
      }
    }
    return
  }

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
    // 清理 Hub 焦点 tab（非提升的 runtime tab）
    if (existingTab) {
      await terminalStore.closeTab(existingTab.id, true)
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
  <div class="conversation-panel" :class="{ 'is-collapsed': props.collapsed }">
    <!-- 折叠态：只显示展开按钮 -->
    <div v-if="props.collapsed" class="panel-header panel-header--collapsed">
      <button
        type="button"
        class="panel-action-btn"
        :title="t('welcome.conversations.expandSidebar')"
        @click="emit('toggle-collapse')"
      >
        <ChevronRight :size="14" />
      </button>
    </div>

    <!-- 展开态：正常 header -->
    <template v-else>
      <div class="panel-header" :class="{ 'is-search-open': searchExpanded }">
        <!-- 搜索展开时只显示输入框和关闭搜索按钮 -->
        <template v-if="searchExpanded">
          <input
            ref="searchInputRef"
            v-model="searchText"
            type="text"
            class="input search-input"
            :placeholder="t('welcome.conversations.searchPlaceholder')"
            @blur="handleSearchBlur"
            @keydown.escape.prevent="closeSearch()"
          />
          <button type="button" class="search-toggle" :title="t('welcome.conversations.searchClose')" @click="toggleSearch">
            <X :size="14" />
          </button>
        </template>
        <!-- 正常态：折叠（左侧固定）+ 新的对话按钮 + 搜索 -->
        <template v-else>
          <button
            type="button"
            class="panel-action-btn"
            :title="t('welcome.conversations.collapseSidebar')"
            @click="emit('toggle-collapse')"
          >
            <ChevronLeft :size="14" />
          </button>
          <button
            type="button"
            class="new-conversation-btn"
            @click="handleNewConversation"
          >
            <Plus :size="13" />
            <span>{{ t('welcome.conversations.newConversation') }}</span>
          </button>
          <button type="button" class="search-toggle" :title="t('welcome.conversations.searchOpen')" @click="toggleSearch">
            <Search :size="14" />
          </button>
        </template>
      </div>

    <div class="conversation-list">
      <!-- 联络常驻入口 -->
      <div
        v-if="companionTab"
        class="companion-entry"
        :class="{ active: isCompanionActive, 'needs-attention': !isCompanionActive && terminalStore.hasTabAgentAttention(companionTab.id) }"
        @click="handleOpenCompanion"
      >
        <span class="companion-entry-icon">
          <Radio :size="13" />
        </span>
        <span class="companion-entry-label">{{ t('tabs.reach', '联络') }}</span>
        <span v-if="terminalStore.hasTabAgentAttention(companionTab.id)" class="companion-entry-badge" />
      </div>

      <div v-if="isLoading && summaries.length === 0" class="empty-state">
        {{ t('ai.agentWelcome.historyLoading') }}
      </div>

      <template v-else-if="hasListContent">
        <div class="history-flat-list">
          <div
            v-for="entry in flatListEntries"
            :key="entry.key"
            class="history-flat-item"
            :class="{ 'history-flat-item--section-start': entry.type === 'header' && entry.withDivider }"
          >
            <div v-if="entry.type === 'header'" class="section-header">
              <Pin v-if="entry.showPinIcon" :size="11" class="section-icon" />
              <span class="section-name">{{ entry.label }}</span>
            </div>
            <ConversationRow
              v-else
              :record="entry.record"
              :is-pinned="entry.pinned"
              :is-opening="openingId === entry.record.id"
              :is-active="isActiveSurface(entry.record.id)"
              :tab-status="getRecordMeta(entry.record.id).status"
              :status-tooltip="getRecordMeta(entry.record.id).tooltip"
              :is-editing="editingId === entry.record.id"
              :editing-title="editingTitle"
              :formatted-time="formatTime(entry.record.timestamp + entry.record.duration)"
              @open="openConversation(entry.record)"
              @toggle-pin="togglePin($event, entry.record.id)"
              @context-menu="openContextMenu(entry.record, $event)"
              @commit-rename="commitRename"
              @cancel-rename="cancelRename"
              @update:editing-title="editingTitle = $event"
            />
          </div>
        </div>

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
    </template><!-- end v-else (展开态) -->

    <Teleport to="body">
      <div v-if="contextMenu.show" class="context-menu-overlay" @click="closeContextMenu" />
      <div
        v-if="contextMenu.show"
        class="context-menu"
        :style="{ left: contextMenu.x + 'px', top: contextMenu.y + 'px' }"
        @click.stop
        @contextmenu.prevent
      >
        <button type="button" class="context-menu-item" @click="onMenuOpenInTab">
          {{ t('welcome.conversations.openInTab') }}
        </button>
        <div class="context-menu-separator" role="separator" />
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
  gap: 4px;
  height: 36px;
  padding: 0 6px 0 8px;
  flex-shrink: 0;
  border-bottom: 1px solid color-mix(in srgb, var(--border-color) 70%, transparent);
}

.panel-header.is-search-open {
  padding-left: 8px;
}

.panel-header--collapsed {
  border-bottom: 1px solid color-mix(in srgb, var(--border-color) 70%, transparent);
}

.new-conversation-btn {
  flex: 1;
  min-width: 0;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 26px;
  padding: 0 8px;
  font-size: 12px;
  font-weight: 500;
  font-family: inherit;
  color: var(--text-secondary);
  background: color-mix(in srgb, var(--bg-surface) 60%, transparent);
  border: 1px solid color-mix(in srgb, var(--border-color) 70%, transparent);
  border-radius: 5px;
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  transition: background 0.12s ease, color 0.12s ease, border-color 0.12s ease;
}

.new-conversation-btn:hover {
  background: color-mix(in srgb, var(--bg-surface) 90%, transparent);
  color: var(--text-primary);
  border-color: var(--border-color);
}

.panel-action-btn {
  flex-shrink: 0;
  width: 24px;
  height: 24px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  color: var(--text-muted);
  background: transparent;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  transition: color 0.12s ease, background 0.12s ease;
}

.panel-action-btn:hover {
  color: var(--text-secondary);
  background: color-mix(in srgb, var(--bg-surface) 75%, transparent);
}

.conversation-panel.is-collapsed .conversation-list {
  display: none;
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

/* 联络常驻入口 */
.companion-entry {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 6px 8px;
  margin-bottom: 4px;
  border-radius: 6px;
  cursor: pointer;
  transition: background 0.12s ease, color 0.12s ease;
  user-select: none;
  position: relative;
}

.companion-entry:hover {
  background: color-mix(in srgb, var(--bg-surface) 80%, transparent);
}

.companion-entry.active {
  background: color-mix(in srgb, var(--accent-primary) 12%, var(--bg-surface));
  color: var(--accent-primary);
}

.companion-entry.needs-attention {
  animation: tab-attention-pulse-sidebar 1.5s ease-in-out infinite;
}

@keyframes tab-attention-pulse-sidebar {
  0%, 100% { background: transparent; }
  50% { background: rgba(var(--color-warning-rgb), 0.1); }
}

.companion-entry-icon {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  color: var(--accent-primary);
  opacity: 0.8;
}

.companion-entry.active .companion-entry-icon {
  opacity: 1;
}

.companion-entry-label {
  flex: 1;
  font-size: 12px;
  font-weight: 500;
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.companion-entry.active .companion-entry-label {
  color: var(--accent-primary);
  font-weight: 600;
}

.companion-entry-badge {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--color-warning);
  flex-shrink: 0;
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

.history-flat-list {
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.history-flat-item--section-start {
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px solid color-mix(in srgb, var(--border-color) 55%, transparent);
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
