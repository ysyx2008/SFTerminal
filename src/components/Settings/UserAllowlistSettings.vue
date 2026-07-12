<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Trash2, RefreshCw, Search, Shield, ShieldCheck, ShieldAlert, Ban, FolderLock, FileLock2, HardDrive, Terminal } from 'lucide-vue-next'
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

type BuiltInRulesView = {
  argvCommands: Array<{
    cmd: string
    baseLevel: RiskLevel
    safeFlags: string[]
    pathMode: 'all' | 'fixed' | 'none'
    writesTo: boolean
  }>
  hardBlockedPaths: {
    systemPatterns: Array<{
      description: string
      severity: 'critical' | 'hardened'
    }>
    devNullExemptions: string[]
    userDataRoot: string
    userDataAllowed: string[]
  }
  workspaceZones: {
    free: string[]
    protectedDirs: string[]
    protectedFiles: string[]
  }
}

const { t } = useI18n()
const entries = ref<AllowlistEntry[]>([])
const loading = ref(false)
const filterTool = ref('')
const selectedKeys = ref<Set<string>>(new Set())
const confirmClearAll = ref(false)

// —— 内置安全规则（只读）——
const builtinRules = ref<BuiltInRulesView | null>(null)
const builtinLoading = ref(false)
const builtinError = ref(false)
const builtinFilter = ref('')
const builtinActiveGroup = ref<RiskLevel | 'all'>('all')

// —— 子 tab 切换（我的授权 / 内置规则）——
type SubTab = 'user' | 'builtin' | 'policy'
const activeSubTab = ref<SubTab>('user')

const builtinFilteredCommands = computed(() => {
  if (!builtinRules.value) return []
  const q = builtinFilter.value.trim().toLowerCase()
  let list = builtinRules.value.argvCommands
  if (builtinActiveGroup.value !== 'all') {
    list = list.filter(c => c.baseLevel === builtinActiveGroup.value)
  }
  if (!q) return list
  return list.filter(c => c.cmd.toLowerCase().includes(q))
})

const builtinGroupCounts = computed(() => {
  if (!builtinRules.value) return { safe: 0, moderate: 0, dangerous: 0, blocked: 0, all: 0 }
  const counts = { safe: 0, moderate: 0, dangerous: 0, blocked: 0, all: builtinRules.value.argvCommands.length }
  for (const c of builtinRules.value.argvCommands) {
    counts[c.baseLevel]++
  }
  return counts
})

async function loadBuiltinRules() {
  builtinLoading.value = true
  builtinError.value = false
  try {
    builtinRules.value = await window.electronAPI.allowlist.getBuiltInRules()
  } catch {
    builtinError.value = true
  } finally {
    builtinLoading.value = false
  }
}

function switchSubTab(tab: SubTab) {
  activeSubTab.value = tab
  confirmClearAll.value = false
  if (tab === 'builtin' && !builtinRules.value && !builtinLoading.value) {
    loadBuiltinRules()
  }
  if (tab === 'policy' && !policyLoaded.value && !policyLoading.value) {
    loadPolicy()
  }
}

function pathModeLabel(mode: 'all' | 'fixed' | 'none'): string {
  if (mode === 'all') return t('settings.security.builtinRules.pathModeAll')
  if (mode === 'fixed') return t('settings.security.builtinRules.pathModeFixed')
  return t('settings.security.builtinRules.pathModeNone')
}

function setBuiltinGroup(group: RiskLevel | 'all') {
  builtinActiveGroup.value = group
}

function groupLabel(group: RiskLevel | 'all'): string {
  if (group === 'all') return t('settings.security.builtinRules.groupAll')
  if (group === 'safe') return t('settings.security.builtinRules.groupSafe')
  if (group === 'moderate') return t('settings.security.builtinRules.groupModerate')
  if (group === 'dangerous') return t('settings.security.builtinRules.groupDangerous')
  return t('settings.security.builtinRules.groupBlocked')
}

function groupCount(group: RiskLevel | 'all'): number {
  return builtinGroupCounts.value[group] ?? 0
}

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

// ==================== 命令风险策略 ====================
type CommandRiskPolicy = {
  strictParseFail: RiskLevel
  strictUnknownCmd: RiskLevel
  relaxedParseFail: RiskLevel
  relaxedUnknownCmd: RiskLevel
}

