<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Plus, Trash2, RefreshCw, Package, X } from 'lucide-vue-next'

const { t } = useI18n()

interface PluginInfo {
  id: string
  name?: string
  description?: string
  version?: string
  enabled: boolean
  toolCount: number
}

const plugins = ref<PluginInfo[]>([])
const loading = ref(false)
const installing = ref(false)
const showInstallDialog = ref(false)
const installSpec = ref('')
const installError = ref('')
const uninstallConfirmId = ref<string | null>(null)
const operationMessage = ref<{ type: 'success' | 'error'; text: string } | null>(null)

const enabledCount = computed(() => plugins.value.filter(p => p.enabled).length)
const totalToolCount = computed(() => plugins.value.filter(p => p.enabled).reduce((sum, p) => sum + p.toolCount, 0))

const loadPlugins = async () => {
  loading.value = true
  try {
    plugins.value = await window.electronAPI.plugin.list()
  } catch (err) {
    console.error('Failed to load plugins:', err)
  } finally {
    loading.value = false
  }
}

const togglePlugin = async (plugin: PluginInfo) => {
  try {
    if (plugin.enabled) {
      await window.electronAPI.plugin.disable(plugin.id)
    } else {
      await window.electronAPI.plugin.enable(plugin.id)
    }
    await loadPlugins()
  } catch (err) {
    console.error('Failed to toggle plugin:', err)
  }
}

const openInstallDialog = () => {
  installSpec.value = ''
  installError.value = ''
  showInstallDialog.value = true
}

const doInstall = async () => {
  const spec = installSpec.value.trim()
  if (!spec) return

  installing.value = true
  installError.value = ''
  try {
    const result = await window.electronAPI.plugin.install(spec)
    if (result.success) {
      showInstallDialog.value = false
      showMessage('success', t('pluginSettings.installSuccess'))
      await loadPlugins()
    } else {
      installError.value = result.error || t('pluginSettings.installFailed')
    }
  } catch (err) {
    installError.value = String(err)
  } finally {
    installing.value = false
  }
}

const confirmUninstall = (id: string) => {
  uninstallConfirmId.value = id
}

const doUninstall = async (id: string) => {
  uninstallConfirmId.value = null
  try {
    const result = await window.electronAPI.plugin.uninstall(id)
    if (result.success) {
      showMessage('success', t('pluginSettings.uninstallSuccess'))
      await loadPlugins()
    } else {
      showMessage('error', result.error || t('pluginSettings.uninstallFailed'))
    }
  } catch (err) {
    showMessage('error', String(err))
  }
}

const showMessage = (type: 'success' | 'error', text: string) => {
  operationMessage.value = { type, text }
  setTimeout(() => { operationMessage.value = null }, 3000)
}

onMounted(loadPlugins)
</script>

