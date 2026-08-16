<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { CrashSummary, DiagnosticsPackageResult } from '@sailfish/shared-types'
import { useConfigStore } from '../../stores/config'

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

onMounted(async () => {
  crash.value = await window.electronAPI.diagnostics.getCrashSummary()
})

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
  <div class="diagnostics-settings">
    <!-- 崩溃诊断 -->
    <div class="settings-section">
      <div class="section-header">
        <h4>{{ t('aiSettings.crashReport') }}</h4>
      </div>
      <p class="section-desc">
        {{ t('aiSettings.crashReportDesc') }}
      </p>

      <div v-if="crash" class="crash-status" :class="{ 'crash-status--alert': hasCrashRecord }">
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
      </div>

      <div class="log-dir-actions">
        <button class="open-log-dir-btn open-log-dir-btn--primary" @click="copySummary">
          {{ copied ? t('aiSettings.crashSummaryCopied') : t('aiSettings.copyCrashSummary') }}
        </button>
        <button class="open-log-dir-btn" :disabled="creatingPackage" @click="createPackage">
          {{ creatingPackage ? t('aiSettings.creatingPackage') : t('aiSettings.createDiagnosticsPackage') }}
        </button>
      </div>

      <p v-if="packageResult?.success" class="package-result">
        {{ t('aiSettings.packageCreated', { size: packageSizeText }) }}
        <button class="link-btn" @click="revealPackage">{{ t('aiSettings.revealPackage') }}</button>
      </p>
      <p v-else-if="packageResult && !packageResult.success" class="package-result package-result--error">
        {{ t('aiSettings.packageFailed', { error: packageResult.error || '' }) }}
      </p>
    </div>

    <!-- Agent 调试模式 -->
    <div class="settings-section">
      <div class="section-header">
        <h4>{{ t('aiSettings.agentDebugMode') }}</h4>
        <label class="toggle-switch">
          <input
            type="checkbox"
            :checked="debugMode"
            @change="configStore.setAgentDebugMode(($event.target as HTMLInputElement).checked)"
          />
          <span class="toggle-slider"></span>
        </label>
      </div>
      <p class="section-desc">
        {{ t('aiSettings.agentDebugModeDesc') }}
      </p>
    </div>

    <!-- 日志级别 -->
    <div class="settings-section">
      <div class="section-header">
        <h4>{{ t('aiSettings.logLevel') }}</h4>
        <select
          class="log-level-select"
          :value="configStore.logLevel"
          @change="configStore.setLogLevel(($event.target as HTMLSelectElement).value as import('../../utils/logger').LogLevel)"
        >
          <option value="debug">Debug</option>
          <option value="info">Info</option>
          <option value="warn">Warn</option>
          <option value="error">Error</option>
          <option value="silent">Silent</option>
        </select>
      </div>
      <p class="section-desc">
        {{ t('aiSettings.logLevelDesc') }}
      </p>
      <div class="log-dir-actions">
        <button class="open-log-dir-btn" @click="openLogDir">
          {{ t('aiSettings.openLogDir') }}
        </button>
        <button class="open-log-dir-btn" @click="openAiDebugLogDir">
          {{ t('aiSettings.openAiDebugLogDir') }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.diagnostics-settings {
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

.section-header h4 {
  font-size: 14px;
  font-weight: 600;
}

.section-desc {
  font-size: 12px;
  color: var(--text-muted);
  margin-bottom: 16px;
  line-height: 1.5;
}

.toggle-switch {
  position: relative;
  display: inline-block;
  width: 44px;
  height: 24px;
}

.toggle-switch input {
  opacity: 0;
  width: 0;
  height: 0;
}

.toggle-slider {
  position: absolute;
  cursor: pointer;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background-color: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 24px;
  transition: 0.3s;
}

.toggle-slider:before {
  position: absolute;
  content: "";
  height: 18px;
  width: 18px;
  left: 2px;
  bottom: 2px;
  background-color: var(--text-muted);
  border-radius: 50%;
  transition: 0.3s;
}

.toggle-switch input:checked + .toggle-slider {
  background-color: var(--accent-primary);
  border-color: var(--accent-primary);
}

.toggle-switch input:checked + .toggle-slider:before {
  transform: translateX(20px);
  background-color: white;
}

.log-level-select {
  padding: 4px 8px;
  border-radius: 6px;
  border: 1px solid var(--border-color, #555);
  background: var(--bg-secondary, #2a2a2a);
  color: var(--text-primary, #e0e0e0);
  font-size: 13px;
  cursor: pointer;
  outline: none;
}

.log-level-select:focus {
  border-color: var(--accent-primary);
}

.open-log-dir-btn {
  margin-top: 8px;
  padding: 4px 12px;
  border-radius: 6px;
  border: 1px solid var(--border-color, #555);
  background: var(--bg-secondary, #2a2a2a);
  color: var(--text-secondary, #aaa);
  font-size: 12px;
  cursor: pointer;
  transition: all 0.2s;
}

.open-log-dir-btn:hover {
  background: var(--bg-hover, #333);
  color: var(--text-primary, #e0e0e0);
  border-color: var(--accent-primary);
}

.log-dir-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.open-log-dir-btn:disabled {
  opacity: 0.6;
  cursor: default;
}

.open-log-dir-btn--primary {
  border-color: var(--accent-primary);
  color: var(--text-primary, #e0e0e0);
}

.crash-status {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  padding: 8px 10px;
  margin-bottom: 12px;
  border-radius: 6px;
  background: var(--bg-secondary, #2a2a2a);
  font-size: 12px;
  color: var(--text-secondary, #aaa);
}

.crash-status--alert {
  color: var(--text-primary, #e0e0e0);
  border-left: 3px solid var(--color-warning, #e0a030);
}

.package-result {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
  font-size: 12px;
  color: var(--text-secondary, #aaa);
}

.package-result--error {
  color: var(--color-danger, #e05252);
}

.link-btn {
  background: none;
  border: none;
  padding: 0;
  font-size: 12px;
  color: var(--accent-primary);
  cursor: pointer;
}

.link-btn:hover {
  text-decoration: underline;
}
</style>
