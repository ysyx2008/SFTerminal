<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Trash2, RefreshCw, Search, Shield, ShieldCheck, ShieldAlert, Ban, FolderLock, FileLock2, HardDrive, Terminal, Plus, CheckCircle2, SlidersHorizontal, CircleHelp } from 'lucide-vue-next'
import type { RiskLevel, CommandRiskPolicy } from '@shared/types/agent'
import { DEFAULT_COMMAND_RISK_POLICY } from '@shared/types/agent'

type AllowlistEntry = {
  key: string
  toolName: string
  keyArgs: Record<string, unknown>
  riskLevelAtApproval: RiskLevel
  approvedAt: number
  sourceAgentKey: string
  sourceKind: 'task' | 'companion' | 'watch' | 'wakeup' | 'manual'
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

const { t, tm } = useI18n()
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

// —— 用户命令规则 ——
type UserCommandRuleRow = {
  cmd: string
  baseLevel: RiskLevel
  writesTo: boolean
  pathMode: 'all' | 'fixed' | 'none'
  safeFlags: string[]
}
const userCommandRules = ref<UserCommandRuleRow[]>([])
const userRulesLoading = ref(false)
const userRuleSaving = ref(false)
const userRuleError = ref('')
const newUserRuleCmd = ref('')
const newUserRuleLevel = ref<RiskLevel>('safe')
const newUserRuleWrites = ref(false)
const newUserRuleFlags = ref('')
const USER_RULE_LEVELS: RiskLevel[] = ['safe', 'moderate', 'dangerous']

async function loadUserCommandRules() {
  userRulesLoading.value = true
  try {
    userCommandRules.value = await window.electronAPI.commandRules.list()
  } catch {
    userCommandRules.value = []
  } finally {
    userRulesLoading.value = false
  }
}

async function addUserCommandRule() {
  const cmd = newUserRuleCmd.value.trim()
  userRuleError.value = ''
  if (!cmd || userRuleSaving.value) return
  userRuleSaving.value = true
  try {
    const result = await window.electronAPI.commandRules.upsert({
      cmd,
      baseLevel: newUserRuleLevel.value,
      writesTo: newUserRuleWrites.value,
      safeFlags: newUserRuleFlags.value,
    })
    if (!result.ok) {
      if (result.error === 'builtin_conflict') {
        userRuleError.value = t('settings.security.userCommandRules.errBuiltin')
      } else if (result.error === 'invalid_level') {
        userRuleError.value = t('settings.security.userCommandRules.errLevel')
      } else {
        userRuleError.value = t('settings.security.userCommandRules.errGeneric')
      }
      return
    }
    newUserRuleCmd.value = ''
    newUserRuleFlags.value = ''
    newUserRuleWrites.value = false
    newUserRuleLevel.value = 'safe'
    await loadUserCommandRules()
  } catch {
    userRuleError.value = t('settings.security.userCommandRules.errGeneric')
  } finally {
    userRuleSaving.value = false
  }
}

async function removeUserCommandRule(cmd: string) {
  await window.electronAPI.commandRules.remove(cmd)
  await loadUserCommandRules()
}

// —— 子 tab 切换（我的授权 / 命令规则 / 风险策略）——
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
  if (
    tab !== activeSubTab.value &&
    policyUnsaved.value &&
    (activeSubTab.value === 'policy' || activeSubTab.value === 'builtin')
  ) {
    if (!window.confirm(t('settings.security.riskPolicy.unsavedLeave'))) {
      return
    }
  }
  activeSubTab.value = tab
  closePolicyTip()
  confirmClearAll.value = false
  if (tab === 'builtin') {
    if (!builtinRules.value && !builtinLoading.value) {
      loadBuiltinRules()
    }
    loadUserCommandRules()
    // 工作区分区含可配置项（额外自由区 / 区外写），需加载策略
    if (!policyLoaded.value && !policyLoading.value) {
      loadPolicy()
    }
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
  let list = entries.value
  if (q) {
    list = list.filter(e =>
      e.toolName.toLowerCase().includes(q) ||
      displayToolName(e).toLowerCase().includes(q) ||
      formatEntrySummary(e).toLowerCase().includes(q),
    )
  }
  // exec / execute_command 同一命令只展示一条（优先规范名）
  const seenCmd = new Set<string>()
  const out: AllowlistEntry[] = []
  const ordered = [...list].sort((a, b) => {
    if (a.toolName === 'execute_command' && b.toolName === 'exec') return -1
    if (a.toolName === 'exec' && b.toolName === 'execute_command') return 1
    return 0
  })
  for (const e of ordered) {
    if (e.toolName === 'exec' || e.toolName === 'execute_command') {
      const fp = JSON.stringify(e.keyArgs)
      if (seenCmd.has(fp)) continue
      seenCmd.add(fp)
    }
    out.push(e)
  }
  return out
})