const POLICY_ALLOWED_LEVELS: RiskLevel[] = ['moderate', 'dangerous', 'blocked'] as const
const DEFAULT_POLICY: CommandRiskPolicy = {
  strictParseFail: 'dangerous',
  strictUnknownCmd: 'dangerous',
  relaxedParseFail: 'moderate',
  relaxedUnknownCmd: 'moderate',
}

const policyLoaded = ref(false)
const policyLoading = ref(false)
const policySaving = ref(false)
const policySaved = ref(false)
const policyError = ref(false)
const policy = ref<CommandRiskPolicy>({ ...DEFAULT_POLICY })
const policyDirty = computed(() => {
  const p = policy.value
  return (
    p.strictParseFail !== DEFAULT_POLICY.strictParseFail ||
    p.strictUnknownCmd !== DEFAULT_POLICY.strictUnknownCmd ||
    p.relaxedParseFail !== DEFAULT_POLICY.relaxedParseFail ||
    p.relaxedUnknownCmd !== DEFAULT_POLICY.relaxedUnknownCmd
  )
})

async function loadPolicy() {
  policyLoading.value = true
  policyError.value = false
  try {
    const stored = await window.electronAPI.config.get('commandRiskPolicy')
    policy.value = {
      strictParseFail: stored?.strictParseFail ?? DEFAULT_POLICY.strictParseFail,
      strictUnknownCmd: stored?.strictUnknownCmd ?? DEFAULT_POLICY.strictUnknownCmd,
      relaxedParseFail: stored?.relaxedParseFail ?? DEFAULT_POLICY.relaxedParseFail,
      relaxedUnknownCmd: stored?.relaxedUnknownCmd ?? DEFAULT_POLICY.relaxedUnknownCmd,
    }
    policyLoaded.value = true
  } catch {
    policyError.value = true
  } finally {
    policyLoading.value = false
  }
}

async function savePolicy() {
  policySaving.value = true
  try {
    await window.electronAPI.config.set('commandRiskPolicy', { ...policy.value })
    policySaved.value = true
    setTimeout(() => { policySaved.value = false }, 2000)
  } catch {
    policyError.value = true
  } finally {
    policySaving.value = false
  }
}

function resetPolicy() {
  policy.value = { ...DEFAULT_POLICY }
}
</script>

