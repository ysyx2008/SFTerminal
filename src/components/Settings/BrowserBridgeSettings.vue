<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { Copy, RefreshCw } from 'lucide-vue-next'
import {
  BROWSER_BRIDGE_FIREFOX_AMO_LISTING_URL,
  isBrowserBridgeComponentsInstalled,
  isChromiumBridgeConnection,
  isFirefoxBridgeConnection,
  type BrowserBridgeStatus,
} from '@shared/types/browser-bridge'

const { t } = useI18n()

const installing = ref(false)
const uninstalling = ref(false)
const checking = ref(false)
const status = ref<BrowserBridgeStatus | null>(null)
const errorMsg = ref('')
const actionMsg = ref('')
const loadReadyMsg = ref<'chromium' | 'firefox' | null>(null)
let actionMsgTimer: ReturnType<typeof setTimeout> | null = null
let loadReadyTimer: ReturnType<typeof setTimeout> | null = null

const copiedPathKey = ref<string | null>(null)
let copiedPathTimer: ReturnType<typeof setTimeout> | null = null

const isMac = computed(() => navigator.platform.toLowerCase().includes('mac'))
const chromiumPath = computed(() => status.value?.install?.chromiumExtensionPath ?? '')
const firefoxPath = computed(() => status.value?.install?.firefoxExtensionPath ?? '')
const chromiumFolderName = computed(() => folderBaseName(chromiumPath.value) || 'extension-chromium')
const firefoxManifestPath = computed(() =>
  firefoxPath.value ? `${firefoxPath.value}/manifest.json` : '',
)

function folderBaseName(filePath: string): string {
  if (!filePath) return ''
  const sep = filePath.includes('\\') ? '\\' : '/'
  return filePath.slice(filePath.lastIndexOf(sep) + 1)
}

function parentFolder(filePath: string): string {
  const sep = filePath.includes('\\') ? '\\' : '/'
  const idx = filePath.lastIndexOf(sep)
  return idx > 0 ? filePath.slice(0, idx) : filePath
}

const componentsInstalled = computed(() => isBrowserBridgeComponentsInstalled(status.value?.install))

const connections = computed(() => status.value?.connections ?? [])
const chromiumConnection = computed(() => connections.value.find(isChromiumBridgeConnection))
const firefoxConnection = computed(() => connections.value.find(isFirefoxBridgeConnection))
const chromiumConnected = computed(() => Boolean(chromiumConnection.value))
const firefoxConnected = computed(() => Boolean(firefoxConnection.value))
const anyConnected = computed(() => chromiumConnected.value || firefoxConnected.value)

function extensionStatusLabel(version?: string): string {
  if (version) {
    return t('browserBridge.statusExtensionConnectedVersion', { version })
  }
  return t('browserBridge.statusExtensionConnected')
}

function flashActionMsg(msg: string) {
  actionMsg.value = msg
  if (actionMsgTimer) clearTimeout(actionMsgTimer)
  actionMsgTimer = setTimeout(() => {
    actionMsg.value = ''
  }, 4000)
}

function flashLoadReady(kind: 'chromium' | 'firefox') {
  loadReadyMsg.value = kind
  if (loadReadyTimer) clearTimeout(loadReadyTimer)
  loadReadyTimer = setTimeout(() => {
    loadReadyMsg.value = null
  }, 10000)
}

async function refreshStatus() {
  checking.value = true
  errorMsg.value = ''
  try {
    status.value = await window.electronAPI.browserBridge.getStatus()
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : String(e)
  } finally {
    checking.value = false
  }
}

async function install() {
  const wasInstalled = componentsInstalled.value
  installing.value = true
  errorMsg.value = ''
  actionMsg.value = ''
  try {
    const result = await window.electronAPI.browserBridge.install()
    if (result.errors?.length) {
      errorMsg.value = result.errors.join('\n')
    } else {
      flashActionMsg(
        wasInstalled ? t('browserBridge.reinstallSuccess') : t('browserBridge.installSuccessShort'),
      )
    }
    await refreshStatus()
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : String(e)
  } finally {
    installing.value = false
  }
}

