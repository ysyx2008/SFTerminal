<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { CheckCircle2, Copy } from 'lucide-vue-next'
import type { BrowserBridgeStatus } from '@shared/types/browser-bridge'

const { t } = useI18n()

const installing = ref(false)
const uninstalling = ref(false)
const checking = ref(false)
const status = ref<BrowserBridgeStatus | null>(null)
const errorMsg = ref('')
const actionMsg = ref('')
const loadReadyMsg = ref('')
let actionMsgTimer: ReturnType<typeof setTimeout> | null = null

function flashActionMsg(msg: string) {
  actionMsg.value = msg
  if (actionMsgTimer) clearTimeout(actionMsgTimer)
  actionMsgTimer = setTimeout(() => {
    actionMsg.value = ''
  }, 4000)
}

const chromeExpanded = ref(true)
const edgeExpanded = ref(false)
const firefoxExpanded = ref(false)
const copiedPathKey = ref<string | null>(null)
let copiedPathTimer: ReturnType<typeof setTimeout> | null = null

const isMac = computed(() => navigator.platform.toLowerCase().includes('mac'))
const chromiumPath = computed(() => status.value?.install?.chromiumExtensionPath ?? '')
const firefoxPath = computed(() => status.value?.install?.firefoxExtensionPath ?? '')

const chromiumFolderName = computed(() => folderBaseName(chromiumPath.value) || 'extension-chromium')

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

const isConnected = computed(() => (status.value?.connections?.length ?? 0) > 0)
const connectionCount = computed(() => status.value?.connections?.length ?? 0)

/** 步骤 1：扩展文件与 Native Host 已写入本机 */
const componentsInstalled = computed(() => {
  const install = status.value?.install
  if (!install) return false
  return Boolean(install.chromiumExtensionPath) && install.registeredBrowsers.length > 0
})

const currentStep = computed(() => {
  if (isConnected.value) return 3
  if (componentsInstalled.value) return 2
  return 1
})

const step1StatusText = computed(() => {
  if (actionMsg.value) return actionMsg.value
  if (componentsInstalled.value) return t('browserBridge.step1Done')
  return ''
})

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
        wasInstalled ? t('browserBridge.reinstallSuccess') : t('browserBridge.installSuccess'),
      )
      if (!wasInstalled) chromeExpanded.value = true
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

async function recheckConnection() {
  await refreshStatus()
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
  // macOS：打开上一级目录，方便用户看到 extension-chromium 文件夹并拖进 Chrome
  const openTarget = kind === 'chromium' && isMac.value
    ? parentFolder(folderPath)
    : folderPath
  await window.electronAPI.shell.openPath(openTarget)
}

async function startLoadExtension(browser: 'chrome' | 'edge') {
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
  loadReadyMsg.value = t(isMac.value ? 'browserBridge.loadExtensionReadyMac' : 'browserBridge.loadExtensionReady')
  setTimeout(() => { loadReadyMsg.value = '' }, 10000)
}

async function startLoadFirefox() {
  if (!firefoxPath.value) return
  errorMsg.value = ''
  await copyExtensionPath('firefox')
  try {
    await window.electronAPI.browserBridge.openExtensionGuide('firefox')
  } catch {
    errorMsg.value = t('browserBridge.openGuideFailed.firefox')
    return
  }
  await revealExtensionFolder('firefox')
  loadReadyMsg.value = t('browserBridge.loadFirefoxReady')
  setTimeout(() => { loadReadyMsg.value = '' }, 8000)
}

function toggleOnly(target: 'chrome' | 'edge' | 'firefox') {
  if (!componentsInstalled.value) return
  chromeExpanded.value = target === 'chrome'
  edgeExpanded.value = target === 'edge'
  firefoxExpanded.value = target === 'firefox'
}

onMounted(refreshStatus)

onUnmounted(() => {
  if (actionMsgTimer) clearTimeout(actionMsgTimer)
  if (copiedPathTimer) clearTimeout(copiedPathTimer)
})
</script>

