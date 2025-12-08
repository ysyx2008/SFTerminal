<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useConfigStore } from '../../stores/config'
import AiSettings from './AiSettings.vue'
import ThemeSettings from './ThemeSettings.vue'
import TerminalSettings from './TerminalSettings.vue'
import DataSettings from './DataSettings.vue'
import McpSettings from './McpSettings.vue'
import KnowledgeSettings from './KnowledgeSettings.vue'
import LanguageSettings from './LanguageSettings.vue'

const { t } = useI18n()

// Props
const props = defineProps<{
  initialTab?: string
}>()

const emit = defineEmits<{
  close: []
  restartSetup: []
}>()

const configStore = useConfigStore()

type SettingsTab = 'ai' | 'mcp' | 'knowledge' | 'theme' | 'terminal' | 'data' | 'language' | 'about'
const activeTab = ref<SettingsTab>('ai')
const appVersion = ref<string>('')

// 初始化时设置初始 tab 和获取版本号
onMounted(async () => {
  if (props.initialTab && ['ai', 'mcp', 'knowledge', 'theme', 'terminal', 'data', 'language', 'about'].includes(props.initialTab)) {
    activeTab.value = props.initialTab as SettingsTab
  }
  // 获取应用版本号
  appVersion.value = await window.electronAPI.app.getVersion()
})

const tabs = computed(() => [
  { id: 'ai' as const, label: t('settings.tabs.ai'), icon: '🤖' },
  { id: 'mcp' as const, label: t('settings.tabs.mcp'), icon: '🔌' },
  { id: 'knowledge' as const, label: t('settings.tabs.knowledge'), icon: '📚' },
  { id: 'theme' as const, label: t('settings.tabs.theme'), icon: '🎨' },
  { id: 'terminal' as const, label: t('settings.tabs.terminal'), icon: '⚙️' },
  { id: 'data' as const, label: t('settings.tabs.data'), icon: '💾' },
  { id: 'language' as const, label: t('settings.tabs.language'), icon: '🌐' },
  { id: 'about' as const, label: t('settings.tabs.about'), icon: 'ℹ️' }
])

const restartSetup = async () => {
  if (confirm(t('settings.restartSetupConfirm'))) {
    await configStore.setSetupCompleted(false)
    emit('restartSetup')
    emit('close')
  }
}
</script>

<template>
  <Transition name="overlay" appear>
    <div class="modal-overlay" @click.self="emit('close')">
      <div class="settings-modal">
      <div class="settings-header">
        <h2>{{ t('settings.title') }}</h2>
        <button class="btn-icon" @click="emit('close')" :title="t('settings.closeSettings')">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"/>
            <line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>
      <div class="settings-body">
        <nav class="settings-nav">
          <button
            v-for="tab in tabs"
            :key="tab.id"
            class="nav-item"
            :class="{ active: activeTab === tab.id }"
            @click="activeTab = tab.id"
          >
            <span class="nav-icon">{{ tab.icon }}</span>
            <span>{{ tab.label }}</span>
          </button>
        </nav>
        <div class="settings-content">
          <AiSettings v-if="activeTab === 'ai'" />
          <McpSettings v-else-if="activeTab === 'mcp'" />
          <KnowledgeSettings v-else-if="activeTab === 'knowledge'" />
          <ThemeSettings v-else-if="activeTab === 'theme'" />
          <TerminalSettings v-else-if="activeTab === 'terminal'" />
          <DataSettings v-else-if="activeTab === 'data'" />
          <LanguageSettings v-else-if="activeTab === 'language'" />
          <div v-else-if="activeTab === 'about'" class="about-content">
            <div class="about-logo">🐟</div>
            <h3>{{ t('about.title') }}</h3>
            <p class="version">{{ t('common.version') }} {{ appVersion }}</p>
            <p class="description">
              {{ t('about.description') }}
            </p>
            <div class="about-links">
              <a href="#" class="about-link">{{ t('about.docs') }}</a>
              <a href="#" class="about-link">{{ t('about.feedback') }}</a>
              <a href="#" class="about-link">{{ t('about.license') }}</a>
            </div>
            <div class="about-actions">
              <button class="btn btn-outline" @click="restartSetup">
                🔄 {{ t('settings.restartSetup') }}
              </button>
            </div>
            <p class="copyright">
              {{ t('about.copyright') }}
            </p>
          </div>
        </div>
      </div>
    </div>
    </div>
  </Transition>
