<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Trash2, RefreshCw, Search, Shield, ShieldCheck, ShieldAlert, Ban } from 'lucide-vue-next'
import type { RiskLevel } from '@shared/types/agent'

type AllowlistEntry = {
  key: string
  toolName: string
  keyArgs: Record<string, unknown>
  riskLevelAtApproval: RiskLevel
  approvedAt: number
  sourceAgentKey: string
  sourceKind: 'task' | 'companion' | 'watch'
}

const { t } = useI18n()
const entries = ref<AllowlistEntry[]>([])
const loading = ref(false)
const filterTool = ref('')
const selectedKeys = ref<Set<string>>(new Set())
const confirmClearAll = ref(false)

const filteredEntries = computed(() => {
  const q = filterTool.value.trim().toLowerCase()
  if (!q) return entries.value
  return entries.value.filter(e =>
    e.toolName.toLowerCase().includes(q) ||
    formatKeyArgs(e.keyArgs).toLowerCase().includes(q),
  )
})

function formatKeyArgs(args: Record<string, unknown>): string {
  try {
    const s = JSON.stringify(args)
    return s.length > 120 ? s.slice(0, 117) + '...' : s
  } catch {
    return String(args)
  }
}

function formatKeyArgsShort(args: Record<string, unknown>): string {
  const full = formatKeyArgs(args)
  if (full.length <= 60) return full
  return full.slice(0, 57) + '...'
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  const diff = now.getTime() - ts
  const day = 24 * 60 * 60 * 1000
  if (diff < day && d.getDate() === now.getDate()) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }
  if (diff < 2 * day) return t('settings.security.userAllowlist.timeYesterday')
  if (diff < 7 * day) return t('settings.security.userAllowlist.timeDaysAgo', { n: Math.floor(diff / day) })
  return d.toLocaleDateString()
}

function riskIcon(level: RiskLevel) {
  if (level === 'dangerous') return ShieldAlert
  if (level === 'moderate') return Shield
  if (level === 'blocked') return Ban
  return ShieldCheck
}

function riskClass(level: RiskLevel): string {
  return `risk-${level}`
}

function riskLabel(level: RiskLevel): string {
  if (level === 'blocked') return t('settings.security.userAllowlist.riskBlocked')
  if (level === 'dangerous') return t('ai.highRisk')
  if (level === 'moderate') return t('ai.mediumRisk')
  return t('ai.lowRisk')
}

function sourceLabel(entry: AllowlistEntry): string {
  if (entry.sourceKind === 'companion') return t('settings.security.userAllowlist.sourceCompanion')
  if (entry.sourceKind === 'watch') return t('settings.security.userAllowlist.sourceWatch')
  return entry.sourceAgentKey || t('settings.security.userAllowlist.sourceTask')
}

async function loadEntries() {
  loading.value = true
  try {
    entries.value = await window.electronAPI.allowlist.list()
    selectedKeys.value = new Set()
  } finally {
    loading.value = false
  }
}

async function removeOne(key: string) {
  await window.electronAPI.allowlist.remove(key)
  await loadEntries()
}

async function removeSelected() {
  for (const key of selectedKeys.value) {
    await window.electronAPI.allowlist.remove(key)
  }
  await loadEntries()
}

async function clearAll() {
  await window.electronAPI.allowlist.clear()
  confirmClearAll.value = false
  await loadEntries()
}

function toggleSelect(key: string, checked: boolean) {
  const next = new Set(selectedKeys.value)
  if (checked) next.add(key)
  else next.delete(key)
  selectedKeys.value = next
}

function toggleSelectAll(checked: boolean) {
  if (!checked) {
    selectedKeys.value = new Set()
    return
  }
  selectedKeys.value = new Set(filteredEntries.value.map(e => e.key))
}

onMounted(loadEntries)
</script>