<template>
  <div class="user-allowlist-settings">
    <!-- 子标签切换 -->
    <div class="sub-tabs">
      <button
        class="sub-tab"
        :class="{ active: activeSubTab === 'user' }"
        @click="switchSubTab('user')"
      >
        ✅ {{ t('settings.security.subTabs.user') }}
        <span class="tab-badge" v-if="entries.length > 0">{{ entries.length }}</span>
      </button>
      <button
        class="sub-tab"
        :class="{ active: activeSubTab === 'builtin' }"
        @click="switchSubTab('builtin')"
      >
        🛡️ {{ t('settings.security.subTabs.builtin') }}
      </button>
      <button
        class="sub-tab"
        :class="{ active: activeSubTab === 'policy' }"
        @click="switchSubTab('policy')"
      >
        ⚙️ {{ t('settings.security.subTabs.policy') }}
      </button>
    </div>

    <!-- ========== 我的授权 ========== -->
    <div v-if="activeSubTab === 'user'" class="sub-panel">
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

    <!-- ========== 内置规则 ========== -->
    <div v-if="activeSubTab === 'builtin'" class="sub-panel">
      <div class="settings-section">
        <div class="section-header">
          <div class="header-left">
            <Shield :size="16" class="builtin-icon" />
            <h4>{{ t('settings.security.builtinRules.title') }}</h4>
          </div>
        </div>
        <p class="section-desc">{{ t('settings.security.builtinRules.description') }}</p>

        <div class="builtin-content">
          <div v-if="builtinLoading" class="builtin-loading">
            <RefreshCw :size="24" class="spinning" />
            <p>{{ t('settings.security.builtinRules.loading') }}</p>
          </div>
          <div v-else-if="builtinError" class="builtin-error">
            <ShieldAlert :size="24" />
            <p>{{ t('settings.security.builtinRules.loadError') }}</p>
            <button class="btn btn-sm" @click="loadBuiltinRules">{{ t('settings.security.builtinRules.retry') }}</button>
          </div>
          <template v-else-if="builtinRules">
            <!-- 命令白名单 -->
            <div class="rule-block">
              <div class="rule-block-header">
                <Terminal :size="15" />
                <h5>{{ t('settings.security.builtinRules.argvCommands') }}</h5>
                <span class="rule-count">{{ t('settings.security.builtinRules.count', { n: builtinGroupCounts.all }) }}</span>
              </div>
              <p class="rule-block-desc">{{ t('settings.security.builtinRules.argvCommandsDesc') }}</p>
              <div class="rule-toolbar">
                <div class="search-box">
                  <Search :size="14" class="search-icon" />
                  <input
                    v-model="builtinFilter"
                    type="text"
                    class="input-field filter-input"
                    :placeholder="t('settings.security.builtinRules.searchPlaceholder')"
                  />
                </div>
                <div class="group-tabs">
                  <button
                    v-for="g in (['all', 'safe', 'moderate', 'dangerous', 'blocked'] as const)"
                    :key="g"
                    class="group-tab"
                    :class="['risk-' + g, { active: builtinActiveGroup === g }]"
                    @click="setBuiltinGroup(g)"
                  >
                    <span class="group-label">{{ groupLabel(g) }}</span>
                    <span class="group-count">{{ groupCount(g) }}</span>
                  </button>
                </div>
              </div>
              <div v-if="builtinFilteredCommands.length === 0" class="builtin-empty">
                {{ t('settings.security.builtinRules.noMatch') }}
              </div>
              <div v-else class="cmd-grid">
                <div class="cmd-grid-head">
                  <div class="cmd-cell cmd-col-cmd">{{ t('settings.security.builtinRules.colCmd') }}</div>
                  <div class="cmd-cell cmd-col-level">{{ t('settings.security.builtinRules.colBaseLevel') }}</div>
                  <div class="cmd-cell cmd-col-flags">{{ t('settings.security.builtinRules.colSafeFlags') }}</div>
                  <div class="cmd-cell cmd-col-path">{{ t('settings.security.builtinRules.colPathMode') }}</div>
                  <div class="cmd-cell cmd-col-writes">{{ t('settings.security.builtinRules.colWritesTo') }}</div>
                </div>
                <div v-for="rule in builtinFilteredCommands" :key="rule.cmd" class="cmd-grid-row">
                  <div class="cmd-cell cmd-col-cmd"><code>{{ rule.cmd }}</code></div>
                  <div class="cmd-cell cmd-col-level">
                    <span class="risk-tag" :class="riskClass(rule.baseLevel)">{{ riskLabel(rule.baseLevel) }}</span>
                  </div>
                  <div class="cmd-cell cmd-col-flags">
                    <code v-if="rule.safeFlags.length">{{ rule.safeFlags.join(' ') }}</code>
                    <span v-else class="muted">—</span>
                  </div>
                  <div class="cmd-cell cmd-col-path">{{ pathModeLabel(rule.pathMode) }}</div>
                  <div class="cmd-cell cmd-col-writes">
                    <span :class="rule.writesTo ? 'writes-yes' : 'muted'">
                      {{ rule.writesTo ? t('settings.security.builtinRules.writesYes') : t('settings.security.builtinRules.writesNo') }}
                    </span>
                  </div>
                </div>
              </div>
            </div>

            <!-- 硬封路径 -->
            <div class="rule-block">
              <div class="rule-block-header">
                <HardDrive :size="15" />
                <h5>{{ t('settings.security.builtinRules.hardBlockedPaths') }}</h5>
              </div>
              <p class="rule-block-desc">{{ t('settings.security.builtinRules.hardBlockedPathsDesc') }}</p>
              <div class="rule-subblock">
                <div class="rule-subtitle">{{ t('settings.security.builtinRules.systemPatternsCritical') }}</div>
                <div class="pattern-chips">
                  <span
                    v-for="(p, i) in builtinRules.hardBlockedPaths.systemPatterns.filter(x => x.severity === 'critical')"
                    :key="'c' + i"
                    class="pattern-chip pattern-chip-critical"
                  >
                    <code>{{ p.description }}</code>
                  </span>
                </div>
              </div>
              <div class="rule-subblock">
                <div class="rule-subtitle">{{ t('settings.security.builtinRules.systemPatternsHardened') }}</div>
                <div class="pattern-chips">
                  <span
                    v-for="(p, i) in builtinRules.hardBlockedPaths.systemPatterns.filter(x => x.severity === 'hardened')"
                    :key="'h' + i"
                    class="pattern-chip pattern-chip-hardened"
                  >
                    <code>{{ p.description }}</code>
                  </span>
                </div>
              </div>
              <div class="rule-subblock">
                <div class="rule-subtitle">{{ t('settings.security.builtinRules.devNullExemptions') }}</div>
                <div class="pattern-chips">
                  <span
                    v-for="e in builtinRules.hardBlockedPaths.devNullExemptions"
                    :key="e"
                    class="pattern-chip pattern-chip-exempt"
                  >
                    <code>{{ e }}</code>
                  </span>
                </div>
              </div>
              <div class="rule-subblock">
                <div class="rule-subtitle">{{ t('settings.security.builtinRules.userDataGuard') }}</div>
                <div class="kv-row">
                  <span class="kv-key">{{ t('settings.security.builtinRules.userDataAllowed') }}</span>
                  <div class="kv-value">
                    <code v-for="e in builtinRules.hardBlockedPaths.userDataAllowed" :key="e" class="allowed-chip">{{ e }}</code>
                  </div>
                </div>
                <div class="kv-row">
                  <span class="kv-key">{{ t('settings.security.builtinRules.userDataRule') }}</span>
                  <span class="kv-value">{{ t('settings.security.builtinRules.userDataRuleText') }}</span>
                </div>
                <div class="kv-row">
                  <span class="kv-key">userData</span>
                  <span class="kv-value"><code class="path-code">{{ builtinRules.hardBlockedPaths.userDataRoot }}</code></span>
                </div>
              </div>
            </div>

            <!-- 工作区分区 -->
            <div class="rule-block">
              <div class="rule-block-header">
                <FolderLock :size="15" />
                <h5>{{ t('settings.security.builtinRules.workspaceZones') }}</h5>
              </div>
              <p class="rule-block-desc">{{ t('settings.security.builtinRules.workspaceZonesDesc') }}</p>
              <div class="rule-subblock">
                <div class="rule-subtitle">{{ t('settings.security.builtinRules.zoneFree') }}</div>
                <div class="pattern-chips">
                  <span v-for="z in builtinRules.workspaceZones.free" :key="z" class="pattern-chip free">
                    <code>{{ z }}/</code>
                  </span>
                </div>
              </div>
              <div class="rule-subblock">
                <div class="rule-subtitle">{{ t('settings.security.builtinRules.zoneProtected') }}</div>
                <div v-if="builtinRules.workspaceZones.protectedDirs.length" class="pattern-chips">
                  <span v-for="d in builtinRules.workspaceZones.protectedDirs" :key="d" class="pattern-chip protected">
                    <code>{{ d }}/</code>
                  </span>
                </div>
                <div v-if="builtinRules.workspaceZones.protectedFiles.length" class="pattern-chips">
                  <span v-for="f in builtinRules.workspaceZones.protectedFiles" :key="f" class="pattern-chip protected">
                    <FileLock2 :size="12" />
                    <code>{{ f }}</code>
                  </span>
                </div>
              </div>
              <div class="rule-subblock">
                <div class="rule-subtitle">{{ t('settings.security.builtinRules.zoneOutside') }}</div>
                <p class="rule-text">{{ t('settings.security.builtinRules.zoneOutsideText') }}</p>
                <p class="rule-text muted">{{ t('settings.security.builtinRules.zoneSystemText') }}</p>
              </div>
            </div>
          </template>
        </div>
      </div>
    </div>

    <!-- ========== 命令风险策略 ========== -->
    <div v-if="activeSubTab === 'policy'" class="sub-panel">
      <div class="settings-section">
        <div class="section-header">
          <div class="header-left">
            <h4>{{ t('settings.security.riskPolicy.title') }}</h4>
          </div>
          <div class="header-actions">
            <button class="btn btn-sm" @click="loadPolicy" :disabled="policyLoading" :title="t('common.refresh')">
              <RefreshCw :size="14" :class="{ spinning: policyLoading }" />
            </button>
          </div>
        </div>

        <p class="section-desc">{{ t('settings.security.riskPolicy.description') }}</p>

        <div v-if="policyLoading" class="empty-state">
          <RefreshCw :size="20" class="spinning" />
          <span>{{ t('settings.security.builtinRules.loading') }}</span>
        </div>

        <div v-else-if="policyError" class="empty-state">
          <ShieldAlert :size="20" />
          <span>{{ t('settings.security.builtinRules.loadError') }}</span>
          <button class="btn btn-sm" @click="loadPolicy">{{ t('settings.security.builtinRules.retry') }}</button>
        </div>

        <div v-else class="policy-grid">
          <div class="policy-row policy-row-header">
            <div class="policy-cell"></div>
            <div class="policy-cell policy-cell-head">
              <div class="policy-mode-tag mode-strict">{{ t('ai.strict') }}</div>
              <div class="policy-mode-desc">{{ t('settings.security.riskPolicy.strictDesc') }}</div>
            </div>
            <div class="policy-cell policy-cell-head">
              <div class="policy-mode-tag mode-relaxed">{{ t('ai.relaxed') }}</div>
              <div class="policy-mode-desc">{{ t('settings.security.riskPolicy.relaxedDesc') }}</div>
            </div>
          </div>

          <div class="policy-row">
            <div class="policy-cell policy-cell-label">
              <div class="policy-scenario-name">{{ t('settings.security.riskPolicy.colParseFail') }}</div>
            </div>
            <div class="policy-cell">
              <select v-model="policy.strictParseFail" class="policy-select">
                <option v-for="lvl in POLICY_ALLOWED_LEVELS" :key="lvl" :value="lvl">
                  {{ riskLabel(lvl) }}
                </option>
              </select>
            </div>
            <div class="policy-cell">
              <select v-model="policy.relaxedParseFail" class="policy-select">
                <option v-for="lvl in POLICY_ALLOWED_LEVELS" :key="lvl" :value="lvl">
                  {{ riskLabel(lvl) }}
                </option>
              </select>
            </div>
          </div>

          <div class="policy-row">
            <div class="policy-cell policy-cell-label">
              <div class="policy-scenario-name">{{ t('settings.security.riskPolicy.colUnknownCmd') }}</div>
            </div>
            <div class="policy-cell">
              <select v-model="policy.strictUnknownCmd" class="policy-select">
                <option v-for="lvl in POLICY_ALLOWED_LEVELS" :key="lvl" :value="lvl">
                  {{ riskLabel(lvl) }}
                </option>
              </select>
            </div>
            <div class="policy-cell">
              <select v-model="policy.relaxedUnknownCmd" class="policy-select">
                <option v-for="lvl in POLICY_ALLOWED_LEVELS" :key="lvl" :value="lvl">
                  {{ riskLabel(lvl) }}
                </option>
              </select>
            </div>
          </div>
        </div>

        <div v-if="!policyLoading && !policyError" class="policy-actions">
          <button class="btn btn-sm" @click="resetPolicy" :disabled="!policyDirty">
            {{ t('settings.security.riskPolicy.reset') }}
          </button>
          <button class="btn btn-sm btn-primary" @click="savePolicy" :disabled="policySaving">
            {{ policySaving ? t('common.saving') : t('common.save') }}
          </button>
          <span v-if="policySaved" class="policy-saved">{{ t('settings.security.riskPolicy.saved') }}</span>
        </div>

        <p class="rule-text muted">{{ t('settings.security.riskPolicy.freeModeHint') }}</p>
        <p class="rule-text muted">{{ t('settings.security.riskPolicy.blockedHint') }}</p>
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