/** 去重后的条目数（角标 / 标题计数） */
const uniqueEntryCount = computed(() => {
  const seen = new Set<string>()
  let n = 0
  for (const e of entries.value) {
    if (e.toolName === 'exec' || e.toolName === 'execute_command') {
      const fp = JSON.stringify(e.keyArgs)
      if (seen.has(fp)) continue
      seen.add(fp)
    }
    n++
  }
  return n
})

function displayToolName(entry: AllowlistEntry): string {
  if (entry.toolName === 'exec' || entry.toolName === 'execute_command') {
    return t('settings.security.userAllowlist.shellCommand')
  }
  return entry.toolName
}

function formatKeyArgs(args: Record<string, unknown>): string {
  try {
    const s = JSON.stringify(args)
    return s.length > 120 ? s.slice(0, 117) + '...' : s
  } catch {
    return String(args)
  }
}

/** 授权项主文案：命令类直接显示 command，其它仍展示关键参数 */
function formatEntrySummary(entry: AllowlistEntry): string {
  if (
    (entry.toolName === 'exec' || entry.toolName === 'execute_command') &&
    typeof entry.keyArgs.command === 'string'
  ) {
    return entry.keyArgs.command
  }
  return formatKeyArgs(entry.keyArgs)
}

function formatEntrySummaryShort(entry: AllowlistEntry): string {
  const full = formatEntrySummary(entry)
  if (full.length <= 80) return full
  return full.slice(0, 77) + '...'
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
  if (entry.sourceKind === 'wakeup') return t('settings.security.userAllowlist.sourceWakeup')
  if (entry.sourceKind === 'manual') return t('settings.security.userAllowlist.sourceManual')
  return entry.sourceAgentKey || t('settings.security.userAllowlist.sourceTask')
}

const addCommand = ref('')
const addBusy = ref(false)
const addError = ref('')

