<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
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
</script>

<template>
  <div class="diagnostics-settings">
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
</style>
