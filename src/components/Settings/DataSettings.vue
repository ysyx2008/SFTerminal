<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { marked } from 'marked'
import { Bot, HardDrive, CalendarRange, FolderOpen, History, Download, Upload, Trash2, Clock, AlertTriangle, Search, X, ChevronDown, ChevronRight, ExternalLink, Monitor, Server, Coins, ArrowUpRight, ArrowDownLeft, Zap } from 'lucide-vue-next'

const { t } = useI18n()
const isSteamBuild = __STEAM_BUILD__

import type { AgentRecord } from '@shared/types'

// 存储统计
const storageStats = ref<{
  chatFiles: number
  agentFiles: number
  totalSize: number
  oldestRecord?: string
  newestRecord?: string
} | null>(null)

// 数据目录路径
const dataPath = ref('')

// 加载状态
const isLoading = ref(false)
const isExporting = ref(false)
const isImporting = ref(false)

// 消息提示
const message = ref<{ type: 'success' | 'error'; text: string } | null>(null)

// ========== 历史记录查看 ==========
const showHistoryViewer = ref(false)
const historyLoading = ref(false)
const agentRecords = ref<AgentRecord[]>([])
const searchKeyword = ref('')
const selectedDateRange = ref<'today' | 'week' | 'month' | 'all'>('week')
const expandedAgentIds = ref<Set<string>>(new Set())

// 日期范围计算
const getDateRange = () => {
  const now = new Date()
  const today = now.toISOString().split('T')[0]
  
  switch (selectedDateRange.value) {
    case 'today':
      return { start: today, end: today }
    case 'week': {
      const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
      return { start: weekAgo.toISOString().split('T')[0], end: today }
    }
    case 'month': {
      const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
      return { start: monthAgo.toISOString().split('T')[0], end: today }
    }
    case 'all':
    default:
      return { start: undefined, end: undefined }
  }
}

// 加载历史记录
const loadHistory = async () => {
  historyLoading.value = true
  try {
    const { start, end } = getDateRange()
    agentRecords.value = await window.electronAPI.history.getAgentRecords(start, end) || []
  } catch (e) {
    console.error('Failed to load history:', e)
    showMessage('error', t('dataSettings.loadHistoryFailed'))
  } finally {
    historyLoading.value = false
  }
}

// 切换日期范围时加载
const switchDateRange = (range: 'today' | 'week' | 'month' | 'all') => {
  selectedDateRange.value = range
  loadHistory()
}

// 打开历史查看器
const openHistoryViewer = async () => {
  showHistoryViewer.value = true
  await loadHistory()
}

// 关闭历史查看器
const closeHistoryViewer = () => {
  showHistoryViewer.value = false
  agentRecords.value = []
  searchKeyword.value = ''
  expandedAgentIds.value.clear()
}

