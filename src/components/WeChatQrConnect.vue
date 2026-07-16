<script setup lang="ts">
/**
 * 微信扫码连接（内嵌二维码）
 *
 * 复用 im.wechatLogin：后端返回可编码链接，前端用 qrcode 库画成图。
 * 展示期间服务端/本地过期会自动换码（im:wechatLoginStatus phase=refreshing/qr）。
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import QRCode from 'qrcode'
import type { WeChatLoginStatus } from '@shared/types'

const props = withDefaults(defineProps<{
  /** 挂载后若未连接且无 token，自动拉码（还须 active=true） */
  autoStart?: boolean
  /**
   * 是否处于可见/焦点态。联络 tab 用 v-show 保活时，切走应为 false：
   * 不拉码、不过期换码；再次激活才继续。设置页保持默认 true。
   */
  active?: boolean
  /** 已有 token 且空闲时不展示（联络空态用，避免挤占已配置用户） */
  hideWhenHasToken?: boolean
  /** compact：联络空态；settings：设置页 */
  variant?: 'compact' | 'settings'
}>(), {
  autoStart: false,
  active: true,
  hideWhenHasToken: false,
  variant: 'compact',
})

const emit = defineEmits<{
  connected: []
  dismissed: []
}>()

const { t } = useI18n()

const connected = ref(false)
const hasToken = ref(false)
const loading = ref(false)
const phase = ref<'idle' | 'qr' | 'scanned' | 'refreshing' | 'error'>('idle')
const qrcodeUrl = ref('')
const qrDataUrl = ref('')
const errorMsg = ref('')

let unsubStatus: (() => void) | null = null
let unsubConn: (() => void) | null = null
let disposed = false

const showPanel = computed(() => {
  if (connected.value) return false
  if (
    props.hideWhenHasToken &&
    hasToken.value &&
    phase.value === 'idle' &&
    !loading.value
  ) {
    return false
  }
  return true
})
const showQr = computed(() => !!qrDataUrl.value && (phase.value === 'qr' || phase.value === 'scanned' || phase.value === 'refreshing'))
const statusHint = computed(() => {
  if (phase.value === 'scanned') return t('ai.wechatQr.scanned')
  if (phase.value === 'refreshing') return t('ai.wechatQr.refreshing')
  if (phase.value === 'qr') return t('ai.wechatQr.scanHint')
  if (phase.value === 'error') return errorMsg.value || t('ai.wechatQr.failed')
  return ''
})

async function refreshState() {
  try {
    const [status, config] = await Promise.all([
      window.electronAPI.im.getStatus(),
      window.electronAPI.im.getConfig(),
    ])
    connected.value = status.wechat?.connected ?? false
    hasToken.value = config.wechat?.hasToken ?? false
  } catch {
    /* ignore */
  }
}

async function renderQr(content: string) {
  try {
    qrDataUrl.value = await QRCode.toDataURL(content, {
      width: props.variant === 'compact' ? 180 : 200,
      margin: 2,
      errorCorrectionLevel: 'M',
      color: { dark: '#111111', light: '#ffffff' },
    })
  } catch (err: any) {
    errorMsg.value = err?.message || t('ai.wechatQr.renderFailed')
    phase.value = 'error'
    qrDataUrl.value = ''
  }
}

function isLoginInFlight(): boolean {
  return loading.value
    || phase.value === 'qr'
    || phase.value === 'scanned'
    || phase.value === 'refreshing'
}

async function startLogin() {
  if (!props.active || loading.value || connected.value) return
  loading.value = true
  errorMsg.value = ''
  phase.value = 'idle'
  qrcodeUrl.value = ''
  qrDataUrl.value = ''
  try {
    const result = await window.electronAPI.im.wechatLogin()
    if (disposed) return
    // 拉码过程中若已切走，丢弃结果并取消后台轮询
    if (!props.active) {
      await cancelLogin()
      phase.value = 'idle'
      return
    }
    if (!result.success) {
      errorMsg.value = result.error || t('ai.wechatQr.failed')
      phase.value = 'error'
      return
    }
    // 状态事件可能已先到；若还没有，用返回值兜底
    if (result.qrcodeUrl && !qrcodeUrl.value) {
      qrcodeUrl.value = result.qrcodeUrl
      phase.value = 'qr'
      await renderQr(result.qrcodeUrl)
    }
  } catch (e: any) {
    if (disposed) return
    errorMsg.value = e?.message || t('ai.wechatQr.failed')
    phase.value = 'error'
  } finally {
    if (!disposed) loading.value = false
  }
}

async function cancelLogin() {
  try {
    await window.electronAPI.im.cancelWeChatLogin()
  } catch {
    /* ignore */
  }
}

/** 切走可见态：停刷码并清空二维码图（保留 hasToken 等状态） */
async function pauseForInactive() {
  if (!isLoginInFlight() && phase.value !== 'error') return
  await cancelLogin()
  loading.value = false
  phase.value = 'idle'
  qrcodeUrl.value = ''
  qrDataUrl.value = ''
  errorMsg.value = ''
}