<template>
  <div class="user-allowlist-settings">
    <div class="settings-section">
      <div class="section-header">
        <div class="header-left">
          <h4>{{ t('settings.security.userAllowlist.title') }}</h4>
          <span class="count-badge" v-if="entries.length > 0">{{ entries.length }}</span>
        </div>
        <div class="header-actions">
          <button class="btn btn-sm" @click="loadEntries" :disabled="loading" :title="t('common.refresh')">
            <RefreshCw :size="14" :class="{ spinning: loading }" />
          </button>
        </div>
      </div>
      <p class="section-desc">{{ t('settings.security.userAllowlist.description') }}</p>

      <div class="toolbar">
        <div class="search-box">
          <Search :size="14" class="search-icon" />
          <input
            v-model="filterTool"
            type="text"
            class="input-field filter-input"
            :placeholder="t('settings.security.userAllowlist.filterPlaceholder')"
          />
        </div>
        <div class="toolbar-actions">
          <button
            v-if="!confirmClearAll"
            class="btn btn-sm btn-danger"
            :disabled="loading || entries.length === 0"
            @click="confirmClearAll = true"
          >
            <Trash2 :size="14" />
            {{ t('settings.security.userAllowlist.clearAll') }}
          </button>
          <template v-else>
            <button class="btn btn-sm btn-danger" @click="clearAll">
              {{ t('common.confirm') }}
            </button>
            <button class="btn btn-sm" @click="confirmClearAll = false">
              {{ t('common.cancel') }}
            </button>
          </template>
          <button
            class="btn btn-sm"
            :disabled="loading || selectedKeys.size === 0"
            @click="removeSelected"
            v-if="selectedKeys.size > 0"
          >
            <Trash2 :size="14" />
            {{ t('settings.security.userAllowlist.removeSelected') }} ({{ selectedKeys.size }})
          </button>
        </div>
      </div>

      <div v-if="loading" class="empty-state">
        <RefreshCw :size="32" class="empty-icon spinning" />
        <p>{{ t('settings.security.userAllowlist.loading') }}</p>
      </div>
      <div v-else-if="entries.length === 0" class="empty-state">
        <ShieldCheck :size="32" class="empty-icon" />
        <p>{{ t('settings.security.userAllowlist.empty') }}</p>
        <p class="empty-hint">{{ t('settings.security.userAllowlist.emptyHint') }}</p>
      </div>
      <div v-else-if="filteredEntries.length === 0" class="empty-state">
        <Search :size="32" class="empty-icon" />
        <p>{{ t('settings.security.userAllowlist.noMatch') }}</p>
      </div>
      <div v-else class="entry-list">
        <div class="select-all-row">
          <label class="checkbox-label">
            <input
              type="checkbox"
              :checked="filteredEntries.length > 0 && filteredEntries.every(e => selectedKeys.has(e.key))"
              @change="toggleSelectAll(($event.target as HTMLInputElement).checked)"
            />
            <span>{{ t('settings.security.userAllowlist.selectAll') }}</span>
          </label>
          <span class="count-text">{{ filteredEntries.length }} / {{ entries.length }}</span>
        </div>
        <div
          v-for="entry in filteredEntries"
          :key="entry.key"
          class="entry-item"
          :class="{ selected: selectedKeys.has(entry.key) }"
        >
          <div class="entry-check">
            <input
              type="checkbox"
              :checked="selectedKeys.has(entry.key)"
              @change="toggleSelect(entry.key, ($event.target as HTMLInputElement).checked)"
            />
          </div>
          <div class="entry-risk" :class="riskClass(entry.riskLevelAtApproval)">
            <component :is="riskIcon(entry.riskLevelAtApproval)" :size="16" />
          </div>
          <div class="entry-info">
            <div class="entry-header">
              <code class="entry-tool">{{ entry.toolName }}</code>
              <span class="risk-tag" :class="riskClass(entry.riskLevelAtApproval)">
                {{ riskLabel(entry.riskLevelAtApproval) }}
              </span>
            </div>
            <div class="entry-args" :title="formatKeyArgs(entry.keyArgs)">
              <code>{{ formatKeyArgsShort(entry.keyArgs) }}</code>
            </div>
            <div class="entry-meta">
              <span class="meta-source">{{ sourceLabel(entry) }}</span>
              <span class="meta-dot">·</span>
              <span class="meta-time">{{ formatTime(entry.approvedAt) }}</span>
            </div>
          </div>
          <div class="entry-actions">
            <button
              class="btn-icon danger"
              @click="removeOne(entry.key)"
              :title="t('settings.security.userAllowlist.remove')"
            >
              <Trash2 :size="14" />
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.user-allowlist-settings {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.settings-section {
  background: var(--bg-tertiary);
  border-radius: 8px;
  padding: 16px;
}

.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 28px;
  margin-bottom: 8px;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 12px;
}