// 格式化时间
const formatTime = (timestamp: number) => {
  const { locale } = useI18n()
  const date = new Date(timestamp)
  return date.toLocaleString(locale.value, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
}

// 格式化时长
const formatDuration = (ms: number) => {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${(ms / 60000).toFixed(1)}min`
}

// 过滤 Agent 记录
const filteredAgentRecords = computed(() => {
  if (!searchKeyword.value.trim()) return agentRecords.value
  const keyword = searchKeyword.value.toLowerCase()
  return agentRecords.value.filter(r => 
    r.userTask.toLowerCase().includes(keyword) ||
    r.finalResult?.toLowerCase().includes(keyword) ||
    r.sshHost?.toLowerCase().includes(keyword)
  )
})

// 切换展开 Agent 详情
const toggleAgentExpand = (id: string) => {
  if (expandedAgentIds.value.has(id)) {
    expandedAgentIds.value.delete(id)
  } else {
    expandedAgentIds.value.add(id)
  }
}

// 渲染 markdown
const renderMarkdown = (content: string) => {
  try {
    return marked(content, { breaks: true })
  } catch {
    return content
  }
}

// 获取步骤类型图标
const getStepIcon = (type: string) => {
  switch (type) {
    case 'thinking': return '🤔'
    case 'tool_call': return '🔧'
    case 'tool_result': return '📋'
    case 'message': return '💬'
    case 'error': return '❌'
    default: return '📌'
  }
}

// 获取状态标签样式
const getStatusClass = (status: string) => {
  switch (status) {
    case 'completed': return 'status-completed'
    case 'failed': return 'status-failed'
    case 'aborted': return 'status-aborted'
    default: return ''
  }
}

// 获取状态文本
const getStatusText = (status: string) => {
  switch (status) {
    case 'completed': return t('dataSettings.statusCompleted')
    case 'failed': return t('dataSettings.statusFailed')
    case 'aborted': return t('dataSettings.statusAborted')
    default: return status
  }
}

// ========== Token 用量统计 ==========
interface TokenPeriodStats {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  cache_hit_tokens: number
  cache_miss_tokens: number
  taskCount: number
}

interface TokenUsageStatsData {
  total: TokenPeriodStats
  today: TokenPeriodStats
  last7Days: TokenPeriodStats
  last30Days: TokenPeriodStats
  daily: Array<{ date: string } & TokenPeriodStats>
}

const tokenUsageStats = ref<TokenUsageStatsData | null>(null)
const showDailyDetail = ref(false)

const loadTokenUsageStats = async () => {
  try {
    tokenUsageStats.value = await window.electronAPI.history.getTokenUsageStats()
  } catch (e) {
    console.error('Failed to load token usage stats:', e)
  }
}

const formatTokenCount = (count: number): string => {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`
  return count.toString()
}

const hasTokenData = computed(() => {
  return tokenUsageStats.value && tokenUsageStats.value.total.total_tokens > 0
})

const getCacheHitRate = (stats: TokenPeriodStats): number | null => {
  if (stats.cache_hit_tokens === 0 && stats.cache_miss_tokens === 0) return null
  if (stats.prompt_tokens === 0) return null
  return Math.round(stats.cache_hit_tokens / stats.prompt_tokens * 100)
}

// 加载存储统计
const loadStorageStats = async () => {
  try {
    storageStats.value = await window.electronAPI.history.getStorageStats()
    dataPath.value = await window.electronAPI.history.getDataPath()
  } catch (e) {
    console.error('Failed to load storage stats:', e)
  }
}

// 格式化文件大小
const formatSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

// 打开数据目录
const openDataFolder = async () => {
  try {
    await window.electronAPI.history.openDataFolder()
  } catch (e) {
    showMessage('error', t('dataSettings.openFolderFailed'))
  }
}

// 导出选项
const exportOptions = ref({
  includeSshPasswords: false,
  includeApiKeys: false
})

// 导出到文件夹
const exportToFolder = async () => {
  isExporting.value = true
  try {
    // 将响应式对象转换为普通对象，避免 IPC 序列化错误
    const options = {
      includeSshPasswords: exportOptions.value.includeSshPasswords,
      includeApiKeys: exportOptions.value.includeApiKeys
    }
    const result = await window.electronAPI.history.exportToFolder(options)
    
    if (result.canceled) {
      // 用户取消
    } else if (result.success) {
      showMessage('success', t('dataSettings.exportedFiles', { count: result.files?.length || 0 }))
    } else {
      showMessage('error', result.error || t('dataSettings.exportFailed'))
    }
  } catch (e) {
    showMessage('error', `${t('dataSettings.exportFailed')}: ${e}`)
  } finally {
    isExporting.value = false
  }
}

// 从文件夹导入
const importFromFolder = async () => {
  isImporting.value = true
  try {
    const result = await window.electronAPI.history.importFromFolder()
    
    if (result.canceled) {
      // 用户取消
    } else if (result.success) {
      showMessage('success', t('dataSettings.importedItems', { items: result.imported?.join(', ') || t('dataSettings.importNone') }))
      await loadStorageStats()
    } else {
      showMessage('error', result.error || t('dataSettings.importFailed'))
    }
  } catch (e) {
    showMessage('error', `${t('dataSettings.importFailed')}: ${e}`)
  } finally {
    isImporting.value = false
  }
}

// 清理旧记录
const cleanupOldRecords = async (days: number) => {
  const confirmMsg = days === 0 
    ? t('dataSettings.confirmClearAll')
    : t('dataSettings.confirmCleanup', { days })
  
  if (!confirm(confirmMsg)) {
    return
  }
  
  isLoading.value = true
  try {
    const result = await window.electronAPI.history.cleanup(days)
    showMessage('success', t('dataSettings.cleanupResult', { chatDeleted: result.chatDeleted, agentDeleted: result.agentDeleted }))
    await loadStorageStats()
  } catch (e) {
    showMessage('error', `${t('dataSettings.cleanupFailed')}: ${e}`)
  } finally {
    isLoading.value = false
  }
}

// 显示消息
const showMessage = (type: 'success' | 'error', text: string) => {
  message.value = { type, text }
  setTimeout(() => {
    message.value = null
  }, 3000)
}

// 搜索框引用
const historySearchRef = ref<HTMLInputElement | null>(null)

// ESC 关闭历史记录弹窗
const handleKeydown = (e: KeyboardEvent) => {
  if (e.key === 'Escape' && showHistoryViewer.value) {
    e.stopImmediatePropagation() // 阻止其他监听器被调用，防止同时关闭父级弹窗
    closeHistoryViewer()
  }
}

// 监听弹窗打开，自动聚焦到搜索框
watch(showHistoryViewer, async (isOpen) => {
  if (isOpen) {
    await nextTick()
    historySearchRef.value?.focus()
  }
})

onMounted(() => {
  loadStorageStats()
  loadTokenUsageStats()
  document.addEventListener('keydown', handleKeydown, true)
})

onUnmounted(() => {
  document.removeEventListener('keydown', handleKeydown, true)
})
</script>

<template>
  <div class="data-settings">
    <!-- 页面标题 -->
    <div class="section page-intro">
      <div class="section-header">
        <h4>{{ t('dataSettings.title') }}</h4>
      </div>
      <p class="section-desc">{{ t('dataSettings.description') }}</p>
    </div>

    <!-- 消息提示 -->
    <Transition name="msg">
      <div v-if="message" class="message" :class="message.type">
        {{ message.text }}
      </div>
    </Transition>
    
    <!-- Token 用量统计 -->
    <div v-if="!isSteamBuild" class="section">
      <div class="section-header">
        <Coins :size="15" class="section-icon" />
        <h4>{{ t('dataSettings.tokenUsage') }}</h4>
      </div>
      
      <div v-if="tokenUsageStats && hasTokenData" class="token-usage-section">
        <!-- 时段卡片 -->
        <div class="token-period-grid">
          <div v-for="period in [
            { key: 'today', data: tokenUsageStats.today, iconClass: 'today' },
            { key: 'last7Days', data: tokenUsageStats.last7Days, iconClass: 'week' },
            { key: 'last30Days', data: tokenUsageStats.last30Days, iconClass: 'month' },
            { key: 'total', data: tokenUsageStats.total, iconClass: 'total' },
          ]" :key="period.key" :class="['token-period-card', { total: period.key === 'total' }]">
            <div class="token-period-header">
              <span class="token-period-label">{{ t(`dataSettings.token${period.key.charAt(0).toUpperCase() + period.key.slice(1)}`) }}</span>
              <component :is="period.key === 'total' ? Coins : Zap" :size="14" :class="['token-period-icon', period.iconClass]" />
            </div>
            <div class="token-period-value">{{ formatTokenCount(period.data.total_tokens) }}</div>
            <div class="token-period-detail">
              <span class="token-in"><ArrowUpRight :size="10" /> {{ formatTokenCount(period.data.prompt_tokens) }}</span>
              <span class="token-out"><ArrowDownLeft :size="10" /> {{ formatTokenCount(period.data.completion_tokens) }}</span>
              <span v-if="getCacheHitRate(period.data) !== null" class="token-cache">Cache {{ getCacheHitRate(period.data) }}%</span>
            </div>
          </div>
        </div>

        <!-- 每日明细（可折叠） -->
        <div v-if="tokenUsageStats.daily.length > 0" class="token-daily-section">
          <button class="btn btn-ghost token-daily-toggle" @click="showDailyDetail = !showDailyDetail">
            <ChevronDown v-if="showDailyDetail" :size="14" />
            <ChevronRight v-else :size="14" />
            {{ t('dataSettings.tokenDailyDetail') }}
          </button>
          
          <Transition name="slide">
            <div v-if="showDailyDetail" class="token-daily-table-wrap">
              <table class="token-daily-table">
                <thead>
                  <tr>
                    <th>{{ t('dataSettings.tokenDate') }}</th>
                    <th class="num">{{ t('dataSettings.tokenInput') }}</th>
                    <th class="num">{{ t('dataSettings.tokenOutput') }}</th>
                    <th class="num">{{ t('dataSettings.tokenTotalCol') }}</th>
                    <th class="num">Cache</th>
                    <th class="num">{{ t('dataSettings.tokenTaskCount') }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="day in tokenUsageStats.daily" :key="day.date">
                    <td>{{ day.date }}</td>
                    <td class="num">{{ formatTokenCount(day.prompt_tokens) }}</td>
                    <td class="num">{{ formatTokenCount(day.completion_tokens) }}</td>
                    <td class="num total-cell">{{ formatTokenCount(day.total_tokens) }}</td>
                    <td class="num cache-cell">{{ getCacheHitRate(day) !== null ? getCacheHitRate(day) + '%' : '-' }}</td>
                    <td class="num">{{ day.taskCount }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </Transition>
        </div>
      </div>
      
      <div v-else-if="tokenUsageStats" class="token-empty">
        <Coins :size="24" class="empty-icon" />
        <span>{{ t('dataSettings.tokenNoData') }}</span>
      </div>
      <div v-else class="loading">{{ t('dataSettings.loading') }}</div>
      
      <p class="hint">{{ t('dataSettings.tokenUsageHint') }}</p>
    </div>

    <!-- 存储统计 -->
    <div class="section">
      <div class="section-header">
        <HardDrive :size="15" class="section-icon" />
        <h4>{{ t('dataSettings.storageStats') }}</h4>
      </div>
      <div v-if="storageStats" class="stats-grid">
        <div v-if="!isSteamBuild" class="stat-card stat-agent">
          <div class="stat-icon-wrap agent">
            <Bot :size="18" />
          </div>
          <div class="stat-body">
            <span class="stat-value">{{ storageStats.agentFiles }}</span>
            <span class="stat-label">{{ t('dataSettings.agentRecords') }} ({{ t('dataSettings.days') }})</span>
          </div>
        </div>
        <div class="stat-card stat-size">
          <div class="stat-icon-wrap size">
            <HardDrive :size="18" />
          </div>
          <div class="stat-body">
            <span class="stat-value">{{ formatSize(storageStats.totalSize) }}</span>
            <span class="stat-label">{{ t('dataSettings.totalSize') }}</span>
          </div>
        </div>
        <div class="stat-card stat-range">
          <div class="stat-icon-wrap range">
            <CalendarRange :size="18" />
          </div>
          <div class="stat-body">
            <span class="stat-value range-value">
              {{ storageStats.oldestRecord || t('dataSettings.noData') }} ~ {{ storageStats.newestRecord || t('dataSettings.noData') }}
            </span>
            <span class="stat-label">{{ t('dataSettings.recordRange') }}</span>
          </div>
        </div>
      </div>
      <div v-else class="loading">{{ t('dataSettings.loading') }}</div>
      
      <button v-if="!isSteamBuild" class="btn btn-ghost view-history-btn" @click="openHistoryViewer">
        <History :size="15" />
        {{ t('dataSettings.viewHistory') }}
      </button>
    </div>
    
    <!-- 数据目录 -->
    <div class="section">
      <div class="section-header">
        <FolderOpen :size="15" class="section-icon" />
        <h4>{{ t('dataSettings.dataDirectory') }}</h4>
      </div>
      <div class="data-path-card">
        <code class="path-text">{{ dataPath }}</code>
        <button class="btn btn-sm btn-icon" @click="openDataFolder" :title="t('dataSettings.openFolder')" :aria-label="t('dataSettings.openFolder')">
          <ExternalLink :size="14" />
        </button>
      </div>
      <p class="hint">{{ t('dataSettings.migrationHint') }}</p>
    </div>
    
    <!-- 导出/导入 -->
    <div class="section">
      <div class="section-header">
        <Download :size="15" class="section-icon" />
        <h4>{{ t('dataSettings.backupRestore') }}</h4>
      </div>
      
      <div class="backup-card">
        <div class="export-options">
          <label class="checkbox-label">
            <input type="checkbox" v-model="exportOptions.includeSshPasswords">
            <span>{{ t('dataSettings.includeSshPasswords') }}</span>
          </label>
          <label v-if="!isSteamBuild" class="checkbox-label">
            <input type="checkbox" v-model="exportOptions.includeApiKeys">
            <span>{{ t('dataSettings.includeApiKeys') }}</span>
          </label>
        </div>
        
        <div class="actions">
          <button class="btn btn-primary" @click="exportToFolder" :disabled="isExporting">
            <Download :size="14" />
            {{ isExporting ? t('dataSettings.exporting') : t('dataSettings.exportToFolder') }}
          </button>
          <button class="btn" @click="importFromFolder" :disabled="isImporting">
            <Upload :size="14" />
            {{ isImporting ? t('dataSettings.importing') : t('dataSettings.importFromFolder') }}
          </button>
        </div>
      </div>
      <p class="hint">{{ t('dataSettings.exportHint') }}</p>
    </div>
    
    <!-- 清理 -->
    <div class="section section-danger">
      <div class="section-header">
        <Trash2 :size="15" class="section-icon danger" />
        <h4>{{ t('dataSettings.cleanupHistory') }}</h4>
      </div>
      <div class="cleanup-actions">
        <button class="btn btn-outline" @click="cleanupOldRecords(30)" :disabled="isLoading">
          <Clock :size="14" />
          {{ t('dataSettings.cleanup30Days') }}
        </button>
        <button class="btn btn-outline" @click="cleanupOldRecords(90)" :disabled="isLoading">
          <Clock :size="14" />
          {{ t('dataSettings.cleanup90Days') }}
        </button>
        <button class="btn btn-danger-fill" @click="cleanupOldRecords(0)" :disabled="isLoading">
          <AlertTriangle :size="14" />
          {{ t('dataSettings.clearAll') }}
        </button>
      </div>
      <p class="hint">{{ t('dataSettings.cleanupHint') }}</p>
    </div>
    
    <!-- 历史记录查看器弹窗 -->
    <Teleport to="body">
      <Transition name="modal">
        <div v-if="showHistoryViewer" class="history-modal-overlay settings-scope" @click.self="closeHistoryViewer">
          <div class="history-modal">
            <div class="history-modal-header">
              <div class="modal-title">
                <History :size="18" />
                <h3>{{ t('dataSettings.historyViewer') }}</h3>
              </div>
              <button class="close-btn" @click="closeHistoryViewer" aria-label="Close">
                <X :size="16" />
              </button>
            </div>
            
            <!-- 工具栏 -->
            <div class="history-toolbar">
              <div class="toolbar-left">
                <div class="history-type-badge">
                  <Bot :size="14" />
                  {{ t('dataSettings.agentTasks') }}
                </div>
                
                <div class="date-range-switcher">
                  <button 
                    v-for="range in [
                      { value: 'today', label: t('dataSettings.today') },
                      { value: 'week', label: t('dataSettings.last7Days') },
                      { value: 'month', label: t('dataSettings.last30Days') },
                      { value: 'all', label: t('dataSettings.all') }
                    ]" 
                    :key="range.value"
                    :class="['range-btn', { active: selectedDateRange === range.value }]"
                    @click="switchDateRange(range.value as 'today' | 'week' | 'month' | 'all')"
                  >
                    {{ range.label }}
                  </button>
                </div>
              </div>
              
              <div class="search-box">
                <Search :size="14" class="search-icon" />
                <input 
                  ref="historySearchRef"
                  v-model="searchKeyword"
                  type="text" 
                  :placeholder="t('dataSettings.searchPlaceholder')"
                  class="search-input"
                />
                <button v-if="searchKeyword" class="clear-search" @click="searchKeyword = ''">
                  <X :size="12" />
                </button>
              </div>
            </div>
            
            <!-- 内容区域 -->
            <div class="history-content">
              <div v-if="historyLoading" class="loading-state">
                <span class="spinner"></span>
                {{ t('dataSettings.loading') }}
              </div>
              
              <!-- Agent 记录 -->
              <div v-else class="agent-history">
                <div v-if="filteredAgentRecords.length === 0" class="empty-state">
                  <Bot :size="32" class="empty-icon" />
                  <span>{{ t('dataSettings.noAgentRecords') }}</span>
                </div>
                <div v-else class="agent-list">
                  <div 
                    v-for="record in filteredAgentRecords" 
                    :key="record.id"
                    class="agent-item"
                  >
                    <div class="agent-header" @click="toggleAgentExpand(record.id)">
                      <div class="agent-info">
                        <span :class="['status-badge', getStatusClass(record.status)]">
                          {{ getStatusText(record.status) }}
                        </span>
                        <span class="agent-task">{{ record.userTask }}</span>
                      </div>
                      <div class="agent-meta">
                        <span v-if="record.sshHost" class="agent-host">
                          <Server :size="12" /> {{ record.sshHost }}
                        </span>
                        <span v-else class="agent-host">
                          <Monitor :size="12" /> {{ t('dataSettings.local') }}
                        </span>
                        <span class="agent-time">{{ formatTime(record.timestamp) }}</span>
                        <span class="agent-duration">
                          <Clock :size="12" /> {{ formatDuration(record.duration) }}
                        </span>
                        <ChevronDown v-if="expandedAgentIds.has(record.id)" :size="14" class="expand-icon" />
                        <ChevronRight v-else :size="14" class="expand-icon" />
                      </div>
                    </div>
                    
                    <div v-if="expandedAgentIds.has(record.id)" class="agent-details">
                      <div class="steps-list">
                        <div class="steps-label">{{ t('dataSettings.executionSteps') }} ({{ record.steps.length }})</div>
                        <div 
                          v-for="step in record.steps" 
                          :key="step.id"
                          :class="['step-item', step.type]"
                        >
                          <div class="step-header">
                            <span class="step-icon">{{ getStepIcon(step.type) }}</span>
                            <span class="step-type">{{ step.type }}</span>
                            <span v-if="step.toolName" class="step-tool">{{ step.toolName }}</span>
                            <span class="step-time">{{ formatTime(step.timestamp) }}</span>
                          </div>
                          <div v-if="step.content" class="step-content">{{ step.content }}</div>
                          <div v-if="step.toolArgs" class="step-args">
                            <code>{{ JSON.stringify(step.toolArgs, null, 2) }}</code>
                          </div>
                          <div v-if="step.toolResult" class="step-result">
                            <pre>{{ step.toolResult }}</pre>
                          </div>
                        </div>
                      </div>
                      
                      <div v-if="record.finalResult" class="final-result">
                        <div class="result-label">{{ t('dataSettings.finalResult') }}</div>
                        <div class="result-content" v-html="renderMarkdown(record.finalResult)"></div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
            
            <div class="history-footer">
              <span>
                {{ t('dataSettings.totalTasks', { count: filteredAgentRecords.length }) }}
              </span>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
.data-settings {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

/* Sections：与其他设置页一致的卡片容器 */
.section {
  background: var(--bg-tertiary);
  border-radius: 8px;
  padding: 16px;
}

.section-header {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 28px;
  margin-bottom: 8px;
}

.section-header h4 {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0;
}

.section-desc {
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.5;
  margin-bottom: 0;
}

.section-icon {
  color: var(--text-muted);
}

.section-icon.danger {
  color: var(--color-error);
}

/* Message toast */
.message {
  padding: 10px 14px;
  border-radius: 8px;
  margin-bottom: 16px;
  font-size: 13px;
}

.message.success {
  background: rgba(var(--color-success-rgb), 0.1);
  color: var(--color-success);
  border: 1px solid rgba(var(--color-success-rgb), 0.2);
}

.message.error {
  background: rgba(var(--color-error-rgb), 0.1);
  color: var(--color-error);
  border: 1px solid rgba(var(--color-error-rgb), 0.2);
}

.msg-enter-active,
.msg-leave-active {
  transition: all 0.3s ease;
}
.msg-enter-from,
.msg-leave-to {
  opacity: 0;
  transform: translateY(-8px);
}

/* Stats grid */
.stats-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 10px;
}

.stat-card {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px;
  background: var(--bg-secondary);
  border-radius: 8px;
  border: 1px solid transparent;
  transition: border-color 0.2s;
}

.stat-card:hover {
  border-color: var(--border-color);
}

.stat-icon-wrap {
  width: 36px;
  height: 36px;
  border-radius: 9px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.stat-icon-wrap.agent {
  background: rgba(var(--color-success-rgb), 0.12);
  color: var(--color-success);
}

.stat-icon-wrap.size {
  background: rgba(168, 85, 247, 0.12);
  color: #a855f7;
}

.stat-icon-wrap.range {
  background: rgba(251, 146, 60, 0.12);
  color: #fb923c;
}

.stat-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.stat-value {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
  line-height: 1.2;
}

.stat-value.range-value {
  font-size: 12px;
  font-weight: 500;
  line-height: 1.35;
  white-space: normal;
}

.stat-label {
  font-size: 11px;
  color: var(--text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.view-history-btn {
  margin-top: 14px;
  width: 100%;
  justify-content: center;
  min-height: 34px;
}

/* Data path */
.data-path-card {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  background: var(--bg-secondary);
  border-radius: 8px;
  border: 1px solid var(--border-color);
}

.path-text {
  flex: 1;
  font-size: 12px;
  color: var(--text-secondary);
  word-break: break-all;
  line-height: 1.4;
}

/* Backup card */
.backup-card {
  padding: 14px;
  background: var(--bg-secondary);
  border-radius: 8px;
  border: 1px solid var(--border-color);
}

.export-options {
  display: flex;
  gap: 20px;
  margin-bottom: 14px;
}

.checkbox-label {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--text-secondary);
  cursor: pointer;
}

.checkbox-label input[type="checkbox"] {
  width: 15px;
  height: 15px;
  cursor: pointer;
  accent-color: var(--accent-primary);
}

.actions {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}

.actions .btn {
  flex: 1;
  min-width: 160px;
  justify-content: center;
}

/* Cleanup */
.section-danger .cleanup-actions {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}

.section-danger .cleanup-actions .btn {
  flex: 1;
  min-width: 150px;
  justify-content: center;
}

.hint {
  font-size: 12px;
  color: var(--text-muted);
  margin-top: 10px;
  line-height: 1.5;
}

.loading {
  color: var(--text-muted);
  font-size: 13px;
  padding: 20px 0;
}

/* 填充式危险按钮（特殊语义：清理数据用） */
.btn-danger-fill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 14px;
  font-size: 13px;
  border-radius: 6px;
  border: 1px solid rgba(var(--color-error-rgb), 0.3);
  background: rgba(var(--color-error-rgb), 0.08);
  color: var(--color-error);
  cursor: pointer;
  transition: background-color 0.2s, border-color 0.2s;
}

.btn-danger-fill:hover:not(:disabled) {
  background: rgba(var(--color-error-rgb), 0.15);
  border-color: rgba(var(--color-error-rgb), 0.5);
}

.btn-danger-fill:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* Token usage */
.token-usage-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.token-period-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 10px;
}

.token-period-card {
  padding: 14px;
  background: var(--bg-secondary);
  border-radius: 8px;
  border: 1px solid transparent;
  transition: border-color 0.2s;
}

.token-period-card:hover {
  border-color: var(--border-color);
}

.token-period-card.total {
  background: linear-gradient(135deg, rgba(var(--color-info-rgb), 0.06), rgba(168, 85, 247, 0.06));
}

.token-period-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}

