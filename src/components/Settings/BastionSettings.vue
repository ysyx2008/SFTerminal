<script setup lang="ts">
import { ref, onMounted, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { CheckCircle, AlertCircle, Loader2, Shield } from 'lucide-vue-next'
import { useConfigStore } from '../../stores/config'

const { t } = useI18n()
const configStore = useConfigStore()

const url = ref('')
const username = ref('')
const password = ref('')
const autoJumpHost = ref(true)
const jumpHostPort = ref(2222)
const rejectUnauthorized = ref(true)

const isTesting = ref(false)
const isSyncing = ref(false)
const testResult = ref<{ success: boolean; message: string } | null>(null)
const syncResult = ref<{ success: boolean; error?: string; added: number; updated: number; removed: number; total: number; groupName: string } | null>(null)

const canOperate = computed(() => url.value.trim() && username.value.trim() && password.value.trim())
const canSync = computed(() => canOperate.value && testResult.value?.success === true)

watch([url, username, password], () => {
  testResult.value = null
  syncResult.value = null
})

onMounted(async () => {
  try {
    const config = await window.electronAPI.bastion.getConfig()
    url.value = config.url
    username.value = config.username
    password.value = config.password
    autoJumpHost.value = config.autoJumpHost
    jumpHostPort.value = config.jumpHostPort
    rejectUnauthorized.value = config.rejectUnauthorized
  } catch {
    // ignore
  }
})

async function saveConfig() {
  await window.electronAPI.bastion.saveConfig({
    url: url.value.trim(),
    username: username.value.trim(),
    password: password.value,
    autoJumpHost: autoJumpHost.value,
    jumpHostPort: jumpHostPort.value,
    rejectUnauthorized: rejectUnauthorized.value
  })
}

async function testConnection() {
  if (!canOperate.value) return
  isTesting.value = true
  testResult.value = null
  syncResult.value = null

  try {
    await saveConfig()
    const result = await window.electronAPI.bastion.testConnection({
      url: url.value.trim(),
      username: username.value.trim(),
      password: password.value,
      rejectUnauthorized: rejectUnauthorized.value
    })
    testResult.value = result
  } catch (e: any) {
    testResult.value = { success: false, message: e.message || String(e) }
  } finally {
    isTesting.value = false
  }
}

async function syncAssets() {
  if (!canOperate.value) return
  isSyncing.value = true
  testResult.value = null
  syncResult.value = null

  try {
    await saveConfig()
    const result = await window.electronAPI.bastion.syncAssets()
    syncResult.value = result

    if (result.success) {
      await configStore.loadConfig()
    }
  } catch (e: any) {
    syncResult.value = { success: false, error: e.message || String(e), added: 0, updated: 0, removed: 0, total: 0, groupName: '' }
  } finally {
    isSyncing.value = false
  }
}
</script>

<template>
  <div class="bastion-settings">
    <!-- 标题区 -->
    <div class="header">
      <div class="header-icon">
        <Shield :size="18" />
      </div>
      <div>
        <h4>{{ t('settings.bastion.title') }}</h4>
        <p class="header-desc">{{ t('settings.bastion.description') }}</p>
      </div>
    </div>

    <!-- 凭证卡片 -->
    <div class="credential-card">
      <div class="form-group">
        <label class="form-label">{{ t('settings.bastion.url') }}</label>
        <input
          v-model="url"
          type="text"
          class="input-field"
          placeholder="https://jumpserver.example.com"
        />
      </div>

      <div class="form-row">
        <div class="form-group flex-1">
          <label class="form-label">{{ t('settings.bastion.username') }}</label>
          <input
            v-model="username"
            type="text"
            class="input-field"
            :placeholder="t('settings.bastion.usernamePlaceholder')"
          />
        </div>
        <div class="form-group flex-1">
          <label class="form-label">{{ t('settings.bastion.password') }}</label>
          <input
            v-model="password"
            type="password"
            class="input-field"
            autocomplete="new-password"
            :placeholder="t('settings.bastion.passwordPlaceholder')"
          />
        </div>
      </div>
    </div>

    <!-- 选项 -->
    <div class="option-card">
      <div class="setting-row">
        <div class="setting-text">
          <label class="form-label">{{ t('settings.bastion.autoJumpHost') }}</label>
          <p class="setting-desc">{{ t('settings.bastion.autoJumpHostHint') }}</p>
        </div>
        <div class="setting-controls">
          <div v-if="autoJumpHost" class="port-inline">
            <span class="port-label">{{ t('settings.bastion.jumpHostPort') }}</span>
            <input
              v-model.number="jumpHostPort"
              type="number"
              min="1"
              max="65535"
              class="input-field input-port"
            />
          </div>
          <label class="toggle-switch">
            <input type="checkbox" v-model="autoJumpHost" />
            <span class="toggle-slider"></span>
          </label>
        </div>
      </div>
      <div class="setting-row">
        <div class="setting-text">
          <label class="form-label">{{ t('settings.bastion.ignoreSsl') }}</label>
          <p class="setting-desc">{{ t('settings.bastion.ignoreSslHint') }}</p>
        </div>
        <label class="toggle-switch">
          <input type="checkbox" :checked="!rejectUnauthorized" @change="rejectUnauthorized = !($event.target as HTMLInputElement).checked" />
          <span class="toggle-slider"></span>
        </label>
      </div>
    </div>

    <!-- 操作按钮 -->
    <div class="action-row">
      <button
        class="btn btn-primary"
        :disabled="!canOperate || isTesting || isSyncing"
        @click="testConnection"
      >
        <Loader2 v-if="isTesting" :size="14" class="spin" />
        {{ isTesting ? t('settings.bastion.testing') : t('settings.bastion.testConnection') }}
      </button>
      <button
        class="btn btn-primary"
        :disabled="!canSync || isTesting || isSyncing"
        @click="syncAssets"
      >
        <Loader2 v-if="isSyncing" :size="14" class="spin" />
        {{ isSyncing ? t('settings.bastion.syncing') : t('settings.bastion.syncAssets') }}
      </button>
    </div>

    <!-- 结果消息 -->
    <div v-if="testResult" class="result-msg" :class="testResult.success ? 'success' : 'error'">
      <CheckCircle v-if="testResult.success" :size="14" />
      <AlertCircle v-else :size="14" />
      <span>{{ testResult.message }}</span>
    </div>

    <div v-if="syncResult" class="result-msg" :class="syncResult.success ? 'success' : 'error'">
      <template v-if="syncResult.success">
        <CheckCircle :size="14" />
        <span>
          {{ t('settings.bastion.syncSuccess', { added: syncResult.added, updated: syncResult.updated, total: syncResult.total }) }}
          <template v-if="syncResult.removed > 0">
            <br />{{ t('settings.bastion.syncRemoved', { count: syncResult.removed }) }}
          </template>
          <br />{{ t('settings.bastion.syncGroup', { name: syncResult.groupName }) }}
        </span>
      </template>
      <template v-else>
        <AlertCircle :size="14" />
        <span>{{ syncResult.error }}</span>
      </template>
    </div>

    <!-- 使用说明 -->
    <div class="guide-section">
      <p>{{ t('settings.bastion.guideTitle') }}</p>
      <ol>
        <li>{{ t('settings.bastion.guide1') }}</li>
        <li>{{ t('settings.bastion.guide2') }}</li>
        <li>{{ t('settings.bastion.guide3') }}</li>
        <li>{{ t('settings.bastion.guide4') }}</li>
      </ol>
    </div>
  </div>
</template>

<style scoped>
.bastion-settings {
  padding: 0;
}

/* 标题区 */
.header {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  margin-bottom: 20px;
}

.header-icon {
  width: 36px;
  height: 36px;
  border-radius: 8px;
  background: rgba(var(--accent-primary-rgb, 56, 139, 253), 0.12);
  color: var(--accent-primary);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.header h4 {
  font-size: 14px;
  font-weight: 600;
  margin-bottom: 3px;
}

.header-desc {
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.5;
}

/* 凭证卡片 */
.credential-card {
  padding: 14px;
  background: var(--bg-tertiary);
  border-radius: 8px;
  margin-bottom: 12px;
}

.credential-card .form-group:last-child {
  margin-bottom: 0;
}

/* 选项卡片 */
.option-card {
  padding: 4px 14px;
  background: var(--bg-tertiary);
  border-radius: 8px;
  margin-bottom: 4px;
}

/* 表单控件 */
.form-group {
  margin-bottom: 12px;
}

.form-label {
  display: block;
  font-size: 12px;
  font-weight: 500;
  margin-bottom: 6px;
  color: var(--text-primary);
}

.form-row {
  display: flex;
  gap: 12px;
}

.form-row .form-group {
  margin-bottom: 0;
}

.flex-1 {
  flex: 1;
}

.input-field {
  width: 100%;
  padding: 8px 12px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  background: var(--bg-secondary);
  color: var(--text-primary);
  font-size: 13px;
  outline: none;
  transition: border-color 0.2s;
  box-sizing: border-box;
}

.input-field:focus {
  border-color: var(--accent-primary);
}

/* 设置行 */
.setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 10px 0;
}

.setting-text {
  flex: 1;
  min-width: 0;
}

.setting-text .form-label {
  margin-bottom: 2px;
}

.setting-desc {
  font-size: 11px;
  color: var(--text-muted);
  line-height: 1.4;
}

.setting-controls {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
}

.port-inline {
  display: flex;
  align-items: center;
  gap: 6px;
}

.port-label {
  font-size: 11px;
  color: var(--text-muted);
  white-space: nowrap;
}

.input-port {
  width: 72px;
  padding: 4px 8px;
  font-size: 12px;
  text-align: center;
}

/* 开关 */
.toggle-switch {
  position: relative;
  width: 36px;
  height: 20px;
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
  inset: 0;
  background: var(--border-color);
  border-radius: 20px;
  transition: 0.2s;
}

.toggle-slider::before {
  content: '';
  position: absolute;
  width: 16px;
  height: 16px;
  left: 2px;
  bottom: 2px;
  background: white;
  border-radius: 50%;
  transition: 0.2s;
}

.toggle-switch input:checked + .toggle-slider {
  background: var(--accent-primary);
}

.toggle-switch input:checked + .toggle-slider::before {
  transform: translateX(16px);
}

/* 操作按钮 */
.action-row {
  display: flex;
  gap: 10px;
  margin: 16px 0 12px;
}

.btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 7px 16px;
  border: none;
  border-radius: 6px;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s;
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-primary {
  background: var(--bg-tertiary);
  color: var(--text-primary);
  border: 1px solid var(--border-color);
}

.btn-primary:hover:not(:disabled) {
  background: var(--bg-hover);
}

/* 结果消息 */
.result-msg {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 10px 12px;
  border-radius: 6px;
  font-size: 12px;
  line-height: 1.6;
  margin-bottom: 10px;
}

.result-msg.success {
  background: rgba(63, 185, 80, 0.1);
  color: var(--success-color, #3fb950);
}

.result-msg.error {
  background: rgba(var(--color-error-rgb), 0.1);
  color: var(--color-error);
}

.result-msg svg {
  flex-shrink: 0;
  margin-top: 2px;
}

/* 使用说明 */
.guide-section {
  padding: 12px 14px;
  margin-top: 16px;
  background: var(--bg-tertiary);
  border-radius: 8px;
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.6;
}

.guide-section p {
  font-weight: 500;
  margin-bottom: 6px;
  color: var(--text-secondary);
}

.guide-section ol {
  margin: 0;
  padding-left: 18px;
}

.guide-section li {
  margin-bottom: 2px;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.spin {
  animation: spin 1s linear infinite;
}
</style>