.section-header h4 {
  font-size: 14px;
  font-weight: 600;
  margin: 0;
}

.count-badge {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 10px;
  background: var(--accent-primary);
  color: var(--accent-contrast);
  font-weight: 500;
}

.header-actions {
  display: flex;
  gap: 8px;
}

.section-desc {
  font-size: 12px;
  color: var(--text-muted);
  margin-bottom: 16px;
  line-height: 1.5;
}

.toolbar {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 12px;
  flex-wrap: wrap;
  justify-content: space-between;
}

.search-box {
  position: relative;
  flex: 1;
  min-width: 200px;
}

.search-icon {
  position: absolute;
  left: 10px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--text-muted);
  pointer-events: none;
}

.filter-input {
  width: 100%;
  padding: 8px 12px 8px 30px;
  border-radius: 6px;
  border: 1px solid var(--border-color);
  background: var(--bg-secondary);
  color: var(--text-primary);
  font-size: 13px;
  outline: none;
  box-sizing: border-box;
  transition: border-color 0.2s;
}

.filter-input:focus {
  border-color: var(--accent-primary);
}

.toolbar-actions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}

.entry-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.select-all-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 12px;
  font-size: 12px;
  color: var(--text-muted);
  border-bottom: 1px solid var(--border-color);
  margin-bottom: 4px;
}

.checkbox-label {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  user-select: none;
}

.checkbox-label input {
  width: 14px;
  height: 14px;
  cursor: pointer;
}

.count-text {
  font-size: 11px;
}

.entry-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  transition: all 0.2s ease;
}

.entry-item:hover {
  border-color: var(--accent-primary);
}

.entry-item.selected {
  background: var(--accent-primary-bg, rgba(99, 102, 241, 0.08));
  border-color: var(--accent-primary);
}

.entry-check input {
  width: 14px;
  height: 14px;
  cursor: pointer;
  flex-shrink: 0;
}

.entry-risk {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 6px;
}

.entry-risk.risk-safe {
  color: #22c55e;
  background: rgba(34, 197, 94, 0.12);
}

.entry-risk.risk-moderate {
  color: #f59e0b;
  background: rgba(245, 158, 11, 0.12);
}

.entry-risk.risk-dangerous {
  color: #ef4444;
  background: rgba(239, 68, 68, 0.12);
}

.entry-risk.risk-blocked {
  color: #6b7280;
  background: rgba(107, 114, 128, 0.12);
}

.entry-info {
  flex: 1;
  min-width: 0;
}

.entry-header {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.entry-tool {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-primary);
  font-family: 'SF Mono', Menlo, Consolas, monospace;
}

.risk-tag {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 4px;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.risk-tag.risk-safe {
  color: #22c55e;
  background: rgba(34, 197, 94, 0.12);
}

.risk-tag.risk-moderate {
  color: #f59e0b;
  background: rgba(245, 158, 11, 0.12);
}

.risk-tag.risk-dangerous {
  color: #ef4444;
  background: rgba(239, 68, 68, 0.12);
}

.risk-tag.risk-blocked {
  color: #6b7280;
  background: rgba(107, 114, 128, 0.12);
}

.entry-args {
  margin-top: 4px;
  font-size: 12px;
}

.entry-args code {
  font-family: 'SF Mono', Menlo, Consolas, monospace;
  color: var(--text-secondary);
  word-break: break-all;
}

.entry-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 4px;
  font-size: 11px;
  color: var(--text-muted);
}

.meta-dot {
  opacity: 0.5;
}

.entry-actions {
  flex-shrink: 0;
  display: flex;
  gap: 4px;
}

.btn-icon.danger {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  border: none;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  transition: all 0.15s;
}

.btn-icon.danger:hover {
  color: var(--accent-red, #ef4444);
  background: rgba(239, 68, 68, 0.1);
}

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 40px 20px;
  color: var(--text-muted);
}

.empty-icon {
  opacity: 0.3;
  margin-bottom: 12px;
}

.empty-state p {
  font-size: 13px;
  margin: 0;
}

.empty-hint {
  font-size: 12px;
  margin-top: 4px !important;
  opacity: 0.7;
  text-align: center;
  max-width: 320px;
  line-height: 1.5;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.spinning {
  animation: spin 1s linear infinite;
}
</style>