.token-period-label {
  font-size: 11px;
  color: var(--text-muted);
  font-weight: 500;
}

.token-period-icon {
  opacity: 0.5;
}
.token-period-icon.today { color: var(--color-success); }
.token-period-icon.week { color: var(--color-info); }
.token-period-icon.month { color: var(--color-warning); }
.token-period-icon.total { color: #a855f7; }

.token-period-value {
  font-size: 20px;
  font-weight: 700;
  color: var(--text-primary);
  line-height: 1.2;
  margin-bottom: 6px;
}

.token-period-detail {
  display: flex;
  gap: 10px;
  font-size: 11px;
}

.token-in {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  color: var(--text-muted);
}

.token-out {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  color: var(--text-muted);
}

.token-cache {
  font-size: 10px;
  color: var(--color-success);
  margin-left: auto;
}

.token-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 24px;
  color: var(--text-muted);
  font-size: 13px;
}

.token-daily-section {
  margin-top: 4px;
}

.token-daily-toggle {
  width: 100%;
  justify-content: center;
  min-height: 30px;
  font-size: 12px;
}

.token-daily-table-wrap {
  margin-top: 8px;
  max-height: 320px;
  overflow-y: auto;
}

.token-daily-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}

.token-daily-table th {
  padding: 8px 10px;
  text-align: left;
  font-weight: 600;
  color: var(--text-secondary);
  border-bottom: 1px solid var(--border-color);
  font-size: 11px;
}