</template>

<style scoped>
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.settings-modal {
  width: 750px;
  max-width: 90vw;
  height: 560px;
  max-height: 85vh;
  background: var(--bg-secondary);
  border-radius: 12px;
  box-shadow: 0 25px 50px rgba(0, 0, 0, 0.4);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  animation: modalSpringIn 0.4s cubic-bezier(0.34, 1.56, 0.64, 1);
}

/* iOS 风格弹窗动画 */
@keyframes modalSpringIn {
  0% {
    opacity: 0;
    transform: scale(0.8) translateY(20px);
  }
  50% {
    transform: scale(1.02) translateY(-5px);
  }
  100% {
    opacity: 1;
    transform: scale(1) translateY(0);
  }
}

/* Transition 动画 */
.overlay-enter-active {
  transition: all 0.3s ease;
}

.overlay-leave-active {
  transition: all 0.2s ease;
}

.overlay-enter-from,
.overlay-leave-to {
  opacity: 0;
}

.overlay-enter-from .settings-modal,
.overlay-leave-to .settings-modal {
  transform: scale(0.9);
  opacity: 0;
}

.settings-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border-color);
}

.settings-header h2 {
  font-size: 18px;
  font-weight: 600;
}

.settings-body {
  display: flex;
  flex: 1;
  overflow: hidden;
}

.settings-nav {
  width: 180px;
  padding: 12px;
  background: var(--bg-tertiary);
  border-right: 1px solid var(--border-color);
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 10px 12px;
  font-size: 13px;
  color: var(--text-secondary);
  background: transparent;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
  text-align: left;
  position: relative;
  overflow: hidden;
}

.nav-item::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  width: 3px;
  height: 100%;
  background: var(--accent-primary);
  transform: scaleY(0);
  transition: transform 0.2s cubic-bezier(0.34, 1.56, 0.64, 1);
  border-radius: 0 2px 2px 0;
}

.nav-item:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
  transform: translateX(2px);
}

.nav-item:active {
  transform: translateX(2px) scale(0.98);
}

.nav-item.active {
  background: var(--accent-primary);
  color: var(--bg-primary);
  transform: translateX(0);
}

.nav-item.active::before {
  transform: scaleY(1);
  background: var(--bg-primary);
}

.nav-icon {
  font-size: 16px;
}

.settings-content {
  flex: 1;
  padding: 20px;
  overflow-y: auto;
}

/* 关于页面 */
.about-content {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  text-align: center;
}

.about-logo {
  font-size: 64px;
  margin-bottom: 16px;
}

.about-content h3 {
  font-size: 24px;
  font-weight: 600;
  margin-bottom: 8px;
}

.version {
  color: var(--text-muted);
  font-size: 14px;
  margin-bottom: 16px;
}

.description {
  color: var(--text-secondary);
  font-size: 14px;
  max-width: 300px;
  margin-bottom: 24px;
}

.about-links {
  display: flex;
  gap: 20px;
  margin-bottom: 24px;
}

.about-link {
  color: var(--accent-primary);
  text-decoration: none;
  font-size: 13px;
}

.about-link:hover {
  text-decoration: underline;
}

.producer {
  color: var(--text-secondary);
  font-size: 13px;
  margin-bottom: 12px;
}

.about-actions {
  margin: 24px 0;
}

.about-actions .btn {
  padding: 8px 16px;
  font-size: 13px;
  border-radius: 6px;
  border: 1px solid var(--border-color);
  background: var(--bg-tertiary);
  color: var(--text-primary);
  cursor: pointer;
  transition: all 0.2s ease;
}

.about-actions .btn:hover {
  background: var(--bg-hover);
}

.btn-outline {
  background: transparent;
}

.copyright {
  color: var(--text-muted);
  font-size: 12px;
}

/* 设置内容切换动画 */
.settings-content > * {
  animation: contentFadeIn 0.25s ease;
}

@keyframes contentFadeIn {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

/* 关于页面 logo 动画 */
.about-logo {
  animation: logoFloat 3s ease-in-out infinite;
}

@keyframes logoFloat {
  0%, 100% { transform: translateY(0) rotate(0deg); }
  50% { transform: translateY(-8px) rotate(5deg); }
}
</style>

