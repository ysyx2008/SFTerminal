<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useConfigStore } from '../../stores/config'
import { SUPPORTED_LOCALES, type LocaleType } from '../../i18n'
import {
  SettingsPage,
  SettingsGroup,
  SettingRow,
  SettingToggle,
  SettingSegmented
} from './kit'

const { t } = useI18n()
const configStore = useConfigStore()

const currentLanguage = computed(() => configStore.language)
const changeLanguage = (lang: string) => configStore.setLanguage(lang as LocaleType)
const localeOptions = computed(() =>
  SUPPORTED_LOCALES.map(l => ({ value: l.value, label: l.label }))
)

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

const onLaunchAtLoginChange = async (v: boolean) => {
  launchAtLogin.value = v
  await window.electronAPI.config.set('launchAtLogin', v)
}

// 关闭自动检查时连带关闭自动下载与退出时安装
const onAutoCheckChange = async (v: boolean) => {
  autoCheckUpdate.value = v
  await window.electronAPI.config.set('autoCheckUpdate', v)
  if (!v) {
    autoDownloadUpdate.value = false
    installUpdateOnQuit.value = false
    await window.electronAPI.config.set('autoDownloadUpdate', false)
    await window.electronAPI.config.set('installUpdateOnQuit', false)
  }
}

// 自动下载与「退出时安装」联动：关下载则关退出安装；开下载则恢复退出安装
const onAutoDownloadChange = async (v: boolean) => {
  autoDownloadUpdate.value = v
  await window.electronAPI.config.set('autoDownloadUpdate', v)
  if (!v) {
    installUpdateOnQuit.value = false
    await window.electronAPI.config.set('installUpdateOnQuit', false)
  } else if (!installUpdateOnQuit.value) {
    installUpdateOnQuit.value = true
    await window.electronAPI.config.set('installUpdateOnQuit', true)
  }
}

const onInstallOnQuitChange = async (v: boolean) => {
  installUpdateOnQuit.value = v
  await window.electronAPI.config.set('installUpdateOnQuit', v)
}
</script>

<template>
  <SettingsPage>
    <SettingsGroup :title="t('general.startupAndUpdate')">
      <SettingRow
        clickable
        :label="t('general.launchAtLogin')"
        :desc="t('general.launchAtLoginHint')"
      >
        <SettingToggle :model-value="launchAtLogin" @update:model-value="onLaunchAtLoginChange" />
      </SettingRow>

      <SettingRow
        clickable
        :label="t('general.autoCheckUpdate')"
        :desc="t('general.autoCheckUpdateHint')"
      >
        <SettingToggle :model-value="autoCheckUpdate" @update:model-value="onAutoCheckChange" />
      </SettingRow>

      <SettingRow
        v-if="autoCheckUpdate && !isMac"
        clickable
        :label="t('general.autoDownloadUpdate')"
      >
        <SettingToggle :model-value="autoDownloadUpdate" @update:model-value="onAutoDownloadChange" />
      </SettingRow>

      <SettingRow
        v-if="autoCheckUpdate && autoDownloadUpdate && !isMac"
        clickable
        :label="t('general.installUpdateOnQuit')"
        :desc="t('general.installUpdateOnQuitHint')"
      >
        <SettingToggle :model-value="installUpdateOnQuit" @update:model-value="onInstallOnQuitChange" />
      </SettingRow>
    </SettingsGroup>

    <SettingsGroup :title="t('general.interface')">
      <SettingRow :label="t('general.interfaceLanguage')">
        <SettingSegmented
          :model-value="currentLanguage"
          :options="localeOptions"
          @update:model-value="changeLanguage"
        />
      </SettingRow>

      <SettingRow
        clickable
        :label="t('general.foldAgentProcess')"
        :desc="t('general.foldAgentProcessHint')"
      >
        <SettingToggle
          :model-value="configStore.foldAgentProcess"
          @update:model-value="configStore.setFoldAgentProcess"
        />
      </SettingRow>
    </SettingsGroup>
  </SettingsPage>
</template>
