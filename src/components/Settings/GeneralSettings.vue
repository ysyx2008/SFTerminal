<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import LanguageSettings from './LanguageSettings.vue'

const { t } = useI18n()

// 平台检测：macOS 仅支持检查更新 + 手动下载（无公证签名，不支持自动更新）
const isMac = computed(() => navigator.platform.toLowerCase().includes('mac'))

// 开机启动（仅打包态真正写入 OS 登录项，见 main.ts applyLoginItemSettings）
const launchAtLogin = ref(false)

// 更新偏好
const autoCheckUpdate = ref(true)
const autoDownloadUpdate = ref(true)
const installUpdateOnQuit = ref(true)

onMounted(async () => {
  const savedLaunchAtLogin = await window.electronAPI.config.get('launchAtLogin') as boolean | undefined
  launchAtLogin.value = savedLaunchAtLogin ?? false

  const savedAutoCheck = await window.electronAPI.config.get('autoCheckUpdate') as boolean | undefined
  autoCheckUpdate.value = savedAutoCheck ?? true

  const savedAutoDownload = await window.electronAPI.config.get('autoDownloadUpdate') as boolean | undefined
  autoDownloadUpdate.value = savedAutoDownload ?? true

  const savedInstallOnQuit = await window.electronAPI.config.get('installUpdateOnQuit') as boolean | undefined
  installUpdateOnQuit.value = savedInstallOnQuit ?? true
})

const onLaunchAtLoginChange = async () => {
  await window.electronAPI.config.set('launchAtLogin', launchAtLogin.value)
}

// 关闭自动检查时连带关闭自动下载与退出时安装
const onAutoCheckChange = async () => {
  await window.electronAPI.config.set('autoCheckUpdate', autoCheckUpdate.value)
  if (!autoCheckUpdate.value) {
    autoDownloadUpdate.value = false
    installUpdateOnQuit.value = false
    await window.electronAPI.config.set('autoDownloadUpdate', false)
    await window.electronAPI.config.set('installUpdateOnQuit', false)
  }
}

// 自动下载与「退出时安装」联动：关下载则关退出安装；开下载则恢复退出安装
const onAutoDownloadChange = async () => {
  await window.electronAPI.config.set('autoDownloadUpdate', autoDownloadUpdate.value)
  if (!autoDownloadUpdate.value) {
    installUpdateOnQuit.value = false
    await window.electronAPI.config.set('installUpdateOnQuit', false)
  } else if (!installUpdateOnQuit.value) {
    installUpdateOnQuit.value = true
    await window.electronAPI.config.set('installUpdateOnQuit', true)
  }
}

const onInstallOnQuitChange = async () => {
  await window.electronAPI.config.set('installUpdateOnQuit', installUpdateOnQuit.value)
}
</script>

<template>
  <div class="general-settings">
    <!-- 启动 -->
    <div class="settings-section">
      <h3 class="section-title">{{ t('general.startup') }}</h3>
      <div class="setting-row">
        <div>
          <label class="form-label">{{ t('general.launchAtLogin') }}</label>
          <p class="setting-desc">{{ t('general.launchAtLoginHint') }}</p>
        </div>
        <label class="toggle-switch">
          <input type="checkbox" v-model="launchAtLogin" @change="onLaunchAtLoginChange" />
          <span class="toggle-slider"></span>
        </label>
      </div>
    </div>

    <!-- 更新 -->
    <div class="settings-section">
      <h3 class="section-title">{{ t('general.update') }}</h3>
      <div class="setting-row">
        <div>
          <label class="form-label">{{ t('general.autoCheckUpdate') }}</label>
          <p class="setting-desc">{{ t('general.autoCheckUpdateHint') }}</p>
        </div>
        <label class="toggle-switch">
          <input type="checkbox" v-model="autoCheckUpdate" @change="onAutoCheckChange" />
          <span class="toggle-slider"></span>
        </label>
      </div>
      <div v-if="autoCheckUpdate && !isMac" class="setting-row">
        <div>
          <label class="form-label">{{ t('general.autoDownloadUpdate') }}</label>
        </div>
        <label class="toggle-switch">
          <input type="checkbox" v-model="autoDownloadUpdate" @change="onAutoDownloadChange" />
          <span class="toggle-slider"></span>
        </label>
      </div>
      <div v-if="autoCheckUpdate && autoDownloadUpdate && !isMac" class="setting-row">
        <div>
          <label class="form-label">{{ t('general.installUpdateOnQuit') }}</label>
          <p class="setting-desc">{{ t('general.installUpdateOnQuitHint') }}</p>
        </div>
        <label class="toggle-switch">
          <input type="checkbox" v-model="installUpdateOnQuit" @change="onInstallOnQuitChange" />
          <span class="toggle-slider"></span>
        </label>
      </div>
    </div>

    <!-- 语言 -->
    <LanguageSettings />
  </div>
</template>

<style scoped>
.general-settings {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.settings-section {
  background: var(--bg-tertiary);
  border-radius: 8px;
  padding: 16px;
}

.section-title {
  display: flex;
  align-items: center;
  min-height: 28px;
  margin: 0 0 8px;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}

.setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 14px;
}

.setting-row:last-child {
  margin-bottom: 0;
}

.form-label {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-primary);
}

.setting-desc {
  font-size: 11px;
  color: var(--text-muted);
  margin: 2px 0 0;
}

/* 开关组件 */
.toggle-switch {
  position: relative;
  display: inline-block;
  width: 44px;
  height: 24px;
  flex-shrink: 0;
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
</style>