.token-daily-table th.num,
.token-daily-table td.num {
  text-align: right;
}

.token-daily-table td {
  padding: 7px 10px;
  color: var(--text-primary);
  border-bottom: 1px solid var(--border-color);
}

.token-daily-table td.total-cell {
  font-weight: 600;
}

.token-daily-table td.cache-cell {
  color: var(--color-success);
}

.token-daily-table tbody tr:hover {
  background: var(--bg-hover);
}

.token-daily-table tbody tr:last-child td {
  border-bottom: none;
}

.slide-enter-active,
.slide-leave-active {
  transition: all 0.25s ease;
  max-height: 400px;
}
.slide-enter-from,
.slide-leave-to {
  opacity: 0;
  max-height: 0;
}

@media (max-width: 900px) {
  .stats-grid {
    grid-template-columns: 1fr;
  }

  .token-period-grid {
    grid-template-columns: repeat(2, 1fr);
  }

  .actions .btn,
  .section-danger .cleanup-actions .btn {
    min-width: 0;
  }
}

/* ========== History modal ========== */
.modal-enter-active,
.modal-leave-active {
  transition: opacity 0.25s ease;
}
.modal-enter-active .history-modal,
.modal-leave-active .history-modal {
  transition: transform 0.25s ease;
}
.modal-enter-from,
.modal-leave-to {
  opacity: 0;
}
.modal-enter-from .history-modal {
  transform: scale(0.95) translateY(10px);
}
.modal-leave-to .history-modal {
  transform: scale(0.95) translateY(10px);
}