async function addEntry() {
  const command = addCommand.value.trim()
  if (!command || addBusy.value) return
  addBusy.value = true
  addError.value = ''
  try {
    const result = await window.electronAPI.allowlist.add({ command })
    if (!result.success) {
      addError.value = result.error === 'blocked_command'
        ? t('settings.security.userAllowlist.addBlocked')
        : t('settings.security.userAllowlist.addFailed')
      return
    }
    addCommand.value = ''
    await loadEntries()
  } catch {
    addError.value = t('settings.security.userAllowlist.addFailed')
  } finally {
    addBusy.value = false
  }
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

onMounted(() => {
  loadEntries()
  document.addEventListener('click', closePolicyTip)
  document.addEventListener('keydown', onPolicyTipKeydown)
})

onUnmounted(() => {
  document.removeEventListener('click', closePolicyTip)
  document.removeEventListener('keydown', onPolicyTipKeydown)
})

// ==================== 命令风险策略 ====================
const POLICY_ALLOWED_LEVELS: RiskLevel[] = ['moderate', 'dangerous', 'blocked']
const DEFAULT_POLICY: CommandRiskPolicy = {
  ...DEFAULT_COMMAND_RISK_POLICY,
  extraFreeDirs: [],
}

const policyLoaded = ref(false)
const policyLoading = ref(false)
const policySaving = ref(false)
const policySaved = ref(false)
const policyError = ref(false)
const policy = ref<CommandRiskPolicy>({ ...DEFAULT_POLICY, extraFreeDirs: [] })
/** 上次成功加载/保存的快照，用于判断未保存更改 */
const savedPolicy = ref<CommandRiskPolicy>({ ...DEFAULT_POLICY, extraFreeDirs: [] })
const newFreeDir = ref('')
const freeDirError = ref('')

function clonePolicy(p: CommandRiskPolicy): CommandRiskPolicy {
  return {
    ...p,
    extraFreeDirs: [...p.extraFreeDirs],
  }
}

function policiesEqual(a: CommandRiskPolicy, b: CommandRiskPolicy): boolean {
  return (
    a.strictParseFail === b.strictParseFail &&
    a.strictUnknownCmd === b.strictUnknownCmd &&
    a.strictIndirection === b.strictIndirection &&
    a.strictDynamicPath === b.strictDynamicPath &&
    a.relaxedParseFail === b.relaxedParseFail &&
    a.relaxedUnknownCmd === b.relaxedUnknownCmd &&
    a.relaxedIndirection === b.relaxedIndirection &&
    a.relaxedDynamicPath === b.relaxedDynamicPath &&
    a.relaxedConfirmModerate === b.relaxedConfirmModerate &&
    a.outsideWritesUpgrade === b.outsideWritesUpgrade &&
    a.subAgentBlockDangerous === b.subAgentBlockDangerous &&
    a.extraFreeDirs.length === b.extraFreeDirs.length &&
    a.extraFreeDirs.every((d, i) => d === b.extraFreeDirs[i])
  )
}

/** 相对已保存快照是否有未保存修改 */
const policyUnsaved = computed(() => !policiesEqual(policy.value, savedPolicy.value))
/** 相对默认值是否不同（控制「恢复默认」是否可点） */
const policyDiffersFromDefault = computed(() => !policiesEqual(policy.value, DEFAULT_POLICY))

function mergePolicy(stored: Partial<CommandRiskPolicy> | null | undefined): CommandRiskPolicy {
  return {
    ...DEFAULT_POLICY,
    ...(stored || {}),
    extraFreeDirs: Array.isArray(stored?.extraFreeDirs)
      ? stored!.extraFreeDirs!.filter(d => typeof d === 'string' && d.trim())
      : [],
  }
}

async function loadPolicy() {
  policyLoading.value = true
  policyError.value = false
  try {
    const stored = await window.electronAPI.config.get('commandRiskPolicy')
    const merged = mergePolicy(stored)
    policy.value = merged
    savedPolicy.value = clonePolicy(merged)
    policyLoaded.value = true
  } catch {
    policyError.value = true
  } finally {
    policyLoading.value = false
  }
}

async function savePolicy() {
  if (!policyUnsaved.value || policySaving.value) return
  policySaving.value = true
  policyError.value = false
  try {
    await window.electronAPI.config.set('commandRiskPolicy', {
      ...policy.value,
      extraFreeDirs: [...policy.value.extraFreeDirs],
    })
    savedPolicy.value = clonePolicy(policy.value)
    policySaved.value = true
    setTimeout(() => { policySaved.value = false }, 2000)
  } catch {
    policyError.value = true
  } finally {
    policySaving.value = false
  }
}

function resetPolicy() {
  policy.value = { ...DEFAULT_POLICY, extraFreeDirs: [] }
}

/** 仅恢复路径相关策略（工作区分区可配置项） */
function resetPathPolicy() {
  policy.value = {
    ...policy.value,
    outsideWritesUpgrade: DEFAULT_POLICY.outsideWritesUpgrade,
    extraFreeDirs: [],
  }
}

const pathPolicyDiffersFromDefault = computed(() =>
  policy.value.outsideWritesUpgrade !== DEFAULT_POLICY.outsideWritesUpgrade ||
  policy.value.extraFreeDirs.length > 0,
)

function isAbsoluteDirPath(dir: string): boolean {
  return dir.startsWith('/') || /^[A-Za-z]:[\\/]/.test(dir) || dir.startsWith('\\\\')
}

function addFreeDir() {
  const dir = newFreeDir.value.trim()
  freeDirError.value = ''
  if (!dir) return
  if (!isAbsoluteDirPath(dir)) {
    freeDirError.value = t('settings.security.riskPolicy.extraFreeDirsInvalid')
    return
  }
  if (!policy.value.extraFreeDirs.includes(dir)) {
    policy.value.extraFreeDirs = [...policy.value.extraFreeDirs, dir]
  }
  newFreeDir.value = ''
}

function removeFreeDir(dir: string) {
  policy.value.extraFreeDirs = policy.value.extraFreeDirs.filter(d => d !== dir)
}

type PolicyLevelField =
  | 'strictParseFail' | 'relaxedParseFail'
  | 'strictUnknownCmd' | 'relaxedUnknownCmd'
  | 'strictIndirection' | 'relaxedIndirection'
  | 'strictDynamicPath' | 'relaxedDynamicPath'

type PolicyTipLabel = 'colParseFail' | 'colUnknownCmd' | 'colIndirection' | 'colDynamicPath'
type UserRuleTipField = 'writes' | 'flags'
type HelpTip =
  | { kind: 'policy'; label: PolicyTipLabel }
  | { kind: 'userRule'; field: UserRuleTipField }

const openHelpTip = ref<HelpTip | null>(null)
const helpTipPos = ref({ top: 0, left: 0 })

const policyTipExamples = computed((): string[] => {
  if (openHelpTip.value?.kind !== 'policy') return []
  const raw = tm(`settings.security.riskPolicy.${openHelpTip.value.label}TipExamples`)
  return Array.isArray(raw) ? raw.map(String) : []
})

const helpTipTitle = computed(() => {
  const tip = openHelpTip.value
  if (!tip) return ''
  if (tip.kind === 'policy') return t(`settings.security.riskPolicy.${tip.label}`)
  return tip.field === 'writes'
    ? t('settings.security.userCommandRules.writesLabel')
    : t('settings.security.userCommandRules.flagsFieldLabel')
})

const helpTipBody = computed(() => {
  const tip = openHelpTip.value
  if (!tip) return ''
  if (tip.kind === 'policy') return t(`settings.security.riskPolicy.${tip.label}TipBody`)
  return tip.field === 'writes'
    ? t('settings.security.userCommandRules.writesTip')
    : t('settings.security.userCommandRules.flagsTip')
})

function placeHelpTip(el: HTMLElement) {
  const rect = el.getBoundingClientRect()
  const width = 320
  const left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12))
  helpTipPos.value = { top: rect.bottom + 8, left }
}