/* —— 子标签切换（对齐 SkillSettings）—— */
.sub-tabs {
  display: flex;
  gap: 4px;
  background: var(--bg-tertiary);
  border-radius: 8px;
  padding: 4px;
}

.sub-tab {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 8px 16px;
  font-size: 13px;
  font-weight: 500;
  color: var(--text-secondary);
  background: transparent;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.sub-tab:hover {
  color: var(--text-primary);
  background: var(--bg-hover);
}

.sub-tab.active {
  color: var(--text-primary);
  background: var(--bg-secondary);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
}

.tab-badge {
  font-size: 11px;
  padding: 1px 6px;
  background: var(--accent-green);
  color: var(--bg-primary);
  border-radius: 10px;
}

.sub-panel {
  display: flex;
  flex-direction: column;
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

.builtin-icon {
  color: var(--accent-primary);
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

/* —— 内置规则面板 —— */
.builtin-content {
  margin-top: 12px;
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.builtin-loading,
.builtin-error {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 24px;
  color: var(--text-muted);
}

.builtin-error .btn {
  margin-top: 4px;
}

.rule-block {
  background: var(--bg-secondary);
  border-radius: 8px;
  padding: 14px;
  border: 1px solid var(--border-color);
}

.rule-block-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

.rule-block-header h5 {
  font-size: 13px;
  font-weight: 600;
  margin: 0;
  color: var(--text-primary);
}

.rule-count {
  font-size: 11px;
  color: var(--text-muted);
  padding: 1px 6px;
  background: var(--bg-tertiary);
  border-radius: 8px;
  margin-left: auto;
}

.rule-block-desc {
  font-size: 12px;
  color: var(--text-muted);
  margin: 0 0 12px 0;
  line-height: 1.5;
}

.rule-toolbar {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 10px;
  flex-wrap: wrap;
}

.rule-toolbar .search-box {
  min-width: 160px;
  max-width: 240px;
}

.group-tabs {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}

.group-tab {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 10px;
  font-size: 11px;
  border-radius: 12px;
  border: 1px solid var(--border-color);
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.15s;
  font-weight: 500;
}

.group-tab:hover {
  border-color: var(--accent-primary);
  color: var(--text-primary);
}

.group-label {
  font-size: 11px;
}

.group-count {
  font-size: 10px;
  font-weight: 600;
  opacity: 0.85;
}

.group-tab.active {
  background: var(--accent-primary);
  color: var(--accent-contrast);
  border-color: var(--accent-primary);
}

.group-tab.risk-all.active {
  background: var(--accent-primary);
  color: var(--accent-contrast);
  border-color: var(--accent-primary);
}

.group-tab.risk-safe.active {
  background: #22c55e;
  color: #fff;
  border-color: #22c55e;
}

.group-tab.risk-moderate.active {
  background: #f59e0b;
  color: #fff;
  border-color: #f59e0b;
}

.group-tab.risk-dangerous.active {
  background: #ef4444;
  color: #fff;
  border-color: #ef4444;
}

.group-tab.risk-blocked.active {
  background: #6b7280;
  color: #fff;
  border-color: #6b7280;
}

.builtin-empty {
  padding: 16px;
  text-align: center;
  font-size: 12px;
  color: var(--text-muted);
}

.cmd-grid {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 360px;
  overflow-y: auto;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  background: var(--bg-tertiary);
}

.cmd-grid-head {
  display: grid;
  grid-template-columns: 80px 90px 1fr 110px 60px;
  gap: 8px;
  padding: 6px 10px;
  background: var(--bg-tertiary);
  position: sticky;
  top: 0;
  z-index: 1;
  font-size: 10px;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  border-bottom: 1px solid var(--border-color);
}

.cmd-grid-row {
  display: grid;
  grid-template-columns: 80px 90px 1fr 110px 60px;
  gap: 8px;
  padding: 6px 10px;
  background: var(--bg-secondary);
  font-size: 12px;
  align-items: center;
  border-bottom: 1px solid var(--border-color);
}

.cmd-grid-row:last-child {
  border-bottom: none;
}

.cmd-grid-row:hover {
  background: var(--bg-tertiary);
}

.cmd-cell {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cmd-cell code {
  font-family: 'SF Mono', Menlo, Consolas, monospace;
  font-size: 12px;
  color: var(--text-primary);
  word-break: break-all;
  white-space: normal;
}

.cmd-col-flags code {
  color: var(--text-secondary);
  font-size: 11px;
}

.cmd-col-path {
  color: var(--text-secondary);
  font-size: 11px;
}

.cmd-col-writes {
  text-align: center;
  font-size: 11px;
}

.writes-yes {
  color: #f59e0b;
  font-weight: 500;
}

.muted {
  color: var(--text-muted);
}

.rule-subblock {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px dashed var(--border-color);
}

.rule-subblock:first-of-type {
  border-top: none;
  padding-top: 0;
  margin-top: 0;
}

.rule-subtitle {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-secondary);
  margin-bottom: 6px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.pattern-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.pattern-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  font-size: 11px;
}

.pattern-chip code {
  font-family: 'SF Mono', Menlo, Consolas, monospace;
  color: var(--text-secondary);
}

.pattern-chip.free {
  border-color: rgba(34, 197, 94, 0.3);
  background: rgba(34, 197, 94, 0.08);
}

.pattern-chip.protected {
  border-color: rgba(245, 158, 11, 0.3);
  background: rgba(245, 158, 11, 0.08);
}

.pattern-chip-critical {
  border-color: rgba(239, 68, 68, 0.4);
  background: rgba(239, 68, 68, 0.1);
}

.pattern-chip-critical code {
  color: #ef4444;
}

.pattern-chip-hardened {
  border-color: rgba(245, 158, 11, 0.3);
  background: rgba(245, 158, 11, 0.08);
}

.pattern-chip-hardened code {
  color: #f59e0b;
}

.pattern-chip-exempt {
  border-color: rgba(34, 197, 94, 0.3);
  background: rgba(34, 197, 94, 0.08);
}

.pattern-chip-exempt code {
  color: #22c55e;
}

.allowed-chip {
  font-family: 'SF Mono', Menlo, Consolas, monospace;
  color: #22c55e;
  background: rgba(34, 197, 94, 0.1);
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 11px;
}

.kv-row {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  margin-bottom: 6px;
  font-size: 12px;
}

.kv-row:last-child {
  margin-bottom: 0;
}

.kv-key {
  flex-shrink: 0;
  width: 90px;
  color: var(--text-muted);
}

.kv-value {
  flex: 1;
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  align-items: center;
  color: var(--text-secondary);
}

.path-code {
  font-family: 'SF Mono', Menlo, Consolas, monospace;
  font-size: 11px;
  color: var(--text-muted);
  word-break: break-all;
  white-space: normal;
}

.rule-text {
  font-size: 12px;
  color: var(--text-secondary);
  margin: 4px 0 0 0;
  line-height: 1.5;
}

.rule-text.muted {
  color: var(--text-muted);
  font-size: 11px;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.spinning {
  animation: spin 1s linear infinite;
}

/* -- 命令风险策略 -- */
.policy-grid {
  display: flex;
  flex-direction: column;
  gap: 1px;
  background: var(--border-color);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  overflow: hidden;
  margin-top: 12px;
}

.policy-row {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  background: var(--bg-secondary);
}

.policy-row-header {
  background: var(--bg-tertiary);
}

.policy-cell {
  padding: 10px 12px;
  display: flex;
  align-items: center;
  gap: 8px;
  border-right: 1px solid var(--border-color);
}

.policy-cell:last-child {
  border-right: none;
}

.policy-cell-head {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  text-align: center;
}

.policy-cell-label {
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
}

.policy-scenario-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}

.policy-mode-tag {
  font-size: 11px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 4px;
}

.policy-mode-tag.mode-strict {
  background: rgba(239, 68, 68, 0.12);
  color: #ef4444;
}

.policy-mode-tag.mode-relaxed {
  background: rgba(245, 158, 11, 0.12);
  color: #f59e0b;
}

.policy-mode-desc {
  font-size: 11px;
  color: var(--text-muted);
  line-height: 1.4;
}

.policy-select {
  width: 100%;
  padding: 6px 8px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  background: var(--bg-primary);
  color: var(--text-primary);
  font-size: 12px;
  cursor: pointer;
}

.policy-select:focus {
  outline: none;
  border-color: var(--accent-color, #3b82f6);
}

.policy-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
}

.policy-saved {
  font-size: 12px;
  color: #22c55e;
}

.section-desc {
  font-size: 12px;
  color: var(--text-secondary);
  margin: 0 0 8px 0;
  line-height: 1.5;
}
</style>