.history-modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10000;
  backdrop-filter: blur(4px);
}

.history-modal {
  width: 90%;
  max-width: 900px;
  max-height: 85vh;
  background: var(--bg-primary);
  border-radius: 14px;
  display: flex;
  flex-direction: column;
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.4);
  border: 1px solid var(--border-color);
}

.history-modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border-color);
}

.modal-title {
  display: flex;
  align-items: center;
  gap: 10px;
  color: var(--text-primary);
}

.modal-title h3 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
}

.close-btn {
  width: 30px;
  height: 30px;
  border: none;
  background: var(--bg-tertiary);
  border-radius: 8px;
  cursor: pointer;
  color: var(--text-secondary);
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s;
}

.close-btn:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

/* Toolbar */
.history-toolbar {
  display: flex;
  gap: 12px;
  padding: 12px 20px;
  border-bottom: 1px solid var(--border-color);
  align-items: center;
  flex-wrap: wrap;
  justify-content: space-between;
}

.toolbar-left {
  display: flex;
  gap: 12px;
  align-items: center;
  flex-wrap: wrap;
}

.history-type-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: var(--bg-tertiary);
  color: var(--text-secondary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  padding: 6px 10px;
  font-size: 12px;
  font-weight: 500;
}

.date-range-switcher {
  display: flex;
  gap: 4px;
}