<template>
  <div class="plugin-settings">
    <div class="settings-section">
      <div class="section-header">
        <div class="header-left">
          <h4>{{ t('pluginSettings.title') }}</h4>
          <span class="plugin-badge" v-if="enabledCount > 0">
            {{ enabledCount }} {{ t('pluginSettings.enabled') }}
          </span>
          <span class="tool-badge" v-if="totalToolCount > 0">
            {{ totalToolCount }} {{ t('pluginSettings.tools') }}
          </span>
        </div>
        <div class="header-actions">
          <button class="btn btn-sm" @click="loadPlugins" :disabled="loading">
            <RefreshCw :size="14" :class="{ spinning: loading }" />
          </button>
          <button class="btn btn-primary btn-sm" @click="openInstallDialog">
            <Plus :size="14" />
            {{ t('pluginSettings.install') }}
          </button>
        </div>
      </div>
      <p class="section-desc">
        {{ t('pluginSettings.description') }}
      </p>

      <!-- 操作反馈 -->
      <div v-if="operationMessage" class="operation-message" :class="operationMessage.type">
        {{ operationMessage.text }}
      </div>

      <!-- 插件列表 -->
      <div class="plugin-list" v-if="plugins.length > 0">
        <div
          v-for="plugin in plugins"
          :key="plugin.id"
          class="plugin-item"
          :class="{ disabled: !plugin.enabled }"
        >
          <div class="plugin-toggle">
            <input
              type="checkbox"
              :checked="plugin.enabled"
              @change="togglePlugin(plugin)"
            />
          </div>
          <div class="plugin-icon">
            <Package :size="20" />
          </div>
          <div class="plugin-info">
            <div class="plugin-name">
              {{ plugin.name || plugin.id }}
              <span class="plugin-version" v-if="plugin.version">v{{ plugin.version }}</span>
            </div>
            <div class="plugin-desc" v-if="plugin.description">
              {{ plugin.description }}
            </div>
            <div class="plugin-meta">
              <span class="plugin-id">{{ plugin.id }}</span>
              <span class="plugin-tool-count" v-if="plugin.toolCount > 0">
                {{ plugin.toolCount }} {{ t('pluginSettings.tools') }}
              </span>
            </div>
          </div>
          <div class="plugin-actions">
            <button
              v-if="uninstallConfirmId !== plugin.id"
              class="btn-icon danger"
              @click="confirmUninstall(plugin.id)"
              :title="t('pluginSettings.uninstall')"
            >
              <Trash2 :size="14" />
            </button>
            <template v-else>
              <button class="btn btn-sm btn-danger" @click="doUninstall(plugin.id)">
                {{ t('common.confirm') }}
              </button>
              <button class="btn btn-sm" @click="uninstallConfirmId = null">
                {{ t('common.cancel') }}
              </button>
            </template>
          </div>
        </div>
      </div>

      <!-- 空状态 -->
      <div class="empty-state" v-else-if="!loading">
        <Package :size="32" class="empty-icon" />
        <p>{{ t('pluginSettings.noPlugins') }}</p>
        <p class="empty-hint">{{ t('pluginSettings.noPluginsHint') }}</p>
      </div>
    </div>

    <!-- 安装对话框 -->
    <Teleport to="body">
      <div v-if="showInstallDialog" class="dialog-overlay settings-scope" @click.self="showInstallDialog = false">
        <div class="dialog">
          <div class="dialog-header">
            <h4>{{ t('pluginSettings.installTitle') }}</h4>
            <button class="btn-icon" @click="showInstallDialog = false">
              <X :size="16" />
            </button>
          </div>
          <div class="dialog-body">
            <p class="dialog-desc">{{ t('pluginSettings.installDesc') }}</p>
            <input
              v-model="installSpec"
              type="text"
              class="input"
              :placeholder="t('pluginSettings.installPlaceholder')"
              @keydown.enter="doInstall"
              :disabled="installing"
            />
            <p v-if="installError" class="error-text">{{ installError }}</p>
          </div>
          <div class="dialog-footer">
            <button class="btn" @click="showInstallDialog = false" :disabled="installing">
              {{ t('common.cancel') }}
            </button>
            <button class="btn btn-primary" @click="doInstall" :disabled="!installSpec.trim() || installing">
              {{ installing ? t('pluginSettings.installing') : t('pluginSettings.install') }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.plugin-settings {
  display: flex;
  flex-direction: column;
  gap: 20px;
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
}

.plugin-badge,
.tool-badge {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 10px;
}

.plugin-badge {
  background: var(--accent-green);
  color: var(--bg-primary);
}

.tool-badge {
  background: var(--accent-primary);
  color: var(--accent-contrast);
}

.header-actions {
  display: flex;
  gap: 8px;
}

.section-desc {
  font-size: 12px;
  color: var(--text-muted);
  margin-bottom: 16px;
  line-height: 1.5;
}

.operation-message {
  padding: 8px 12px;
  border-radius: 6px;
  font-size: 12px;
  margin-bottom: 12px;
}

.operation-message.success {
  background: var(--accent-green);
  color: var(--bg-primary);
}

.operation-message.error {
  background: var(--accent-red, #e53e3e);
  color: white;
}

/* 插件列表 */
.plugin-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.plugin-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  transition: all 0.2s ease;
}

.plugin-item:hover {
  border-color: var(--accent-primary);
}

.plugin-item.disabled {
  opacity: 0.5;
}

.plugin-toggle input {
  width: 16px;
  height: 16px;
  cursor: pointer;
}

.plugin-icon {
  color: var(--text-muted);
  flex-shrink: 0;
}

.plugin-info {
  flex: 1;
  min-width: 0;
}

.plugin-name {
  font-size: 14px;
  font-weight: 500;
  display: flex;
  align-items: center;
  gap: 8px;
}

.plugin-version {
  font-size: 11px;
  color: var(--text-muted);
  font-weight: 400;
}

.plugin-desc {
  font-size: 12px;
  color: var(--text-secondary);
  margin-top: 2px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.plugin-meta {
  display: flex;
  gap: 12px;
  margin-top: 4px;
  font-size: 11px;
  color: var(--text-muted);
}

.plugin-tool-count {
  color: var(--accent-primary);
}

.plugin-actions {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}

/* 空状态 */
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
}

.btn-icon.danger:hover {
  color: var(--color-error);
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.spinning {
  animation: spin 1s linear infinite;
}

/* 对话框 */
.dialog-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10000;
}

.dialog {
  background: var(--bg-primary);
  border-radius: 12px;
  width: 480px;
  max-width: 90vw;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
}

.dialog-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px;
  border-bottom: 1px solid var(--border-color);
}

.dialog-header h4 {
  font-size: 16px;
  font-weight: 600;
  margin: 0;
}

.dialog-body {
  padding: 16px;
}

.dialog-desc {
  font-size: 12px;
  color: var(--text-muted);
  margin-bottom: 12px;
}

.input {
  width: 100%;
  padding: 8px 12px;
  border-radius: 6px;
  border: 1px solid var(--border-color);
  background: var(--bg-secondary);
  color: var(--text-primary);
  font-size: 13px;
  outline: none;
  box-sizing: border-box;
}

.input:focus {
  border-color: var(--accent-primary);
}

.error-text {
  color: var(--accent-red, #e53e3e);
  font-size: 12px;
  margin-top: 8px;
}

.dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--border-color);
}
</style>