async function uninstall() {
  if (!confirm(t('browserBridge.confirmUninstall'))) return
  uninstalling.value = true
  errorMsg.value = ''
  actionMsg.value = ''
  try {
    const result = await window.electronAPI.browserBridge.uninstall()
    if (result.errors?.length) {
      errorMsg.value = result.errors.join('\n')
    } else {
      flashActionMsg(t('browserBridge.uninstallSuccess'))
    }
    await refreshStatus()
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : String(e)
  } finally {
    uninstalling.value = false
  }
}

async function copyExtensionPath(kind: 'chromium' | 'firefox') {
  const folderPath = kind === 'chromium' ? chromiumPath.value : firefoxPath.value
  if (!folderPath) return
  try {
    await navigator.clipboard.writeText(folderPath)
    copiedPathKey.value = kind
    if (copiedPathTimer) clearTimeout(copiedPathTimer)
    copiedPathTimer = setTimeout(() => {
      copiedPathKey.value = null
    }, 2500)
  } catch {
    errorMsg.value = t('browserBridge.copyFailed')
  }
}

async function revealExtensionFolder(kind: 'chromium' | 'firefox') {
  const folderPath = kind === 'chromium' ? chromiumPath.value : firefoxPath.value
  if (!folderPath) return
  if (kind === 'firefox' && isMac.value && firefoxManifestPath.value) {
    await window.electronAPI.shell.showItemInFolder(firefoxManifestPath.value)
    return
  }
  const openTarget = kind === 'chromium' && isMac.value
    ? parentFolder(folderPath)
    : folderPath
  await window.electronAPI.shell.openPath(openTarget)
}

async function startLoadChromium(browser: 'chrome' | 'edge' = 'chrome') {
  if (!chromiumPath.value) return
  errorMsg.value = ''
  if (!isMac.value) await copyExtensionPath('chromium')
  try {
    await window.electronAPI.browserBridge.openExtensionGuide(browser)
  } catch {
    errorMsg.value = t(`browserBridge.openGuideFailed.${browser}`)
    return
  }
  await revealExtensionFolder('chromium')
  flashLoadReady('chromium')
}

async function startLoadFirefox() {
  if (!firefoxPath.value) return
  errorMsg.value = ''
  if (!isMac.value) await copyExtensionPath('firefox')
  try {
    await window.electronAPI.browserBridge.openExtensionGuide('firefox')
  } catch {
    errorMsg.value = t('browserBridge.openGuideFailed.firefox')
    return
  }
  await revealExtensionFolder('firefox')
  flashLoadReady('firefox')
}

let unsubConnections: (() => void) | null = null
let pollTimer: ReturnType<typeof setInterval> | null = null

function startPollingIfNeeded() {
  if (pollTimer) return
  // 如果有浏览器未连接，每 4s 自动刷新一次，最长 90s
  let elapsed = 0
  pollTimer = setInterval(async () => {
    elapsed += 4
    if (anyConnected.value || elapsed >= 90) {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
      return
    }
    await refreshStatus()
  }, 4000)
}