.range-btn {
  padding: 5px 10px;
  border: 1px solid var(--border-color);
  background: transparent;
  color: var(--text-secondary);
  border-radius: 6px;
  cursor: pointer;
  font-size: 12px;
  transition: all 0.2s;
}

.range-btn:hover {
  border-color: var(--accent-primary);
  color: var(--text-primary);
}

.range-btn.active {
  background: var(--accent-primary);
  border-color: var(--accent-primary);
  color: white;
}

.search-box {
  min-width: 180px;
  max-width: 280px;
  position: relative;
  display: flex;
  align-items: center;
}

.search-icon {
  position: absolute;
  left: 10px;
  color: var(--text-muted);
  pointer-events: none;
}

.search-input {
  width: 100%;
  padding: 7px 30px 7px 32px;
  border: 1px solid var(--border-color);
  background: var(--bg-tertiary);
  border-radius: 8px;
  color: var(--text-primary);
  font-size: 13px;
}

.search-input::placeholder {
  color: var(--text-muted);
}

.search-input:focus {
  outline: none;
  border-color: var(--accent-primary);
}

.clear-search {
  position: absolute;
  right: 8px;
  cursor: pointer;
  color: var(--text-muted);
  border: none;
  background: none;
  padding: 2px;
  display: flex;
  align-items: center;
}