function togglePolicyTip(label: PolicyTipLabel, e: MouseEvent) {
  e.stopPropagation()
  if (openHelpTip.value?.kind === 'policy' && openHelpTip.value.label === label) {
    openHelpTip.value = null
    return
  }
  placeHelpTip(e.currentTarget as HTMLElement)
  openHelpTip.value = { kind: 'policy', label }
}

function toggleUserRuleTip(field: UserRuleTipField, e: MouseEvent) {
  e.stopPropagation()
  if (openHelpTip.value?.kind === 'userRule' && openHelpTip.value.field === field) {
    openHelpTip.value = null
    return
  }
  placeHelpTip(e.currentTarget as HTMLElement)
  openHelpTip.value = { kind: 'userRule', field }
}

function closePolicyTip() {
  openHelpTip.value = null
}

function onPolicyTipKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') closePolicyTip()
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
        <CheckCircle2 :size="14" />
        {{ t('settings.security.subTabs.user') }}
        <span class="tab-badge" v-if="uniqueEntryCount > 0">{{ uniqueEntryCount }}</span>
      </button>
      <button
        class="sub-tab"
        :class="{ active: activeSubTab === 'builtin' }"
        @click="switchSubTab('builtin')"
      >
        <Shield :size="14" />
        {{ t('settings.security.subTabs.builtin') }}
      </button>
      <button
        class="sub-tab"
        :class="{ active: activeSubTab === 'policy' }"
        @click="switchSubTab('policy')"
      >
        <SlidersHorizontal :size="14" />
        {{ t('settings.security.subTabs.policy') }}
      </button>
    </div>

    <!-- ========== 我的授权 ========== -->
    <div v-if="activeSubTab === 'user'" class="sub-panel">
      <div class="settings-section">
        <div class="section-header">
          <div class="header-left">
            <h4>{{ t('settings.security.userAllowlist.title') }}</h4>
            <span class="count-badge" v-if="uniqueEntryCount > 0">{{ uniqueEntryCount }}</span>
          </div>
          <div class="header-actions">
            <button class="btn btn-sm" @click="loadEntries" :disabled="loading" :title="t('common.refresh')">
              <RefreshCw :size="14" :class="{ spinning: loading }" />
            </button>
          </div>
        </div>
        <p class="section-desc">{{ t('settings.security.userAllowlist.description') }}</p>

        <div class="add-entry-form">
          <input
            v-model="addCommand"
            type="text"
            class="input-field add-command-input"
            :placeholder="t('settings.security.userAllowlist.addPlaceholder')"
            @keydown.enter.prevent="addEntry"
          />
          <button class="btn btn-sm btn-primary" :disabled="addBusy || !addCommand.trim()" @click="addEntry">
            <Plus :size="14" />
            {{ t('settings.security.userAllowlist.add') }}
          </button>
        </div>
        <p v-if="addError" class="add-error">{{ addError }}</p>

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
              <span class="clear-confirm-hint">{{ t('settings.security.userAllowlist.confirmClear') }}</span>
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
            <span class="count-text">{{ filteredEntries.length }} / {{ uniqueEntryCount }}</span>
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
                <code class="entry-tool">{{ displayToolName(entry) }}</code>
                <span class="risk-tag" :class="riskClass(entry.riskLevelAtApproval)">
                  {{ riskLabel(entry.riskLevelAtApproval) }}
                </span>
              </div>
              <div class="entry-args" :title="formatEntrySummary(entry)">
                <code>{{ formatEntrySummaryShort(entry) }}</code>
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

    <!-- ========== 命令规则 ========== -->
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
            <!-- 我的命令规则 -->
            <div class="rule-block">
              <div class="rule-block-header">
                <Terminal :size="15" />
                <h5>{{ t('settings.security.userCommandRules.title') }}</h5>
                <span class="rule-count">{{ t('settings.security.builtinRules.count', { n: userCommandRules.length }) }}</span>
              </div>
              <p class="rule-block-desc">{{ t('settings.security.userCommandRules.description') }}</p>

              <div class="user-rule-form">
                <input
                  v-model="newUserRuleCmd"
                  type="text"
                  class="input-field user-rule-cmd"
                  :placeholder="t('settings.security.userCommandRules.cmdPlaceholder')"
                  @keyup.enter="addUserCommandRule"
                />
                <select v-model="newUserRuleLevel" class="input-field user-rule-level">
                  <option v-for="lvl in USER_RULE_LEVELS" :key="lvl" :value="lvl">{{ riskLabel(lvl) }}</option>
                </select>
                <label class="user-rule-writes">
                  <input v-model="newUserRuleWrites" type="checkbox" />
                  <span>{{ t('settings.security.userCommandRules.writesLabel') }}</span>
                  <button
                    type="button"
                    class="user-rule-help"
                    :class="{ open: openHelpTip?.kind === 'userRule' && openHelpTip.field === 'writes' }"
                    :aria-expanded="openHelpTip?.kind === 'userRule' && openHelpTip.field === 'writes'"
                    :aria-label="t('settings.security.userCommandRules.writesLabel')"
                    @click="toggleUserRuleTip('writes', $event)"
                  >
                    <CircleHelp :size="13" :stroke-width="2" />
                  </button>
                </label>
                <div class="user-rule-flags-wrap">
                  <input
                    v-model="newUserRuleFlags"
                    type="text"
                    class="input-field user-rule-flags"
                    :placeholder="t('settings.security.userCommandRules.flagsPlaceholder')"
                    @keyup.enter="addUserCommandRule"
                  />
                  <button
                    type="button"
                    class="user-rule-help"
                    :class="{ open: openHelpTip?.kind === 'userRule' && openHelpTip.field === 'flags' }"
                    :aria-expanded="openHelpTip?.kind === 'userRule' && openHelpTip.field === 'flags'"
                    :aria-label="t('settings.security.userCommandRules.flagsFieldLabel')"
                    @click="toggleUserRuleTip('flags', $event)"
                  >
                    <CircleHelp :size="13" :stroke-width="2" />
                  </button>
                </div>
                <button
                  class="btn btn-sm btn-primary"
                  :disabled="userRuleSaving || !newUserRuleCmd.trim()"
                  @click="addUserCommandRule"
                >
                  <Plus :size="14" />
                  {{ t('settings.security.userCommandRules.add') }}
                </button>
              </div>
              <p v-if="userRuleError" class="add-error">{{ userRuleError }}</p>

              <div v-if="userRulesLoading" class="builtin-empty">{{ t('settings.security.builtinRules.loading') }}</div>
              <div v-else-if="userCommandRules.length === 0" class="builtin-empty">
                {{ t('settings.security.userCommandRules.empty') }}
              </div>
              <div v-else class="cmd-grid cmd-grid-user">
                <div class="cmd-grid-head">
                  <div class="cmd-cell cmd-col-cmd">{{ t('settings.security.builtinRules.colCmd') }}</div>
                  <div class="cmd-cell cmd-col-level">{{ t('settings.security.builtinRules.colBaseLevel') }}</div>
                  <div class="cmd-cell cmd-col-flags">{{ t('settings.security.builtinRules.colSafeFlags') }}</div>
                  <div class="cmd-cell cmd-col-path">{{ t('settings.security.builtinRules.colPathMode') }}</div>
                  <div class="cmd-cell cmd-col-writes">{{ t('settings.security.builtinRules.colWritesTo') }}</div>
                  <div class="cmd-cell cmd-col-actions"></div>
                </div>
                <div v-for="rule in userCommandRules" :key="rule.cmd" class="cmd-grid-row">
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
                  <div class="cmd-cell cmd-col-actions">
                    <button
                      class="btn btn-sm btn-icon"
                      :title="t('common.delete')"
                      @click="removeUserCommandRule(rule.cmd)"
                    >
                      <Trash2 :size="14" />
                    </button>
                  </div>
                </div>
              </div>
            </div>

            <!-- 命令风险基线 -->
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
                    v-for="g in (['all', 'blocked', 'dangerous', 'moderate', 'safe'] as const)"
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

            <!-- 工作区分区（内置说明 + 可配置：额外自由区 / 区外写） -->
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
                <label v-if="policyLoaded && !policyError" class="policy-toggle workspace-config-toggle">
                  <input v-model="policy.outsideWritesUpgrade" type="checkbox" />
                  <div>
                    <div class="policy-toggle-title">{{ t('settings.security.riskPolicy.outsideWritesUpgrade') }}</div>
                    <div class="policy-toggle-desc">{{ t('settings.security.riskPolicy.outsideWritesUpgradeDesc') }}</div>
                  </div>
                </label>
              </div>

              <div v-if="policyLoaded && !policyError" class="rule-subblock workspace-config">
                <div class="rule-subtitle">{{ t('settings.security.riskPolicy.extraFreeDirs') }}</div>
                <p class="rule-text muted">{{ t('settings.security.riskPolicy.extraFreeDirsDesc') }}</p>
                <div class="add-entry-form" style="margin-top: 8px">
                  <input
                    v-model="newFreeDir"
                    type="text"
                    class="input-field add-command-input"
                    :placeholder="t('settings.security.riskPolicy.extraFreeDirsPlaceholder')"
                    @keydown.enter.prevent="addFreeDir"
                  />
                  <button class="btn btn-sm" :disabled="!newFreeDir.trim()" @click="addFreeDir">
                    <Plus :size="14" />
                    {{ t('settings.security.userAllowlist.add') }}
                  </button>
                </div>
                <p v-if="freeDirError" class="add-error">{{ freeDirError }}</p>
                <div v-if="policy.extraFreeDirs.length" class="free-dir-list">
                  <div v-for="dir in policy.extraFreeDirs" :key="dir" class="free-dir-item">
                    <code>{{ dir }}</code>
                    <button class="btn btn-sm btn-icon" @click="removeFreeDir(dir)" :title="t('common.delete')">
                      <Trash2 :size="12" />
                    </button>
                  </div>
                </div>
                <div class="policy-actions workspace-policy-actions">
                  <button class="btn btn-sm" @click="resetPathPolicy" :disabled="!pathPolicyDiffersFromDefault">
                    {{ t('settings.security.riskPolicy.resetPath') }}
                  </button>
                  <button
                    class="btn btn-sm btn-primary"
                    @click="savePolicy"
                    :disabled="policySaving || !policyUnsaved"
                  >
                    {{ policySaving ? t('common.saving') : t('common.save') }}
                  </button>
                  <span v-if="policySaved" class="policy-saved">{{ t('settings.security.riskPolicy.saved') }}</span>
                  <span v-else-if="policyUnsaved" class="policy-unsaved">{{ t('settings.security.riskPolicy.unsaved') }}</span>
                </div>
              </div>
              <div v-else-if="policyLoading" class="rule-text muted">
                {{ t('settings.security.builtinRules.loading') }}
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

        <div v-else class="policy-body">
          <div class="policy-grid">
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

            <div
              v-for="row in ([
                { label: 'colParseFail', strict: 'strictParseFail', relaxed: 'relaxedParseFail' },
                { label: 'colUnknownCmd', strict: 'strictUnknownCmd', relaxed: 'relaxedUnknownCmd' },
                { label: 'colIndirection', strict: 'strictIndirection', relaxed: 'relaxedIndirection' },
                { label: 'colDynamicPath', strict: 'strictDynamicPath', relaxed: 'relaxedDynamicPath' },
              ] as Array<{ label: string; strict: PolicyLevelField; relaxed: PolicyLevelField }>)"
              :key="row.label"
              class="policy-row"
            >
              <div class="policy-cell policy-cell-label">
                <span class="policy-scenario-name">{{ t(`settings.security.riskPolicy.${row.label}`) }}</span>
                <button
                  type="button"
                  class="policy-scenario-help"
                  :class="{ open: openHelpTip?.kind === 'policy' && openHelpTip.label === row.label }"
                  :aria-expanded="openHelpTip?.kind === 'policy' && openHelpTip.label === row.label"
                  :aria-label="t(`settings.security.riskPolicy.${row.label}`)"
                  @click="togglePolicyTip(row.label as PolicyTipLabel, $event)"
                >
                  <CircleHelp :size="13" :stroke-width="2" />
                </button>
              </div>
              <div class="policy-cell">
                <div class="policy-radio-group" role="radiogroup">
                  <label
                    v-for="lvl in POLICY_ALLOWED_LEVELS"
                    :key="row.strict + lvl"
                    class="policy-radio"
                    :class="[riskClass(lvl), { active: policy[row.strict] === lvl }]"
                  >
                    <input v-model="policy[row.strict]" type="radio" :value="lvl" />
                    {{ riskLabel(lvl) }}
                  </label>
                </div>
              </div>
              <div class="policy-cell">
                <div class="policy-radio-group" role="radiogroup">
                  <label
                    v-for="lvl in POLICY_ALLOWED_LEVELS"
                    :key="row.relaxed + lvl"
                    class="policy-radio"
                    :class="[riskClass(lvl), { active: policy[row.relaxed] === lvl }]"
                  >
                    <input v-model="policy[row.relaxed]" type="radio" :value="lvl" />
                    {{ riskLabel(lvl) }}
                  </label>
                </div>
              </div>
            </div>
          </div>

          <div class="policy-toggles">
            <label class="policy-toggle">
              <input v-model="policy.relaxedConfirmModerate" type="checkbox" />
              <div>
                <div class="policy-toggle-title">{{ t('settings.security.riskPolicy.relaxedConfirmModerate') }}</div>
                <div class="policy-toggle-desc">{{ t('settings.security.riskPolicy.relaxedConfirmModerateDesc') }}</div>
              </div>
            </label>
            <label class="policy-toggle">
              <input v-model="policy.subAgentBlockDangerous" type="checkbox" />
              <div>
                <div class="policy-toggle-title">{{ t('settings.security.riskPolicy.subAgentBlockDangerous') }}</div>
                <div class="policy-toggle-desc">{{ t('settings.security.riskPolicy.subAgentBlockDangerousDesc') }}</div>
              </div>
            </label>
          </div>
        </div>

        <div v-if="!policyLoading && !policyError" class="policy-actions">
          <button class="btn btn-sm" @click="resetPolicy" :disabled="!policyDiffersFromDefault">
            {{ t('settings.security.riskPolicy.reset') }}
          </button>
          <button
            class="btn btn-sm btn-primary"
            @click="savePolicy"
            :disabled="policySaving || !policyUnsaved"
          >
            {{ policySaving ? t('common.saving') : t('common.save') }}
          </button>
          <span v-if="policySaved" class="policy-saved">{{ t('settings.security.riskPolicy.saved') }}</span>
          <span v-else-if="policyUnsaved" class="policy-unsaved">{{ t('settings.security.riskPolicy.unsaved') }}</span>
        </div>

        <p class="rule-text muted">{{ t('settings.security.riskPolicy.freeModeHint') }}</p>
        <p class="rule-text muted">{{ t('settings.security.riskPolicy.blockedHint') }}</p>
      </div>
    </div>

    <Teleport to="body">
      <div
        v-if="openHelpTip"
        class="policy-tip-popover"
        :style="{ top: helpTipPos.top + 'px', left: helpTipPos.left + 'px' }"
        role="dialog"
        :aria-label="helpTipTitle"
        @click.stop
      >
        <div class="policy-tip-title">{{ helpTipTitle }}</div>
        <div class="policy-tip-body">{{ helpTipBody }}</div>
        <div v-if="policyTipExamples.length" class="policy-tip-examples-label">
          {{ t('settings.security.riskPolicy.tipExamplesLabel') }}
        </div>
        <ul v-if="policyTipExamples.length" class="policy-tip-examples">
          <li v-for="ex in policyTipExamples" :key="ex"><code>{{ ex }}</code></li>
        </ul>
      </div>
    </Teleport>
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
  box-sizing: border-box;
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

