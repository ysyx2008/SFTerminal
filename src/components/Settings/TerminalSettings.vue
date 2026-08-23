<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useConfigStore, type LocalEncoding } from '../../stores/config'
import {
  SettingsPage,
  SettingsGroup,
  SettingRow,
  SettingToggle,
  SettingSelect,
  SettingSlider,
  SettingSegmented,
} from './kit'

const { t } = useI18n()
const configStore = useConfigStore()

const settings = ref({ ...configStore.terminalSettings })

// 保存设置
const saveSettings = async () => {
  configStore.terminalSettings.fontSize = settings.value.fontSize
  configStore.terminalSettings.fontFamily = settings.value.fontFamily
  configStore.terminalSettings.cursorBlink = settings.value.cursorBlink
  configStore.terminalSettings.cursorStyle = settings.value.cursorStyle
  configStore.terminalSettings.scrollback = settings.value.scrollback
  configStore.terminalSettings.localEncoding = settings.value.localEncoding
  configStore.terminalSettings.commandHighlight = settings.value.commandHighlight
  configStore.terminalSettings.aiPanelPosition = settings.value.aiPanelPosition

  // 转换为普通对象，避免 IPC 结构化克隆错误
  const plainSettings = JSON.parse(JSON.stringify(settings.value))
  await window.electronAPI.config.set('terminalSettings', plainSettings)
}

// 监听变化自动保存
watch(settings, saveSettings, { deep: true })

const fontFamilies = [
  { value: '"Cascadia Code", "Fira Code", "JetBrains Mono", Consolas, monospace', label: 'Cascadia Code' },
  { value: '"Fira Code", "JetBrains Mono", Consolas, monospace', label: 'Fira Code' },
  { value: '"JetBrains Mono", Consolas, monospace', label: 'JetBrains Mono' },
  { value: 'Consolas, "Courier New", monospace', label: 'Consolas' },
  { value: '"Source Code Pro", monospace', label: 'Source Code Pro' },
  { value: '"Ubuntu Mono", monospace', label: 'Ubuntu Mono' }
]

// 本地终端编码选项
const encodingOptions: LocalEncoding[] = [
  'auto',
  'utf-8',
  'gbk',
  'gb2312',
  'gb18030',
  'big5',
  'shift_jis',
  'euc-jp',
  'euc-kr',
  'iso-8859-1',
  'iso-8859-15',
  'windows-1252',
  'koi8-r',
  'windows-1251'
]

const encodingSelectOptions = computed(() =>
  encodingOptions.map((enc) => ({ value: enc, label: t(`terminalSettings.encodings.${enc}`) }))
)

const cursorStyleOptions = computed(() =>
  (['block', 'underline', 'bar'] as const).map((style) => ({
    value: style,
    label: t(`terminalSettings.cursorStyles.${style}`),
  }))
)

const aiPanelPositionOptions = computed(() =>
  (['left', 'right'] as const).map((pos) => ({
    value: pos,
    label: t(`terminalSettings.aiPanelPositions.${pos}`),
  }))
)
</script>

<template>
  <SettingsPage :title="t('settings.tabs.terminal')">
    <SettingsGroup :title="t('terminalSettings.groupAppearance')">
      <SettingRow :label="t('terminalSettings.fontSize')">
        <SettingSlider v-model="settings.fontSize" :min="10" :max="24" suffix="px" />
      </SettingRow>

      <SettingRow :label="t('terminalSettings.fontFamily')">
        <SettingSelect v-model="settings.fontFamily" :options="fontFamilies" />
      </SettingRow>

      <SettingRow :label="t('terminalSettings.cursorStyle')">
        <SettingSegmented v-model="settings.cursorStyle" :options="cursorStyleOptions" />
      </SettingRow>

      <SettingRow clickable :label="t('terminalSettings.cursorBlink')">
        <SettingToggle v-model="settings.cursorBlink" />
      </SettingRow>

      <SettingRow
        clickable
        :label="t('terminalSettings.commandHighlight')"
        :desc="t('terminalSettings.commandHighlightHint')"
      >
        <SettingToggle v-model="settings.commandHighlight" />
      </SettingRow>
    </SettingsGroup>

    <SettingsGroup :title="t('terminalSettings.groupBehavior')">
      <SettingRow :label="t('terminalSettings.scrollback')">
        <SettingSlider v-model="settings.scrollback" :min="1000" :max="50000" :step="1000" />
      </SettingRow>

      <SettingRow
        :label="t('terminalSettings.localEncoding')"
        :desc="t('terminalSettings.localEncodingHint')"
      >
        <SettingSelect v-model="settings.localEncoding" :options="encodingSelectOptions" />
      </SettingRow>

      <SettingRow :label="t('terminalSettings.aiPanelPosition')">
        <SettingSegmented v-model="settings.aiPanelPosition" :options="aiPanelPositionOptions" />
      </SettingRow>
    </SettingsGroup>

    <SettingsGroup :title="t('themeSettings.preview')">
      <div
        class="terminal-preview"
        :style="{
          fontFamily: settings.fontFamily,
          fontSize: settings.fontSize + 'px'
        }"
      >
        <div class="preview-line">
          <span class="green">user@qiyu</span>:<span class="blue">~</span>$ echo "Hello World"
        </div>
        <div class="preview-line">Hello World</div>
        <div class="preview-line">
          <span class="green">user@qiyu</span>:<span class="blue">~</span>$
          <span
            class="cursor"
            :class="[settings.cursorStyle, { blink: settings.cursorBlink }]"
          ></span>
        </div>
      </div>
    </SettingsGroup>
  </SettingsPage>
</template>

<style scoped>
.terminal-preview {
  background: var(--bg-primary);
  padding: 16px;
  border-radius: 6px;
  line-height: 1.5;
}

.preview-line {
  white-space: pre;
}

.preview-line .green {
  color: #a6e3a1;
}

.preview-line .blue {
  color: #89b4fa;
}

.cursor {
  display: inline-block;
  background: #cdd6f4;
  margin-left: 2px;
}

.cursor.block {
  width: 0.6em;
  height: 1.2em;
  vertical-align: text-bottom;
}

.cursor.underline {
  width: 0.6em;
  height: 2px;
  vertical-align: bottom;
}

.cursor.bar {
  width: 2px;
  height: 1.2em;
  vertical-align: text-bottom;
}

.cursor.blink {
  animation: blink 1s step-end infinite;
}

@keyframes blink {
  50% {
    opacity: 0;
  }
}
</style>