<template>
  <div class="browser-bridge-settings">
    <!-- 概览 -->
    <div class="settings-section">
      <div class="section-header">
        <div class="section-title-group">
          <h4>{{ t('browserBridge.title') }}</h4>
          <span class="status-badge" :class="{ active: isConnected }">
            <span class="status-dot"></span>
            {{
              isConnected
                ? t('browserBridge.statusConnected', { count: connectionCount })
                : t('browserBridge.statusDisconnected')
            }}
          </span>
        </div>
      </div>
      <p class="section-desc">{{ t('browserBridge.description') }}</p>

      <!-- 两步进度 -->
      <div class="wizard-track">
        <div class="wizard-step" :class="{ done: currentStep > 1, active: currentStep === 1 }">
          <span class="step-marker">{{ currentStep > 1 ? '✓' : '1' }}</span>
          <span class="step-label">{{ t('browserBridge.wizardStep1Short') }}</span>
        </div>
        <div class="wizard-line" :class="{ done: currentStep > 1 }"></div>
        <div class="wizard-step" :class="{ done: currentStep > 2, active: currentStep === 2 }">
          <span class="step-marker">{{ currentStep > 2 ? '✓' : '2' }}</span>
          <span class="step-label">{{ t('browserBridge.wizardStep2Short') }}</span>
        </div>
      </div>
      <p class="wizard-hint">{{ t('browserBridge.wizardHint') }}</p>

      <div v-if="errorMsg" class="error-msg">{{ errorMsg }}</div>
    </div>

    <!-- 步骤 1 -->
    <div class="settings-section step-section" :class="{ done: componentsInstalled }">
      <div class="step-header">
        <span class="step-badge" :class="{ done: componentsInstalled }">1</span>
        <div class="step-header-text">
          <h4>{{ t('browserBridge.step1Title') }}</h4>
          <p class="step-desc">{{ t('browserBridge.step1Desc') }}</p>
        </div>
      </div>

      <button
        v-if="!componentsInstalled"
        type="button"
        class="btn btn-primary install-cta"
        :disabled="installing || uninstalling"
        @click="install"
      >
        {{ installing ? t('browserBridge.installing') : t('browserBridge.install') }}
      </button>
      <p v-else-if="actionMsg && !componentsInstalled" class="flash-msg">{{ actionMsg }}</p>

      <div v-if="componentsInstalled" class="step1-footer">
        <p class="step1-status">
          <CheckCircle2 :size="15" class="step1-status-icon" />
          <span>{{ step1StatusText }}</span>
        </p>
        <div class="step1-actions">
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
    </div>

    <!-- 步骤 2 -->
    <div
      class="settings-section step-section"
      :class="{ disabled: !componentsInstalled, done: isConnected }"
    >
      <div class="step-header">
        <span class="step-badge" :class="{ done: isConnected, muted: !componentsInstalled }">2</span>
        <div>
          <h4>{{ t('browserBridge.step2Title') }}</h4>
          <p class="step-desc">{{ t('browserBridge.step2Desc') }}</p>
        </div>
        <CheckCircle2 v-if="isConnected" :size="20" class="step-done-icon" />
      </div>

      <div v-if="!componentsInstalled" class="step-locked">
        {{ t('browserBridge.step2Locked') }}
      </div>

      <template v-else>
        <!-- Chrome / Edge 共用：路径 + 一键引导 -->
        <div v-if="chromiumPath" class="extension-path-panel">
          <div class="load-actions">
            <button type="button" class="btn btn-primary load-cta" @click="startLoadExtension('chrome')">
              {{ isMac ? t('browserBridge.startLoadChromeMac') : t('browserBridge.startLoadChrome') }}
            </button>
            <button type="button" class="btn btn-sm btn-outline" @click="startLoadExtension('edge')">
              {{ t('browserBridge.startLoadEdge') }}
            </button>
          </div>
          <p v-if="loadReadyMsg" class="load-ready-msg">{{ loadReadyMsg }}</p>

          <!-- macOS：拖拽为主，无需粘贴 -->
          <div v-if="isMac" class="drag-method-box">
            <span class="method-badge">{{ t('browserBridge.recommended') }}</span>
            <p class="drag-method-title">{{ t('browserBridge.dragMethodTitle') }}</p>
            <ol class="drag-steps">
              <li>{{ t('browserBridge.dragStep1') }}</li>
              <li>{{ t('browserBridge.dragStep2') }}</li>
              <li>
                {{ t('browserBridge.dragStep3Prefix') }}
                <code class="folder-name">{{ chromiumFolderName }}</code>
                {{ t('browserBridge.dragStep3Suffix') }}
              </li>
            </ol>
          </div>

          <details v-if="isMac" class="paste-method-fallback">
            <summary>{{ t('browserBridge.pasteMethodTitle') }}</summary>
            <p class="paste-method-note">{{ t('browserBridge.pasteMethodNote') }}</p>
            <ol class="paste-steps">
              <li>{{ t('browserBridge.pasteMethodStep1') }}</li>
              <li>{{ t('browserBridge.pasteMethodStep2') }}</li>
            </ol>
            <div class="path-row">
              <code class="path-text path-text-sm" :title="chromiumPath">{{ chromiumPath }}</code>
              <button
                type="button"
                class="btn btn-sm btn-outline path-copy-btn"
                @click="copyExtensionPath('chromium')"
              >
                <Copy :size="13" />
                {{ copiedPathKey === 'chromium' ? t('browserBridge.copied') : t('browserBridge.copyPath') }}
              </button>
            </div>
          </details>

          <!-- Windows / Linux：粘贴路径 -->
          <template v-else>
            <p class="path-panel-title">{{ t('browserBridge.extensionPathLabel') }}</p>
            <div class="path-row">
              <code class="path-text" :title="chromiumPath">{{ chromiumPath }}</code>
              <button
                type="button"
                class="btn btn-sm btn-outline path-copy-btn"
                @click="copyExtensionPath('chromium')"
              >
                <Copy :size="13" />
                {{ copiedPathKey === 'chromium' ? t('browserBridge.copied') : t('browserBridge.copyPath') }}
              </button>
            </div>
            <p class="path-hint">{{ t('browserBridge.pasteHintWin') }}</p>
          </template>
        </div>

        <!-- Chrome -->
        <div class="browser-platform-card" :class="{ expanded: chromeExpanded }">
          <button type="button" class="browser-platform-header" @click="toggleOnly('chrome')">
            <span class="browser-platform-icon">🌐</span>
            <span class="browser-platform-name">{{ t('browserBridge.chromeTitle') }}</span>
            <span class="browser-platform-tag">{{ t('browserBridge.chromeStepsTag') }}</span>
            <span class="toggle-arrow" :class="{ open: chromeExpanded }">›</span>
          </button>
          <div v-if="chromeExpanded" class="browser-platform-body">
            <ol class="setup-steps">
              <li>{{ t('browserBridge.chromeStep1') }}</li>
              <li>{{ t('browserBridge.chromeStep2') }}</li>
              <li>{{ isMac ? t('browserBridge.chromeStep3Mac', { folder: chromiumFolderName }) : t('browserBridge.chromeStep3Win') }}</li>
            </ol>
          </div>
        </div>

        <!-- Edge -->
        <div class="browser-platform-card" :class="{ expanded: edgeExpanded }">
          <button type="button" class="browser-platform-header" @click="toggleOnly('edge')">
            <span class="browser-platform-icon">🔷</span>
            <span class="browser-platform-name">{{ t('browserBridge.edgeTitle') }}</span>
            <span class="browser-platform-tag">{{ t('browserBridge.edgeStepsTag') }}</span>
            <span class="toggle-arrow" :class="{ open: edgeExpanded }">›</span>
          </button>
          <div v-if="edgeExpanded" class="browser-platform-body">
            <ol class="setup-steps">
              <li>{{ t('browserBridge.edgeStep1') }}</li>
              <li>{{ isMac ? t('browserBridge.edgeStep2Mac', { folder: chromiumFolderName }) : t('browserBridge.edgeStep2Win') }}</li>
            </ol>
          </div>
        </div>

        <!-- Firefox -->
        <div class="browser-platform-card" :class="{ expanded: firefoxExpanded }">
          <button type="button" class="browser-platform-header" @click="toggleOnly('firefox')">
            <span class="browser-platform-icon">🦊</span>
            <span class="browser-platform-name">{{ t('browserBridge.firefoxTitle') }}</span>
            <span class="browser-platform-tag beta">{{ t('browserBridge.firefoxTempTag') }}</span>
            <span class="toggle-arrow" :class="{ open: firefoxExpanded }">›</span>
          </button>
          <div v-if="firefoxExpanded" class="browser-platform-body">
            <ol class="setup-steps">
              <li>{{ t('browserBridge.firefoxStep1') }}</li>
              <li>{{ t('browserBridge.firefoxStep2') }}</li>
              <li>{{ t('browserBridge.firefoxStep3') }}</li>
            </ol>
            <div v-if="firefoxPath" class="firefox-path-block">
              <code class="path-text path-text-sm">{{ firefoxPath }}/manifest.json</code>
              <button type="button" class="btn btn-sm btn-outline-primary" @click="startLoadFirefox">
                {{ t('browserBridge.startLoadFirefox') }}
              </button>
            </div>
          </div>
        </div>

        <p class="security-note">{{ t('browserBridge.oneBrowserNote') }}</p>

        <div v-if="!isConnected && componentsInstalled" class="troubleshoot-box">
          <p class="troubleshoot-title">{{ t('browserBridge.troubleshootTitle') }}</p>
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

        <p v-if="!isConnected" class="recheck-hint">
          {{ t('browserBridge.recheckHint') }}
          <button type="button" class="link-btn" :disabled="checking" @click="recheckConnection">
            {{ checking ? t('browserBridge.rechecking') : t('browserBridge.recheck') }}
          </button>
        </p>
      </template>
    </div>

    <!-- 步骤 3 / Agent 用法 -->
    <div v-if="isConnected || componentsInstalled" class="settings-section">
      <div class="section-header">
        <h4>{{ t('browserBridge.agentTitle') }}</h4>
      </div>
      <p class="section-desc">
        {{ isConnected ? t('browserBridge.agentDescReady') : t('browserBridge.agentDesc') }}
      </p>
      <div class="command-block">
        <code>browser_launch {{ '{ "attach": true }' }}</code>
      </div>
    </div>
  </div>