.cmd-grid-user .cmd-grid-head,
.cmd-grid-user .cmd-grid-row {
  grid-template-columns: 80px 90px 1fr 110px 60px 40px;
}

.user-rule-form {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  margin-bottom: 10px;
}

.user-rule-writes {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-secondary);
  white-space: nowrap;
}

.user-rule-flags-wrap {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 1 1 160px;
  min-width: 140px;
}

.user-rule-flags-wrap .user-rule-flags {
  flex: 1;
  min-width: 0;
}

.user-rule-help {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--text-muted);
  opacity: 0.75;
  flex-shrink: 0;
  cursor: pointer;
  border-radius: 50%;
}

.user-rule-help:hover,
.user-rule-help:focus-visible,
.user-rule-help.open {
  opacity: 1;
  color: var(--text-secondary);
  outline: none;
}

.user-rule-help.open {
  color: var(--accent-color, #3b82f6);
}

.cmd-col-actions {
  display: flex;
  justify-content: flex-end;
  align-items: center;
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
  flex-direction: row;
  align-items: center;
  justify-content: center;
  gap: 5px;
}

.policy-scenario-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}

.policy-scenario-help {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  opacity: 0.7;
  flex-shrink: 0;
  border-radius: 50%;
}

.policy-scenario-help:hover,
.policy-scenario-help:focus-visible,
.policy-scenario-help.open {
  opacity: 1;
  color: var(--text-secondary);
  outline: none;
}

