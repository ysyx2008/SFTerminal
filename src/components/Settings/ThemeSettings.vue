<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useConfigStore } from '../../stores/config'
import { uiThemes, type UiThemeName, sponsorUiThemes } from '../../themes/ui-themes'
import { oemConfig } from '../../config/oem.config'

const { t } = useI18n()
const configStore = useConfigStore()

// 赞助状态和功能开关
const isSponsor = computed(() => configStore.isSponsor)
const showSponsor = computed(() => oemConfig.features.showSponsor)

// 检查 UI 主题是否为赞助者专属
const isSponsorUiTheme = (themeName: UiThemeName): boolean => {
  return sponsorUiThemes.includes(themeName)
}

// UI 主题（赞助者专属主题隐藏，赞助后才显示作为惊喜）
// 终端主题自动与 UI 主题同步，无需单独设置
const currentUiTheme = computed(() => configStore.uiTheme)

// 跟随系统外观（auto 模式）：开启后实际生效主题在 dark / light 之间根据系统切换，
// 用户在主题网格里选定的彩色主题保留在配置中（关闭跟随后还原）。
const followSystem = computed({
  get: () => configStore.uiThemeMode === 'auto',
  set: (value: boolean) => {
    void configStore.setUiThemeMode(value ? 'auto' : 'manual')
  }
})
const uiThemeList = computed<UiThemeName[]>(() => {
  // 基础主题列表
  const baseThemes: UiThemeName[] = ['dark', 'light', 'blue', 'gruvbox', 'forest', 'ayu-mirage', 'cyberpunk', 'lavender', 'aurora']
  // OEM 版本或赞助者：显示所有主题（包括专属主题）
  if (!showSponsor.value || isSponsor.value) {
    return [...baseThemes, ...sponsorUiThemes]
  }
  // 非赞助者：隐藏专属主题，赞助后才显示作为惊喜
  return baseThemes
})

const setUiTheme = async (themeName: UiThemeName) => {
  // 用户主动点选主题视为"想要手动选定"，自动关闭跟随系统，避免 auto 锁住网格
  // 让用户找不到换主题的入口
  if (configStore.uiThemeMode === 'auto') {
    await configStore.setUiThemeMode('manual')
  }
  await configStore.setUiTheme(themeName)
  // 终端主题自动与 UI 主题同步，无需额外操作
}

// UI 主题预览样式
const getUiThemePreviewStyle = (themeName: UiThemeName) => {
  const theme = uiThemes[themeName]
  return {
    background: theme.bgPrimary,
    borderColor: theme.borderColor
  }
}

const getUiThemeHeaderStyle = (themeName: UiThemeName) => {
  const theme = uiThemes[themeName]
  return {
    background: theme.bgSecondary,
    borderColor: theme.borderColor
  }
}

const getUiThemeSidebarStyle = (themeName: UiThemeName) => {
  const theme = uiThemes[themeName]
  return {
    background: theme.bgSecondary,
    borderColor: theme.borderColor
  }
}

const getUiThemeTextStyle = (themeName: UiThemeName) => {
  const theme = uiThemes[themeName]
  return {
    color: theme.textPrimary
  }
}

const getUiThemeMutedStyle = (themeName: UiThemeName) => {
  const theme = uiThemes[themeName]
  return {
    color: theme.textMuted
  }
}

const getUiThemeAccentStyle = (themeName: UiThemeName) => {
  const theme = uiThemes[themeName]
  return {
    background: theme.accentPrimary
  }
}
</script>

<template>
  <div class="theme-settings">
    <!-- UI 主题选择 -->
    <div class="settings-section">
      <h4>{{ t('themeSettings.uiTheme') }}</h4>
      <p class="section-desc">{{ t('themeSettings.selectUiTheme') }}</p>

      <!-- 跟随系统外观开关 -->
      <label class="follow-system-toggle">
        <span class="toggle-label">
          <span class="toggle-title">{{ t('themeSettings.followSystem') }}</span>
          <span class="toggle-desc">{{ t('themeSettings.followSystemDesc') }}</span>
        </span>
        <input
          type="checkbox"
          class="toggle-input"
          :checked="followSystem"
          @change="followSystem = ($event.target as HTMLInputElement).checked"
        />
        <span class="toggle-slider"></span>
      </label>

      <div class="ui-theme-grid" :class="{ 'is-dimmed': followSystem }">
        <div
          v-for="themeName in uiThemeList"
          :key="themeName"
          class="ui-theme-card"
          :class="{ active: !followSystem && currentUiTheme === themeName }"
          @click="setUiTheme(themeName)"
        >
          <div class="ui-theme-preview" :style="getUiThemePreviewStyle(themeName)">
            <!-- 模拟界面布局 -->
            <div class="preview-header" :style="getUiThemeHeaderStyle(themeName)">
              <div class="preview-dots">
                <span class="dot red"></span>
                <span class="dot yellow"></span>
                <span class="dot green"></span>
              </div>
              <span class="preview-title" :style="getUiThemeTextStyle(themeName)">Terminal</span>
            </div>
            <div class="preview-body">
              <div class="preview-sidebar" :style="getUiThemeSidebarStyle(themeName)">
                <div class="sidebar-item" :style="getUiThemeAccentStyle(themeName)"></div>
                <div class="sidebar-item" :style="getUiThemeMutedStyle(themeName)"></div>
                <div class="sidebar-item" :style="getUiThemeMutedStyle(themeName)"></div>
              </div>
              <div class="preview-content">
                <div class="content-line" :style="getUiThemeTextStyle(themeName)"></div>
                <div class="content-line short" :style="getUiThemeMutedStyle(themeName)"></div>
              </div>
            </div>
          </div>
          <div class="ui-theme-info">
            <span class="theme-name">
              {{ t(`themeSettings.uiThemes.${themeName}`) }}
              <span v-if="isSponsorUiTheme(themeName)" class="exclusive-badge">
                {{ t('sponsor.exclusive') }}
              </span>
            </span>
            <span v-if="!followSystem && currentUiTheme === themeName" class="theme-active">✓</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.theme-settings {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.settings-section {
  background: var(--bg-tertiary);
  border-radius: 8px;
  padding: 16px;
}

.settings-section h4 {
  display: flex;
  align-items: center;
  min-height: 28px;
  margin-bottom: 8px;
  font-size: 14px;
  font-weight: 600;
}

.section-desc {
  font-size: 12px;
  color: var(--text-muted);
  margin-bottom: 16px;
  line-height: 1.5;
}

/* 跟随系统开关 */
.follow-system-toggle {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 14px;
  margin-bottom: 14px;
  background: var(--bg-surface);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  cursor: pointer;
  user-select: none;
  position: relative;
  transition: border-color 0.2s ease;
}

.follow-system-toggle:hover {
  border-color: var(--text-muted);
}

.toggle-label {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
  min-width: 0;
}

.toggle-title {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-primary);
}