</template>

<style scoped>
.browser-bridge-settings {
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

.section-header h4,
.step-header h4 {
  font-size: 14px;
  font-weight: 600;
  margin: 0 0 4px;
}

.section-title-group {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.section-desc,
.step-desc {
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.5;
  margin: 0;
}

.section-desc {
  margin-bottom: 16px;
}

.status-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  font-weight: 500;
  padding: 2px 10px;
  border-radius: 12px;
  background: rgba(110, 118, 129, 0.12);
  color: var(--text-muted);
}

.status-badge.active {
  background: rgba(63, 185, 80, 0.12);
  color: var(--success-color, #3fb950);
}

.status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}

.status-badge.active .status-dot {
  box-shadow: 0 0 6px var(--success-color, #3fb950);
}

/* 两步进度条 */
.wizard-track {
  display: flex;
  align-items: center;
  gap: 0;
  margin-bottom: 10px;
}

.wizard-step {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--text-muted);
}

.wizard-step.active {
  color: var(--text-primary);
  font-weight: 500;
}

.wizard-step.done {
  color: var(--success-color, #3fb950);
}

.step-marker {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  font-size: 11px;
  font-weight: 600;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  flex-shrink: 0;
}

.wizard-step.active .step-marker {
  border-color: var(--accent-primary);
  color: var(--accent-primary);
}

.wizard-step.done .step-marker {
  background: rgba(63, 185, 80, 0.15);
  border-color: rgba(63, 185, 80, 0.4);
  color: var(--success-color, #3fb950);
}

.wizard-line {
  flex: 1;
  height: 2px;
  min-width: 24px;
  margin: 0 12px;
  background: var(--border-color);
  border-radius: 1px;
}

.wizard-line.done {
  background: rgba(63, 185, 80, 0.4);
}

.wizard-hint {
  font-size: 12px;
  color: var(--text-muted);
  margin: 0 0 4px;
  line-height: 1.5;
}

/* 步骤卡片 */
.step-section.done {
  border: 1px solid rgba(63, 185, 80, 0.2);
}

.step-section.disabled {
  opacity: 0.72;
}

.step-header {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  margin-bottom: 12px;
}

.step-header-text {
  flex: 1;
  min-width: 0;
}

.step-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 50%;
  font-size: 13px;
  font-weight: 700;
  background: var(--accent-primary);
  color: #fff;
  flex-shrink: 0;
  margin-top: 2px;
}

.step-badge.done {
  background: rgba(63, 185, 80, 0.2);
  color: var(--success-color, #3fb950);
}

.step-badge.muted {
  background: var(--bg-secondary);
  color: var(--text-muted);
  border: 1px solid var(--border-color);
}

.step-done-icon {
  color: var(--success-color, #3fb950);
  flex-shrink: 0;
  margin-left: auto;
}

.step1-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 14px;
  background: var(--bg-secondary);
  border-radius: 8px;
  border: 1px solid var(--border-color);
}

.step1-status {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin: 0;
  font-size: 13px;
  line-height: 1.45;
  color: var(--success-color, #3fb950);
  flex: 1;
  min-width: 0;
}

.step1-status-icon {
  flex-shrink: 0;
  margin-top: 1px;
}

.step1-actions {
  display: flex;
  flex-shrink: 0;
  gap: 8px;
}

@media (max-width: 520px) {
  .step1-footer {
    flex-direction: column;
    align-items: stretch;
  }

  .step1-actions {
    justify-content: flex-end;
  }
}

.btn-danger-outline {
  color: var(--danger-color, var(--color-error));
  border-color: rgba(var(--color-error-rgb), 0.35);
}

.btn-danger-outline:hover:not(:disabled) {
  background: rgba(var(--color-error-rgb), 0.08);
}

.install-cta {
  width: 100%;
  padding: 10px 16px;
  font-size: 14px;
  font-weight: 600;
  margin-top: 4px;
}

.flash-msg {
  font-size: 13px;
  color: var(--text-muted);
  margin: 12px 0 0;
}

.extension-path-panel {
  margin-bottom: 16px;
  padding: 14px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
}

.path-panel-title {
  margin: 0 0 10px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-primary);
}

.path-row {
  display: flex;
  align-items: stretch;
  gap: 8px;
}

.path-text {
  flex: 1;
  min-width: 0;
  display: block;
  padding: 8px 10px;
  font-family: 'SF Mono', Monaco, Consolas, monospace;
  font-size: 11px;
  line-height: 1.45;
  color: var(--accent-primary);
  background: var(--bg-tertiary);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  word-break: break-all;
  user-select: all;
}

.path-text-sm {
  font-size: 10px;
  margin-bottom: 10px;
}

.path-copy-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex-shrink: 0;
  white-space: nowrap;
}

.path-hint {
  margin: 10px 0 14px;
  font-size: 12px;
  line-height: 1.55;
  color: var(--text-muted);
}

.load-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}

.load-cta {
  flex: 1;
  min-width: 200px;
  padding: 9px 16px;
  font-weight: 600;
}

.load-ready-msg {
  margin: 12px 0 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--success-color, #3fb950);
}

.drag-method-box {
  margin-top: 14px;
  padding: 12px 14px;
  background: rgba(63, 185, 80, 0.06);
  border: 1px solid rgba(63, 185, 80, 0.25);
  border-radius: 8px;
}

.method-badge {
  display: inline-block;
  font-size: 10px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 10px;
  background: rgba(63, 185, 80, 0.15);
  color: var(--success-color, #3fb950);
  margin-bottom: 8px;
}

.drag-method-title {
  margin: 0 0 10px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}

.drag-steps,
.paste-steps {
  margin: 0;
  padding-left: 18px;
  font-size: 12px;
  line-height: 1.65;
  color: var(--text-secondary);
}

.drag-steps li + li,
.paste-steps li + li {
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

.paste-method-fallback {
  margin-top: 12px;
  font-size: 12px;
  color: var(--text-muted);
}

.paste-method-fallback summary {
  cursor: pointer;
  color: var(--text-secondary);
  user-select: none;
}

.paste-method-fallback summary:hover {
  color: var(--text-primary);
}

.paste-method-note {
  margin: 10px 0 8px;
  line-height: 1.55;
  color: var(--text-muted);
}

.paste-method-fallback .path-row {
  margin-top: 10px;
}

.firefox-path-block {
  margin-top: 4px;
  padding-top: 12px;
  border-top: 1px dashed var(--border-color);
}

.step-locked {
  font-size: 12px;
  color: var(--text-muted);
  padding: 12px;
  background: var(--bg-secondary);
  border-radius: 6px;
  border: 1px dashed var(--border-color);
  text-align: center;
}

.error-msg {
  color: var(--danger-color, var(--color-error));
  font-size: 12px;
  margin-top: 12px;
  padding: 8px 12px;
  background: rgba(var(--color-error-rgb), 0.08);
  border-radius: 6px;
  border-left: 3px solid var(--danger-color, var(--color-error));
  white-space: pre-wrap;
}

.success-msg {
  color: var(--success-color, #3fb950);
  font-size: 12px;
  margin-bottom: 14px;
  padding: 8px 12px;
  background: rgba(63, 185, 80, 0.08);
  border-radius: 6px;
  border-left: 3px solid rgba(63, 185, 80, 0.45);
}

.recheck-hint {
  font-size: 12px;
  color: var(--text-muted);
  margin: 14px 0 0;
}

.link-btn {
  background: none;
  border: none;
  padding: 0;
  color: var(--accent-primary);
  cursor: pointer;
  font-size: inherit;
  text-decoration: underline;
}

.link-btn:disabled {
  opacity: 0.6;
  cursor: wait;
}

.browser-platform-card {
  margin-bottom: 8px;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  overflow: hidden;
}

.browser-platform-card.expanded {
  border-color: var(--accent-primary);
}

.browser-platform-header {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 12px 14px;
  background: var(--bg-secondary);
  border: none;
  color: var(--text-primary);
  font-size: 13px;
  cursor: pointer;
  text-align: left;
}

.browser-platform-header:hover {
  background: var(--bg-surface, var(--bg-primary));
}

.browser-platform-icon {
  font-size: 16px;
}

.browser-platform-name {
  font-weight: 600;
}

.browser-platform-tag {
  margin-left: auto;
  font-size: 10px;
  color: var(--text-muted);
  padding: 2px 8px;
  border-radius: 10px;
  background: rgba(110, 118, 129, 0.1);
}

.browser-platform-tag.beta {
  color: var(--color-warning);
  background: rgba(var(--color-warning-rgb), 0.1);
}

.toggle-arrow {
  font-size: 18px;
  color: var(--text-muted);
  transition: transform 0.2s;
}

.toggle-arrow.open {
  transform: rotate(90deg);
}

.browser-platform-body {
  padding: 14px;
  border-top: 1px solid var(--border-color);
  background: var(--bg-secondary);
}

.setup-steps {
  margin: 0 0 14px;
  padding-left: 18px;
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.65;
}

.setup-steps li + li {
  margin-top: 6px;
}

.card-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.btn-outline-primary {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: transparent;
  border: 1px solid var(--accent-primary);
  color: var(--accent-primary);
}

.security-note {
  font-size: 12px;
  color: var(--color-warning);
  line-height: 1.5;
  padding: 8px 12px;
  margin-top: 12px;
  margin-bottom: 0;
  background: rgba(var(--color-warning-rgb), 0.06);
  border-radius: 6px;
  border-left: 3px solid rgba(var(--color-warning-rgb), 0.4);
}

.troubleshoot-box {
  margin-top: 12px;
  padding: 12px 14px;
  background: rgba(var(--color-warning-rgb), 0.06);
  border: 1px solid rgba(var(--color-warning-rgb), 0.25);
  border-radius: 8px;
}

.troubleshoot-title {
  margin: 0 0 8px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-primary);
}

.troubleshoot-steps {
  margin: 0;
  padding-left: 18px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-secondary);
}

.troubleshoot-steps li + li {
  margin-top: 6px;
}

.command-block {
  padding: 12px 14px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
}

.command-block code {
  font-family: 'SF Mono', Monaco, Consolas, monospace;
  font-size: 13px;
  color: var(--accent-primary);
  user-select: all;
}
</style>