onMounted(() => {
  void refreshStatus().then(startPollingIfNeeded)
  unsubConnections = window.electronAPI.browserBridge.onConnectionsChanged((next) => {
    status.value = next
    if (anyConnected.value && pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
  })
})

onUnmounted(() => {
  unsubConnections?.()
  if (actionMsgTimer) clearTimeout(actionMsgTimer)
  if (copiedPathTimer) clearTimeout(copiedPathTimer)
  if (loadReadyTimer) clearTimeout(loadReadyTimer)
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
})
</script>

<template>
  <div class="browser-bridge-settings">
    <!-- 未安装：整页仅安装入口 -->
    <div v-if="!componentsInstalled" class="settings-section">
      <h4 class="page-title">{{ t('browserBridge.title') }}</h4>
      <p class="section-desc">{{ t('browserBridge.installIntro') }}</p>
      <button
        type="button"
        class="btn btn-primary install-cta"
        :disabled="installing"
        @click="install"
      >
        {{ installing ? t('browserBridge.installing') : t('browserBridge.install') }}
      </button>
      <p v-if="actionMsg" class="flash-msg">{{ actionMsg }}</p>
      <div v-if="errorMsg" class="error-msg">{{ errorMsg }}</div>
    </div>

    <template v-else>
      <!-- 页头 + 刷新 -->
      <div class="settings-section dashboard-header">
        <div class="header-row">
          <div>
            <h4 class="page-title">{{ t('browserBridge.title') }}</h4>
            <p class="section-desc header-desc">{{ t('browserBridge.description') }}</p>
          </div>
          <button
            type="button"
            class="btn btn-sm btn-outline refresh-btn"
            :disabled="checking"
            @click="refreshStatus"
          >
            <RefreshCw :size="14" :class="{ spinning: checking }" />
            {{ checking ? t('browserBridge.rechecking') : t('browserBridge.refresh') }}
          </button>
        </div>
        <p v-if="actionMsg" class="flash-msg">{{ actionMsg }}</p>
        <div v-if="errorMsg" class="error-msg">{{ errorMsg }}</div>
      </div>

      <!-- 浏览器状态卡 -->
      <div class="settings-section browser-cards">
        <!-- Chromium -->
        <div class="browser-card" :class="{ connected: chromiumConnected }">
          <div class="browser-card-main">
            <div class="browser-card-info">
              <span class="browser-card-icon" aria-hidden="true">🌐</span>
              <div>
                <div class="browser-card-title">{{ t('browserBridge.dashboardChromiumTitle') }}</div>
                <div
                  class="browser-card-status"
                  :class="chromiumConnected ? 'is-connected' : 'is-disconnected'"
                >
                  {{
                    chromiumConnected
                      ? extensionStatusLabel(chromiumConnection?.version)
                      : t('browserBridge.statusExtensionDisconnected')
                  }}
                </div>
              </div>
            </div>
            <button
              v-if="!chromiumConnected"
              type="button"
              class="btn btn-sm btn-primary"
              @click="startLoadChromium('chrome')"
            >
              {{ isMac ? t('browserBridge.startLoadChromeMac') : t('browserBridge.startLoadChrome') }}
            </button>
          </div>

          <template v-if="!chromiumConnected">
            <p v-if="loadReadyMsg === 'chromium'" class="load-ready-msg">
              {{ isMac ? t('browserBridge.loadExtensionReadyMac') : t('browserBridge.loadExtensionReady') }}
            </p>
            <details class="guide-details">
              <summary>{{ t('browserBridge.howToLoadChromium') }}</summary>
              <ol class="guide-steps">
                <template v-if="isMac">
                  <li>{{ t('browserBridge.dragStep1') }}</li>
                  <li>{{ t('browserBridge.dragStep2') }}</li>
                  <li>
                    {{ t('browserBridge.dragStep3Prefix') }}
                    <code class="folder-name">{{ chromiumFolderName }}</code>
                    {{ t('browserBridge.dragStep3Suffix') }}
                  </li>
                </template>
                <template v-else>
                  <li>{{ t('browserBridge.chromeStep2') }}</li>
                  <li>{{ t('browserBridge.chromeStep3Win') }}</li>
                </template>
              </ol>
              <div class="card-actions">
                <button type="button" class="btn btn-sm btn-outline" @click="startLoadChromium('edge')">
                  {{ t('browserBridge.startLoadEdge') }}
                </button>
                <button
                  v-if="!isMac"
                  type="button"
                  class="btn btn-sm btn-outline"
                  @click="copyExtensionPath('chromium')"
                >
                  <Copy :size="13" />
                  {{ copiedPathKey === 'chromium' ? t('browserBridge.copied') : t('browserBridge.copyPath') }}
                </button>
              </div>
            </details>
          </template>
        </div>

        <!-- Firefox -->
        <div class="browser-card firefox-card" :class="{ connected: firefoxConnected }">
          <div class="browser-card-main">
            <div class="browser-card-info">
              <span class="browser-card-icon" aria-hidden="true">🦊</span>
              <div>
                <div class="browser-card-title">{{ t('browserBridge.dashboardFirefoxTitle') }}</div>
                <div
                  class="browser-card-status"
                  :class="firefoxConnected ? 'is-connected' : 'is-disconnected'"
                >
                  {{
                    firefoxConnected
                      ? extensionStatusLabel(firefoxConnection?.version)
                      : t('browserBridge.statusExtensionDisconnected')
                  }}
                </div>
              </div>
            </div>
            <div v-if="!firefoxConnected" class="browser-card-actions">
              <a
                class="btn btn-sm btn-primary firefox-btn"
                :href="BROWSER_BRIDGE_FIREFOX_AMO_LISTING_URL"
                target="_blank"
                rel="noopener noreferrer"
              >
                {{ t('browserBridge.firefoxAmoInstall') }}
              </a>
              <button
                type="button"
                class="btn btn-sm btn-outline"
                @click="startLoadFirefox"
              >
                {{ t('browserBridge.startLoadFirefoxTemp') }}
              </button>
            </div>
          </div>

          <template v-if="!firefoxConnected">
            <p v-if="loadReadyMsg === 'firefox'" class="load-ready-msg">
              {{ isMac ? t('browserBridge.loadFirefoxReadyMac') : t('browserBridge.loadFirefoxReady') }}
            </p>
            <details class="guide-details">
              <summary>{{ t('browserBridge.howToLoadFirefoxTemp') }}</summary>
              <ol class="guide-steps">
                <template v-if="isMac">
                  <li>{{ t('browserBridge.firefoxDragStep1') }}</li>
                  <li>{{ t('browserBridge.firefoxDragStep2') }}</li>
                  <li>
                    {{ t('browserBridge.firefoxDragStep3Prefix') }}
                    <code class="folder-name">manifest.json</code>
                    {{ t('browserBridge.firefoxDragStep3Suffix') }}
                  </li>
                </template>
                <template v-else>
                  <li>{{ t('browserBridge.firefoxStep2') }}</li>
                  <li>{{ t('browserBridge.firefoxStep3') }}</li>
                </template>
              </ol>
              <p class="guide-note">{{ t('browserBridge.firefoxTempNote') }}</p>
            </details>
          </template>
        </div>
      </div>

      <!-- 就绪提示 -->
      <p v-if="anyConnected" class="ready-hint">{{ t('browserBridge.readyHint') }}</p>

      <!-- 高级 -->
      <details class="settings-section fold-section">
        <summary class="fold-summary">{{ t('browserBridge.advancedTitle') }}</summary>
        <div class="fold-body">
          <p class="section-desc">{{ t('browserBridge.oneBrowserNote') }}</p>
          <div class="advanced-actions">
            <button
              type="button"
              class="btn btn-sm btn-outline"
              :disabled="installing || uninstalling"
              @click="install"
            >
              {{ installing ? t('browserBridge.installing') : t('browserBridge.reinstall') }}
            </button>
            <button
              type="button"
              class="btn btn-sm btn-outline btn-danger-outline"
              :disabled="installing || uninstalling"
              @click="uninstall"
            >
              {{ uninstalling ? t('browserBridge.uninstalling') : t('browserBridge.uninstall') }}
            </button>
          </div>
        </div>
      </details>

      <!-- 故障排查 -->
      <details class="settings-section fold-section">
        <summary class="fold-summary">{{ t('browserBridge.troubleshootTitle') }}</summary>
        <div class="fold-body">
          <ol class="troubleshoot-steps">
            <li>{{ t('browserBridge.troubleshootStep1') }}</li>
            <li>
              {{ t('browserBridge.troubleshootStep2Prefix') }}
              <code class="folder-name">{{ status?.extensionIds?.chromium }}</code>
              {{ t('browserBridge.troubleshootStep2Suffix') }}
            </li>
            <li>{{ t('browserBridge.troubleshootStep3') }}</li>
            <li>{{ t('browserBridge.troubleshootStep4') }}</li>
            <li>{{ t('browserBridge.troubleshootStep5') }}</li>
          </ol>
        </div>
      </details>
    </template>
  </div>
</template>

<style scoped>
.browser-bridge-settings {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.settings-section {
  background: var(--bg-tertiary);
  border-radius: 8px;
  padding: 16px;
}

.page-title {
  font-size: 14px;
  font-weight: 600;
  margin: 0 0 6px;
}

.section-desc {
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.5;
  margin: 0;
}

.header-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.header-desc {
  margin-top: 4px;
}

.refresh-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.refresh-btn .spinning {
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.install-cta {
  width: 100%;
  margin-top: 12px;
  padding: 10px 16px;
  font-weight: 600;
}

.browser-cards {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
}

.browser-card {
  padding: 12px 14px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
}

.browser-card.connected {
  border-color: rgba(63, 185, 80, 0.35);
}

.browser-card-main {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.browser-card-info {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.browser-card-icon {
  font-size: 18px;
  flex-shrink: 0;
}

.browser-card-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}

.browser-card-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  justify-content: flex-end;
}

.browser-card-status {
  font-size: 12px;
  margin-top: 2px;
}

.browser-card-status.is-connected {
  color: var(--success-color, #3fb950);
}

.browser-card-status.is-disconnected {
  color: var(--text-muted);
}

.firefox-btn {
  background: var(--accent-orange, #ff7139);
  border-color: var(--accent-orange, #ff7139);
}

.firefox-btn:hover {
  filter: brightness(1.05);
}

.load-ready-msg {
  margin: 10px 0 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--success-color, #3fb950);
}

.guide-details {
  margin-top: 10px;
  font-size: 12px;
  color: var(--text-muted);
}

.guide-details summary {
  cursor: pointer;
  color: var(--text-secondary);
  user-select: none;
}

.guide-details summary:hover {
  color: var(--text-primary);
}

.guide-steps {
  margin: 10px 0 0;
  padding-left: 18px;
  line-height: 1.6;
  color: var(--text-secondary);
}

.guide-steps li + li {
  margin-top: 6px;
}

.guide-note {
  margin: 10px 0 0;
  font-size: 12px;
  color: var(--text-muted);
}

.card-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 10px;
}

.ready-hint {
  margin: 0;
  padding: 0 4px;
  font-size: 12px;
  line-height: 1.55;
  color: var(--text-secondary);
}

.fold-section {
  padding: 0;
  overflow: hidden;
}

.fold-summary {
  padding: 12px 16px;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  color: var(--text-secondary);
  user-select: none;
  list-style: none;
}

.fold-summary::-webkit-details-marker {
  display: none;
}

.fold-summary:hover {
  color: var(--text-primary);
}

.fold-body {
  padding: 14px 16px 16px;
  border-top: 1px solid var(--border-color);
}

.fold-body .section-desc {
  margin: 0;
}

.advanced-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
}

.troubleshoot-steps {
  margin: 12px 0 0;
  padding-left: 18px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-secondary);
}

.troubleshoot-steps li + li {
  margin-top: 6px;
}

.folder-name {
  font-family: 'SF Mono', Monaco, Consolas, monospace;
  font-size: 11px;
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--bg-tertiary);
  color: var(--accent-primary);
}

.flash-msg {
  font-size: 13px;
  color: var(--text-muted);
  margin: 10px 0 0;
}

.error-msg {
  color: var(--danger-color, var(--color-error));
  font-size: 12px;
  margin-top: 10px;
  padding: 8px 12px;
  background: rgba(var(--color-error-rgb), 0.08);
  border-radius: 6px;
  border-left: 3px solid var(--danger-color, var(--color-error));
  white-space: pre-wrap;
}

.btn-danger-outline {
  color: var(--danger-color, var(--color-error));
  border-color: rgba(var(--color-error-rgb), 0.35);
}

.btn-danger-outline:hover:not(:disabled) {
  background: rgba(var(--color-error-rgb), 0.08);
}

@media (max-width: 520px) {
  .browser-card-main {
    flex-direction: column;
    align-items: stretch;
  }

  .header-row {
    flex-direction: column;
  }

  .refresh-btn {
    align-self: flex-start;
  }
}
</style>
