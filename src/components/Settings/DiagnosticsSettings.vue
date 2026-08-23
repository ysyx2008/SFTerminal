<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { CrashSummary, DiagnosticsPackageResult } from '@sailfish/shared-types'
import { useConfigStore } from '../../stores/config'
import type { LogLevel } from '../../utils/logger'
import {
  SettingsPage,
  SettingsGroup,
  SettingRow,
  SettingToggle,
  SettingSelect,
  SettingNotice,
} from './kit'

const { t } = useI18n()
const configStore = useConfigStore()

const debugMode = computed(() => configStore.agentDebugMode)

const openLogDir = () => {
  window.electronAPI.config.openLogDir()
}

const openAiDebugLogDir = async () => {
  const aiDebugLogDir = await window.electronAPI.aiDebugGetLogDir()
  await window.electronAPI.shell.openPath(aiDebugLogDir)
}

const crash = ref<CrashSummary | null>(null)
const copied = ref(false)
const creatingPackage = ref(false)
const packageResult = ref<DiagnosticsPackageResult | null>(null)
const notifyEnabled = ref(true)

const logLevelOptions = [
  { value: 'debug', label: 'Debug' },
  { value: 'info', label: 'Info' },
  { value: 'warn', label: 'Warn' },
  { value: 'error', label: 'Error' },
  { value: 'silent', label: 'Silent' },
]

onMounted(async () => {
  const [summary, enabled] = await Promise.all([
    window.electronAPI.diagnostics.getCrashSummary(),
    window.electronAPI.diagnostics.getNotifyEnabled(),
  ])
  crash.value = summary
  notifyEnabled.value = enabled
})

const setNotifyEnabled = async (enabled: boolean) => {
  notifyEnabled.value = enabled
  await window.electronAPI.diagnostics.setNotifyEnabled(enabled)
}

const hasCrashRecord = computed(() => {
  const c = crash.value
  if (!c) return false
  return c.lastExitWasCrash || c.crashesThisRun > 0 || (c.dumpCount ?? 0) > 0
})

const copySummary = async () => {
  const text = await window.electronAPI.diagnostics.getCrashSummaryText()
  await navigator.clipboard.writeText(text)
  copied.value = true
  setTimeout(() => { copied.value = false }, 2000)
}

const createPackage = async () => {
  creatingPackage.value = true
  packageResult.value = null
  try {
    const result = await window.electronAPI.diagnostics.createPackage({ chooseLocation: true })
    // 用户自己放弃保存不算失败，不该在界面上留一条错误
    packageResult.value = result.canceled ? null : result
  } finally {
    creatingPackage.value = false
  }
}

const packageSizeText = computed(() => {
  const bytes = packageResult.value?.sizeBytes
  if (!bytes) return ''
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.round(bytes / 1024)} KB`
})

const revealPackage = () => {
  const filePath = packageResult.value?.filePath
  if (filePath) window.electronAPI.diagnostics.revealPackage(filePath)
}
</script>

<template>
  <SettingsPage :title="t('settings.tabs.diagnostics')">
    <SettingsGroup :title="t('aiSettings.crashReport')" :desc="t('aiSettings.crashReportDesc')">
      <SettingNotice v-if="crash" :tone="hasCrashRecord ? 'warn' : 'neutral'">
        <template v-if="hasCrashRecord">
          <span v-if="crash.lastExitWasCrash">
            {{ t('aiSettings.crashReportLastCrash', { version: crash.previousVersion || '?' }) }}
          </span>
          <span v-if="crash.consecutiveCrashCount > 1">
            {{ t('aiSettings.crashReportConsecutive', { count: crash.consecutiveCrashCount }) }}
          </span>
          <span v-if="crash.crashesThisRun > 0">
            {{ t('aiSettings.crashReportThisRun', { count: crash.crashesThisRun }) }}
          </span>
          <span v-if="crash.dumpCount">
            {{ t('aiSettings.crashReportDumps', { count: crash.dumpCount }) }}
          </span>
        </template>
        <span v-else>{{ t('aiSettings.crashReportHealthy') }}</span>
      </SettingNotice>

      <SettingRow
        :label="t('aiSettings.crashSummaryRow')"
        :desc="t('aiSettings.crashSummaryRowDesc')"
      >
        <button class="btn btn-sm" @click="copySummary">
          {{ copied ? t('aiSettings.copied') : t('common.copy') }}
        </button>
      </SettingRow>

      <SettingRow
        :label="t('aiSettings.packageRow')"
        :desc="t('aiSettings.packageRowDesc')"
      >
        <span v-if="packageResult?.success" class="package-result">
          {{ t('aiSettings.packageCreated', { size: packageSizeText }) }}
          <button class="link-btn" @click="revealPackage">{{ t('aiSettings.revealPackage') }}</button>
        </span>
        <span v-else-if="packageResult && !packageResult.success" class="package-result is-error">
          {{ t('aiSettings.packageFailed', { error: packageResult.error || '' }) }}
        </span>
        <button class="btn btn-sm" :disabled="creatingPackage" @click="createPackage">
          {{ creatingPackage ? t('aiSettings.creatingPackage') : t('aiSettings.generate') }}
        </button>
      </SettingRow>

      <SettingRow clickable :label="t('aiSettings.crashNotify')">
        <SettingToggle :model-value="notifyEnabled" @update:model-value="setNotifyEnabled" />
      </SettingRow>
    </SettingsGroup>

    <SettingsGroup :title="t('aiSettings.groupLogging')">
      <SettingRow
        :label="t('aiSettings.logLevel')"
        :desc="t('aiSettings.logLevelDesc')"
      >
        <SettingSelect
          :model-value="configStore.logLevel"
          :options="logLevelOptions"
          @update:model-value="configStore.setLogLevel($event as LogLevel)"
        />
      </SettingRow>

      <SettingRow
        :label="t('aiSettings.logFilesRow')"
        :desc="t('aiSettings.logFilesRowDesc')"
      >
        <button class="btn btn-sm" @click="openLogDir">{{ t('aiSettings.openLogDir') }}</button>
        <button class="btn btn-sm" @click="openAiDebugLogDir">{{ t('aiSettings.openAiDebugLogDir') }}</button>
      </SettingRow>

      <SettingRow
        clickable
        :label="t('aiSettings.agentDebugMode')"
        :desc="t('aiSettings.agentDebugModeDesc')"
      >
        <SettingToggle
          :model-value="debugMode"
          @update:model-value="configStore.setAgentDebugMode"
        />
      </SettingRow>
    </SettingsGroup>
  </SettingsPage>
</template>

<style scoped>
.package-result {
  font-size: var(--fs-desc);
  color: var(--text-secondary);
}

.package-result.is-error {
  color: var(--color-error);
}

.link-btn {
  margin-left: var(--sp-2);
  padding: 0;
  font-family: inherit;
  font-size: var(--fs-desc);
  color: var(--accent-primary);
  background: none;
  border: none;
  cursor: pointer;
}

.link-btn:hover {
  text-decoration: underline;
}
</style>