.clear-search:hover {
  color: var(--text-primary);
}

/* Content */
.history-content {
  flex: 1;
  overflow-y: auto;
  padding: 16px 20px;
  min-height: 300px;
  user-select: text;
  -webkit-user-select: text;
}

.loading-state {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  height: 200px;
  color: var(--text-muted);
}

.spinner {
  width: 20px;
  height: 20px;
  border: 2px solid var(--border-color);
  border-top-color: var(--accent-primary);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  height: 200px;
  color: var(--text-muted);
  font-size: 14px;
}

.empty-icon {
  opacity: 0.3;
}

/* Agent records */
.agent-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.agent-item {
  background: var(--bg-tertiary);
  border-radius: 10px;
  overflow: hidden;
  border: 1px solid transparent;
  transition: border-color 0.2s;
}

.agent-item:hover {
  border-color: var(--border-color);
}

.agent-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 14px;
  cursor: pointer;
  transition: background 0.2s;
}

.agent-header:hover {
  background: var(--bg-hover);
}

.agent-info {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 1;
  min-width: 0;
}

.status-badge {
  padding: 3px 8px;
  border-radius: 5px;
  font-size: 11px;
  font-weight: 500;
  flex-shrink: 0;
}

.status-completed {
  background: rgba(var(--color-success-rgb), 0.12);
  color: var(--color-success);
}

