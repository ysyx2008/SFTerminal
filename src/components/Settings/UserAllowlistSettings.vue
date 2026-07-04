<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { useI18n } from 'vue-i18n'
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

const filteredEntries = computed(() => {
  const q = filterTool.value.trim().toLowerCase()
  if (!q) return entries.value
  return entries.value.filter(e => e.toolName.toLowerCase().includes(q))
})

function formatKeyArgs(args: Record<string, unknown>): string {
  try {
    const s = JSON.stringify(args)
    return s.length > 80 ? s.slice(0, 77) + '...' : s
  } catch {
    return String(args)
  }
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString()
}

function riskLabel(level: RiskLevel): string {
  switch (level) {
    case 'dangerous': return t('ai.highRisk')
    case 'moderate': return t('ai.mediumRisk')
    case 'blocked': return 'blocked'
    default: return t('ai.lowRisk')
  }
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
  if (!confirm(t('settings.security.userAllowlist.confirmClear'))) return
  await window.electronAPI.allowlist.clear()
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
        <h4>{{ t('settings.security.userAllowlist.title') }}</h4>
      </div>
      <p class="section-desc">{{ t('settings.security.userAllowlist.description') }}</p>

      <div class="toolbar">
        <input
          v-model="filterTool"
          type="text"
          class="input-field filter-input"
          :placeholder="t('settings.security.userAllowlist.filterPlaceholder')"
        />
        <button
          class="btn btn-sm btn-outline-danger"
          :disabled="loading || entries.length === 0"
          @click="clearAll"
        >
          {{ t('settings.security.userAllowlist.clearAll') }}
        </button>
        <button
          class="btn btn-sm btn-outline-secondary"
          :disabled="loading || selectedKeys.size === 0"
          @click="removeSelected"
        >
          {{ t('settings.security.userAllowlist.removeSelected') }}
        </button>
      </div>

      <div v-if="loading" class="empty-hint">{{ t('settings.security.userAllowlist.loading') }}</div>
      <div v-else-if="filteredEntries.length === 0" class="empty-hint">
        {{ t('settings.security.userAllowlist.empty') }}
      </div>
      <div v-else class="table-wrap">
        <table class="allowlist-table">
          <thead>
            <tr>
              <th class="col-check">
                <input
                  type="checkbox"
                  :checked="filteredEntries.length > 0 && filteredEntries.every(e => selectedKeys.has(e.key))"
                  @change="toggleSelectAll(($event.target as HTMLInputElement).checked)"
                />
              </th>
              <th>{{ t('settings.security.userAllowlist.toolName') }}</th>
              <th>{{ t('settings.security.userAllowlist.keyArgs') }}</th>
              <th>{{ t('settings.security.userAllowlist.riskAtApproval') }}</th>
              <th>{{ t('settings.security.userAllowlist.approvedAt') }}</th>
              <th>{{ t('settings.security.userAllowlist.source') }}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="entry in filteredEntries" :key="entry.key">
              <td class="col-check">
                <input
                  type="checkbox"
                  :checked="selectedKeys.has(entry.key)"
                  @change="toggleSelect(entry.key, ($event.target as HTMLInputElement).checked)"
                />
              </td>
              <td><code>{{ entry.toolName }}</code></td>
              <td class="key-args"><code>{{ formatKeyArgs(entry.keyArgs) }}</code></td>
              <td>{{ riskLabel(entry.riskLevelAtApproval) }}</td>
              <td>{{ formatTime(entry.approvedAt) }}</td>
              <td>{{ sourceLabel(entry) }}</td>
              <td>
                <button class="btn btn-sm btn-outline-secondary" @click="removeOne(entry.key)">
                  {{ t('settings.security.userAllowlist.remove') }}
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>

<style scoped>
.user-allowlist-settings {
  max-width: 960px;
}

.section-desc {
  color: var(--color-text-secondary);
  font-size: 13px;
  margin: 0 0 16px;
}

.toolbar {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 12px;
  flex-wrap: wrap;
}

.filter-input {
  flex: 1;
  min-width: 180px;
}

.table-wrap {
  overflow-x: auto;
  border: 1px solid var(--color-border);
  border-radius: 8px;
}

.allowlist-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.allowlist-table th,
.allowlist-table td {
  padding: 8px 10px;
  border-bottom: 1px solid var(--color-border);
  text-align: left;
  vertical-align: top;
}

.allowlist-table th {
  background: var(--color-bg-secondary);
  font-weight: 600;
}

.col-check {
  width: 36px;
}

.key-args {
  max-width: 280px;
  word-break: break-all;
}

.empty-hint {
  padding: 24px;
  text-align: center;
  color: var(--color-text-secondary);
}
</style>