.toggle-desc {
  font-size: 11px;
  color: var(--text-muted);
  line-height: 1.4;
}

.toggle-input {
  position: absolute;
  opacity: 0;
  pointer-events: none;
}

.toggle-slider {
  flex-shrink: 0;
  position: relative;
  width: 36px;
  height: 20px;
  background: var(--bg-hover);
  border-radius: 10px;
  transition: background 0.2s ease;
}

.toggle-slider::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  background: #ffffff;
  border-radius: 50%;
  transition: transform 0.2s ease;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.25);
}

.toggle-input:checked ~ .toggle-slider {
  background: var(--accent-primary);
}

.toggle-input:checked ~ .toggle-slider::after {
  transform: translateX(16px);
}

/* UI 主题网格 */
.ui-theme-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
}

/* 跟随系统模式下网格整体变淡，提示"当前不直接生效"；
   但仍允许点击——点击会自动切到 manual 并选中该主题，避免用户
   找不到换主题的入口。hover 时单卡片透明度恢复，反馈"可点击"。 */
.ui-theme-grid.is-dimmed {
  opacity: 0.55;
  transition: opacity 0.2s ease;
}

.ui-theme-grid.is-dimmed:hover {
  opacity: 1;
}

.ui-theme-card {
  border: 2px solid var(--border-color);
  border-radius: 8px;
  overflow: hidden;
  cursor: pointer;
  transition: all 0.2s ease;
}

.ui-theme-card:hover {
  border-color: var(--text-muted);
}

.ui-theme-card.active {
  border-color: var(--accent-primary);
}

.ui-theme-preview {
  height: 80px;
  border-radius: 4px 4px 0 0;
  overflow: hidden;
}

.preview-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px;
  border-bottom: 1px solid;
}

.preview-dots {
  display: flex;
  gap: 4px;
}

.preview-dots .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
}

.preview-dots .dot.red {
  background: #ff5f57;
}

.preview-dots .dot.yellow {
  background: #febc2e;
}

.preview-dots .dot.green {
  background: #28c840;
}

.preview-title {
  font-size: 8px;
  font-weight: 500;
}

.preview-body {
  display: flex;
  height: calc(100% - 22px);
}

.preview-sidebar {
  width: 30%;
  padding: 6px 4px;
  border-right: 1px solid;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.sidebar-item {
  height: 6px;
  border-radius: 2px;
  opacity: 0.6;
}

.sidebar-item:first-child {
  opacity: 1;
}

.preview-content {
  flex: 1;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.content-line {
  height: 4px;
  border-radius: 2px;
  background: currentColor;
  opacity: 0.3;
}

.content-line.short {
  width: 60%;
}

.ui-theme-info {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  background: var(--bg-secondary);
  border-top: 1px solid var(--border-color);
}

/* 终端主题网格 */
.theme-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 12px;
}

.theme-card {
  border: 2px solid var(--border-color);
  border-radius: 8px;
  overflow: hidden;
  cursor: pointer;
  transition: all 0.2s ease;
  position: relative;
}

.theme-card:hover:not(.locked) {
  border-color: var(--text-muted);
}

.theme-card.active {
  border-color: var(--accent-primary);
}

.theme-card.locked {
  cursor: not-allowed;
  opacity: 0.7;
}

.theme-card.locked:hover {
  border-color: var(--border-color);
}

.theme-preview {
  padding: 12px;
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1.4;
  position: relative;
}

.theme-lock-overlay {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  border-radius: 6px;
}

.lock-icon {
  font-size: 24px;
  filter: drop-shadow(0 2px 4px rgba(0, 0, 0, 0.3));
}

.lock-hint {
  font-size: 11px;
  color: #ffd700;
  font-weight: 600;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.5);
}

.preview-line {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.theme-info {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  background: var(--bg-secondary);
  border-top: 1px solid var(--border-color);
}

.theme-name {
  font-size: 12px;
  font-weight: 500;
  text-transform: capitalize;
  display: flex;
  align-items: center;
  gap: 6px;
}

.exclusive-badge {
  font-size: 10px;
  padding: 2px 6px;
  background: linear-gradient(135deg, rgba(255, 215, 0, 0.2) 0%, rgba(255, 165, 0, 0.2) 100%);
  border: 1px solid rgba(255, 215, 0, 0.4);
  border-radius: 10px;
  color: #ffd700;
  font-weight: 600;
}

.theme-active {
  color: var(--accent-success);
  font-weight: 600;
}
</style>