function maybeAutoStart() {
  if (
    props.active &&
    props.autoStart &&
    !connected.value &&
    !hasToken.value &&
    phase.value === 'idle' &&
    !loading.value
  ) {
    void startLogin()
  }
}

function handleStatus(status: WeChatLoginStatus) {
  if (disposed || !props.active) return
  switch (status.phase) {
    case 'qr':
      qrcodeUrl.value = status.qrcodeUrl
      phase.value = 'qr'
      void renderQr(status.qrcodeUrl)
      break
    case 'scanned':
      phase.value = 'scanned'
      break
    case 'refreshing':
      phase.value = 'refreshing'
      break
    case 'confirmed':
      phase.value = 'qr'
      break
    case 'error':
      phase.value = 'error'
      errorMsg.value = status.error
      break
  }
}

onMounted(async () => {
  unsubStatus = window.electronAPI.im.onWeChatLoginStatus(handleStatus)
  unsubConn = window.electronAPI.im.onConnectionChange((data) => {
    if (data.platform !== 'wechat') return
    connected.value = data.connected
    if (data.connected) {
      hasToken.value = true
      phase.value = 'idle'
      qrDataUrl.value = ''
      emit('connected')
    }
  })

  await refreshState()
  if (disposed) return
  maybeAutoStart()
})

onUnmounted(() => {
  disposed = true
  unsubStatus?.()
  unsubConn?.()
  // 未连上时取消后台刷码
  if (!connected.value && isLoginInFlight()) {
    void cancelLogin()
  }
})

watch(() => props.autoStart, () => {
  maybeAutoStart()
})

// 联络 tab v-show 保活：切走停刷，切回再拉
watch(() => props.active, (active, wasActive) => {
  if (active === wasActive) return
  if (!active) {
    void pauseForInactive()
    return
  }
  maybeAutoStart()
})

defineExpose({
  startLogin,
  cancelLogin,
  refreshState,
})
</script>

<template>
  <div v-if="showPanel" class="wechat-qr-connect" :class="[`variant-${variant}`]">
    <div class="wechat-qr-header">
      <span class="wechat-qr-title">{{ t('ai.wechatQr.title') }}</span>
      <span class="wechat-qr-subtitle">{{ t('ai.wechatQr.subtitle') }}</span>
    </div>

    <div v-if="showQr" class="wechat-qr-frame" :class="{ refreshing: phase === 'refreshing', scanned: phase === 'scanned' }">
      <img :src="qrDataUrl" alt="WeChat QR" class="wechat-qr-img" draggable="false" />
      <div v-if="phase === 'refreshing'" class="wechat-qr-overlay">
        {{ t('ai.wechatQr.refreshing') }}
      </div>
    </div>

    <div v-else-if="loading" class="wechat-qr-placeholder">
      {{ t('ai.wechatQr.loading') }}
    </div>

    <p v-if="statusHint" class="wechat-qr-hint" :class="{ error: phase === 'error' }">
      {{ statusHint }}
    </p>

    <div class="wechat-qr-actions">
      <button
        v-if="phase === 'idle' || phase === 'error'"
        type="button"
        class="btn btn-sm btn-primary"
        :disabled="loading"
        @click="startLogin"
      >
        {{ loading ? t('ai.wechatQr.loading') : t('ai.wechatQr.start') }}
      </button>
      <button
        v-else-if="showQr"
        type="button"
        class="btn btn-sm btn-outline-secondary"
        :disabled="loading || phase === 'refreshing'"
        @click="startLogin"
      >
        {{ t('ai.wechatQr.refresh') }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.wechat-qr-connect {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  width: 100%;
}

.wechat-qr-header {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  text-align: center;
}

.wechat-qr-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}

.wechat-qr-subtitle {
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.45;
  max-width: 28em;
}

.wechat-qr-frame {
  position: relative;
  padding: 10px;
  background: #fff;
  border-radius: 12px;
  border: 1px solid color-mix(in srgb, var(--border-color, #ccc) 70%, transparent);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
}

.wechat-qr-frame.scanned {
  outline: 2px solid color-mix(in srgb, var(--accent-primary) 45%, transparent);
}

.wechat-qr-img {
  display: block;
  width: 180px;
  height: 180px;
  image-rendering: pixelated;
}

.variant-settings .wechat-qr-img {
  width: 200px;
  height: 200px;
}

.wechat-qr-overlay {
  position: absolute;
  inset: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(255, 255, 255, 0.82);
  color: var(--text-primary, #222);
  font-size: 12px;
  font-weight: 600;
  border-radius: 6px;
}

.wechat-qr-placeholder {
  min-height: 120px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-muted);
  font-size: 12px;
}

.wechat-qr-hint {
  margin: 0;
  font-size: 12px;
  color: var(--text-muted);
  text-align: center;
  line-height: 1.45;
}

.wechat-qr-hint.error {
  color: var(--color-error, #c0392b);
}

.wechat-qr-actions {
  display: flex;
  gap: 8px;
  justify-content: center;
}

.variant-compact {
  margin-top: 18px;
  padding-top: 16px;
  border-top: 1px solid color-mix(in srgb, var(--border-color, #ccc) 55%, transparent);
}
</style>