.policy-scenario-help.open {
  color: var(--accent-color, #3b82f6);
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

.policy-radio-group {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  width: 100%;
}

.policy-radio {
  flex: 1;
  min-width: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 5px 8px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  background: var(--bg-primary);
  color: var(--text-secondary);
  font-size: 11px;
  font-weight: 500;
  cursor: pointer;
  user-select: none;
  transition: border-color 0.15s, background 0.15s, color 0.15s;
}

.policy-radio input {
  position: absolute;
  opacity: 0;
  pointer-events: none;
}

.policy-radio:hover {
  border-color: var(--text-muted);
}

.policy-radio.risk-moderate.active {
  border-color: rgba(245, 158, 11, 0.55);
  background: rgba(245, 158, 11, 0.14);
  color: #f59e0b;
}

.policy-radio.risk-dangerous.active {
  border-color: rgba(239, 68, 68, 0.55);
  background: rgba(239, 68, 68, 0.14);
  color: #ef4444;
}

.policy-radio.risk-blocked.active {
  border-color: rgba(168, 85, 247, 0.55);
  background: rgba(168, 85, 247, 0.14);
  color: #a855f7;
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

.policy-unsaved {
  font-size: 12px;
  color: var(--text-muted);
}

.clear-confirm-hint {
  font-size: 12px;
  color: var(--text-secondary);
  max-width: 280px;
  line-height: 1.4;
}

.section-desc {
  font-size: 12px;
  color: var(--text-secondary);
  margin: 0 0 8px 0;
  line-height: 1.5;
}

.add-entry-form {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 12px;
}

/* 与下方搜索框同款主题输入（覆盖浏览器默认白底） */
.input-field {
  width: 100%;
  padding: 8px 12px;
  border-radius: 6px;
  border: 1px solid var(--border-color);
  background: var(--bg-secondary);
  color: var(--text-primary);
  font-size: 13px;
  outline: none;
  box-sizing: border-box;
  transition: border-color 0.2s;
}

/* 必须写在 .input-field 的 padding / width 简写之后，否则会被覆盖 */
.input-field.filter-input {
  padding-left: 32px;
}

.input-field.user-rule-cmd {
  flex: 0 1 140px;
  width: auto;
  min-width: 100px;
  max-width: 180px;
}

.input-field.user-rule-level {
  flex: 0 0 auto;
  width: auto;
  min-width: 0;
  max-width: 7.5em;
}

.input-field.user-rule-flags {
  flex: 1 1 auto;
  width: auto;
  min-width: 0;
}

.input-field::placeholder {
  color: var(--text-muted);
}

.input-field:focus {
  border-color: var(--accent-primary);
}

.add-command-input {
  flex: 1;
  min-width: 0;
  width: auto;
}

.add-error {
  color: #ef4444;
  font-size: 12px;
  margin: -4px 0 12px 0;
}

.policy-body {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.policy-toggles {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.policy-toggle {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  cursor: pointer;
  padding: 10px 12px;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: var(--bg-secondary);
}

.policy-toggle input {
  margin-top: 3px;
}

.policy-toggle-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}

.policy-toggle-desc {
  font-size: 11px;
  color: var(--text-muted);
  margin-top: 2px;
  line-height: 1.4;
}

.policy-free-dirs {
  padding: 10px 12px;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  /* 与 settings-section 同层，让内部 input 的 bg-secondary 能显出来 */
  background: var(--bg-tertiary);
}

.workspace-config {
  margin-top: 4px;
  padding-top: 12px;
  border-top: 1px dashed var(--border-color);
}

.workspace-config-toggle {
  margin-top: 10px;
}

.workspace-policy-actions {
  margin-top: 12px;
}

.free-dir-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 8px;
}

.free-dir-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 4px 8px;
  border-radius: 6px;
  background: var(--bg-primary);
}

.free-dir-item code {
  font-size: 11px;
  word-break: break-all;
  color: var(--text-secondary);
}
</style>

<style>
/* Teleport 到 body，不能用 scoped */
.policy-tip-popover {
  position: fixed;
  z-index: 10000;
  width: 320px;
  max-width: calc(100vw - 24px);
  padding: 12px 14px;
  border-radius: 8px;
  border: 1px solid var(--border-color);
  background: var(--bg-elevated, var(--bg-secondary));
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
  color: var(--text-primary);
}

.policy-tip-title {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 6px;
}

.policy-tip-body {
  font-size: 12px;
  line-height: 1.55;
  color: var(--text-secondary);
  white-space: pre-line;
}

.policy-tip-examples-label {
  margin-top: 10px;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-muted);
}

.policy-tip-examples {
  margin: 4px 0 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.policy-tip-examples li code {
  display: block;
  font-size: 11px;
  line-height: 1.4;
  padding: 4px 8px;
  border-radius: 4px;
  background: var(--bg-tertiary, rgba(255, 255, 255, 0.06));
  color: var(--text-primary);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  word-break: break-all;
}
</style>