.status-failed {
  background: rgba(var(--color-error-rgb), 0.12);
  color: var(--color-error);
}

.status-aborted {
  background: rgba(var(--color-warning-rgb), 0.12);
  color: var(--color-warning);
}

.agent-task {
  font-size: 13px;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  user-select: text;
  -webkit-user-select: text;
}

.agent-meta {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 11px;
  color: var(--text-muted);
  flex-shrink: 0;
}

.agent-host,
.agent-duration {
  display: inline-flex;
  align-items: center;
  gap: 3px;
}

.expand-icon {
  color: var(--text-muted);
  transition: transform 0.2s;
}

/* Agent details */
.agent-details {
  padding: 14px;
  border-top: 1px solid var(--border-color);
  background: var(--bg-secondary);
}

.final-result {
  margin-top: 16px;
  padding: 12px;
  background: var(--bg-tertiary);
  border-radius: 8px;
  border-left: 3px solid var(--color-success);
}

.result-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
  margin-bottom: 8px;
}

.result-content {
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-primary);
  user-select: text;
  -webkit-user-select: text;
  cursor: text;
}

.result-content :deep(p) {
  margin: 0 0 8px 0;
}

.result-content :deep(p:last-child) {
  margin-bottom: 0;
}

.steps-list {
  max-height: 400px;
  overflow-y: auto;
}

.steps-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
  margin-bottom: 10px;
}

.step-item {
  padding: 10px;
  margin-bottom: 8px;
  background: var(--bg-tertiary);
  border-radius: 6px;
  font-size: 12px;
}

.step-item:last-child {
  margin-bottom: 0;
}

.step-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
  color: var(--text-secondary);
}

.step-icon {
  font-size: 14px;
}

.step-type {
  font-weight: 500;
  text-transform: capitalize;
}

.step-tool {
  padding: 1px 6px;
  background: var(--bg-secondary);
  border-radius: 4px;
  font-family: monospace;
}

.step-time {
  margin-left: auto;
  font-size: 11px;
  color: var(--text-muted);
}

.step-content {
  color: var(--text-primary);
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
  user-select: text;
  -webkit-user-select: text;
  cursor: text;
}

.step-args {
  margin-top: 6px;
}

.step-args code {
  display: block;
  padding: 8px;
  background: var(--bg-secondary);
  border-radius: 4px;
  font-size: 11px;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--text-secondary);
  user-select: text;
  -webkit-user-select: text;
  cursor: text;
}

.step-result {
  margin-top: 6px;
}

.step-result pre {
  padding: 8px;
  background: var(--bg-secondary);
  border-radius: 4px;
  font-size: 11px;
  overflow-x: auto;
  max-height: 200px;
  margin: 0;
  color: var(--text-secondary);
  user-select: text;
  -webkit-user-select: text;
  cursor: text;
}

/* Footer */
.history-footer {
  padding: 10px 20px;
  border-top: 1px solid var(--border-color);
  font-size: 12px;
  color: var(--text-muted);
  text-align: center;
}
</style>

