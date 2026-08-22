<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { Radio } from 'lucide-vue-next'
import {
  isBrowserBridgeComponentsInstalled,
  isChromiumBridgeConnection,
  isFirefoxBridgeConnection,
  type BrowserBridgeStatus,
} from '@shared/types/browser-bridge'
import HoverTipOverlay from './HoverTipOverlay.vue'
import { BUTTON_HOVER_TIP_DELAY_MS, useHoverTip } from '../composables/useHoverTip'

const { t } = useI18n()
const { hoverTip, showTip, hideTip } = useHoverTip({
  placement: 'bottom',
  delayMs: BUTTON_HOVER_TIP_DELAY_MS,
  wrap: true,
})

// ==================== 类型 ====================

interface McpServerConfig {
  id: string
  name: string
  enabled: boolean
  transport: 'stdio' | 'sse' | 'http'
  command?: string
  url?: string
}

interface McpServerStatus {
  id: string
  name: string
  connected: boolean
  error?: string
  toolCount: number
  resourceCount: number
  promptCount: number
}

type IMPlatform = 'dingtalk' | 'feishu' | 'slack' | 'telegram' | 'wecom' | 'wechat'

interface IMChannelState {
  platform: IMPlatform
  label: string
  enabled: boolean
  connected: boolean
  hasCredentials: boolean
  autoConnect: boolean
  /** 该渠道是否已有可回投的会话（微信连上但还没聊过时为 false） */
  hasContact: boolean
}

// ==================== Props / Emits ====================

const props = withDefaults(defineProps<{
  /** sidebar：秘书行右部的装备位，触发器是紧凑胶囊，面板贴着侧栏向上弹 */
  variant?: 'header' | 'sidebar'
}>(), { variant: 'header' })

const emit = defineEmits<{
  openSettings: [tab?: string]
}>()

// ==================== 状态 ====================

const showPopover = ref(false)
const popoverRef = ref<HTMLElement | null>(null)
const buttonRef = ref<HTMLElement | null>(null)
/** sidebar 形态下动态算出的面板位置；header 形态留空走 CSS 里的固定位置 */
const popoverStyle = ref<Record<string, string>>({})

// IM
const imChannels = ref<IMChannelState[]>([])
const imConnecting = ref<string | null>(null)

// Gateway
const gatewayRunning = ref(false)
const gatewayPort = ref(0)

// MCP
const mcpServers = ref<McpServerConfig[]>([])
const mcpStatuses = ref<McpServerStatus[]>([])
const mcpConnecting = ref<string | null>(null)

// Browser Bridge
const browserBridgeInstalled = ref(false)
const browserBridgeChromiumConnected = ref(false)
const browserBridgeFirefoxConnected = ref(false)

// ==================== 计算属性 ====================

const imConnectedCount = computed(() => imChannels.value.filter(c => c.connected).length)
// "活跃"渠道：已连接 或 配置了自动连接的
const imActiveCount = computed(() => imChannels.value.filter(c => c.connected || c.autoConnect).length)

const getMcpStatus = (serverId: string): McpServerStatus | undefined => {
  return mcpStatuses.value.find(s => s.id === serverId)
}

const mcpEnabledServers = computed(() => mcpServers.value.filter(s => s.enabled))
const mcpConnectedCount = computed(() => mcpStatuses.value.filter(s => s.connected).length)
const mcpEnabledCount = computed(() => mcpEnabledServers.value.length)

const isMcpFailed = (server: McpServerConfig): boolean => {
  if (!server.enabled) return false
  const st = getMcpStatus(server.id)
  return !!st && !st.connected && !!st.error
}

const isMcpPending = (server: McpServerConfig): boolean =>
  server.enabled && !getMcpStatus(server.id)?.connected && !isMcpFailed(server)

const mcpFailedCount = computed(() => mcpEnabledServers.value.filter(isMcpFailed).length)
const mcpPendingCount = computed(() => mcpEnabledServers.value.filter(isMcpPending).length)

const isWechatWaitingSession = (ch: IMChannelState) =>
  ch.platform === 'wechat' && ch.connected && !ch.hasContact

const wechatWaitingSession = computed(() =>
  imChannels.value.some(isWechatWaitingSession)
)

const showGateway = computed(() => gatewayRunning.value)

// 顶栏角标只统计 IM / Gateway / MCP；浏览器助手为可选能力，未连接不算「待办」
// 正在连接的 MCP 不计入已连接，也不当成故障——单独用 connecting 态
const totalConnected = computed(() =>
  imConnectedCount.value + (showGateway.value ? 1 : 0) + mcpConnectedCount.value,
)
const totalEnabled = computed(() =>
  imActiveCount.value + (showGateway.value ? 1 : 0) + mcpEnabledCount.value,
)

const mcpConnectingQuiet = computed(() =>
  mcpPendingCount.value > 0 && mcpFailedCount.value === 0
  && imConnectedCount.value === imActiveCount.value
)

const statusType = computed(() => {
  if (totalEnabled.value === 0) return 'none'
  if (mcpConnectingQuiet.value) return 'connecting'
  if (totalConnected.value === 0) return 'offline'
  if (wechatWaitingSession.value) return 'partial'
  if (totalConnected.value >= totalEnabled.value) return 'all'
  return 'partial'
})

const statusClass = computed(() => {
  switch (statusType.value) {
    case 'all': return 'status-all'
    case 'connecting': return 'status-connecting'
    case 'partial': return 'status-partial'
    case 'offline': return 'status-offline'
    default: return 'status-none'
  }
})

const statusIcon = computed(() => {
  switch (statusType.value) {
    case 'all': return '●'
    case 'partial':
      return wechatWaitingSession.value && totalConnected.value >= totalEnabled.value
        ? '●'
        : '◐'
    case 'connecting': return '◐'
    default: return '○'
  }
})

const statusTooltip = computed(() => {
  if (mcpConnectingQuiet.value) {
    return t('mcp.healthConnecting', {
      connected: mcpConnectedCount.value,
      total: mcpEnabledCount.value,
    })
  }
  return `${totalConnected.value}/${totalEnabled.value} ${t('conn.connected')}`
})

const mcpHeaderText = computed(() => {
  if (mcpFailedCount.value > 0) return t('mcp.healthFailed', { count: mcpFailedCount.value })
  if (mcpPendingCount.value > 0) {
    return t('mcp.healthConnecting', {
      connected: mcpConnectedCount.value,
      total: mcpEnabledCount.value,
    })
  }
  if (mcpEnabledCount.value > 0) return t('mcp.healthOk', { count: mcpEnabledCount.value })
  return ''
})

const mcpHeaderClass = computed(() => {
  if (mcpFailedCount.value > 0) return 'count-bad'
  if (mcpPendingCount.value > 0) return 'count-connecting'
  if (mcpEnabledCount.value > 0) return 'count-ok'
  return ''
})

// ==================== 数据加载 ====================

const platformLabels: Record<IMPlatform, () => string> = {
  dingtalk: () => t('settings.im.dingtalk'),
  feishu: () => t('settings.im.feishu'),
  slack: () => t('settings.im.slack'),
  telegram: () => t('settings.im.telegram'),
  wecom: () => t('settings.im.wecom'),
  wechat: () => t('settings.im.wechat'),
}

const loadIMData = async () => {
  const [status, config, sendTargets] = await Promise.all([
    window.electronAPI.im.getStatus(),
    window.electronAPI.im.getConfig(),
    window.electronAPI.im.getChannelSendTargets(),
  ])

  const credCheck: Record<IMPlatform, boolean> = {
    dingtalk: !!(config.dingtalk.clientId && config.dingtalk.clientSecret),
    feishu: !!(config.feishu.appId && config.feishu.appSecret),
    slack: !!(config.slack.botToken && config.slack.appToken),
    telegram: !!config.telegram.botToken,
    wecom: !!(config.wecom.botId && config.wecom.secret),
    wechat: config.wechat?.hasToken ?? false,
  }

  const autoConnectCheck: Record<IMPlatform, boolean> = {
    dingtalk: config.dingtalk.autoConnect,
    feishu: config.feishu.autoConnect,
    slack: config.slack.autoConnect,
    telegram: config.telegram.autoConnect,
    wecom: config.wecom.autoConnect,
    wechat: config.wechat?.autoConnect !== false,
  }

  const hasContactByPlatform = new Map(
    sendTargets.map(t => [t.platform, t.hasContact])
  )

  const platforms: IMPlatform[] = ['dingtalk', 'feishu', 'slack', 'telegram', 'wecom', 'wechat']
  imChannels.value = platforms
    .map(p => ({
      platform: p,
      label: platformLabels[p](),
      enabled: status[p].enabled,
      connected: status[p].connected,
      hasCredentials: credCheck[p],
      autoConnect: autoConnectCheck[p],
      hasContact: hasContactByPlatform.get(p) ?? false,
    }))
    .filter(c => c.hasCredentials)
}

const loadGatewayData = async () => {
  const [running, config] = await Promise.all([
    window.electronAPI.gateway.isRunning(),
    window.electronAPI.gateway.getConfig(),
  ])
  gatewayRunning.value = running
  gatewayPort.value = config.port
}

const loadMcpData = async () => {
  mcpServers.value = await window.electronAPI.mcp.getServers()
  mcpStatuses.value = await window.electronAPI.mcp.getServerStatuses()
}

const applyBrowserBridgeStatus = (bridgeStatus: BrowserBridgeStatus) => {
  browserBridgeInstalled.value = isBrowserBridgeComponentsInstalled(bridgeStatus.install)
  const connections = bridgeStatus.connections ?? []
  browserBridgeChromiumConnected.value = connections.some(isChromiumBridgeConnection)
  browserBridgeFirefoxConnected.value = connections.some(isFirefoxBridgeConnection)
}

const loadBrowserBridgeData = async () => {
  applyBrowserBridgeStatus(await window.electronAPI.browserBridge.getStatus())
}

const loadAll = async () => {
  await Promise.all([loadIMData(), loadGatewayData(), loadMcpData(), loadBrowserBridgeData()])
}

// ==================== IM 操作 ====================

const connectIM = async (channel: IMChannelState) => {
  imConnecting.value = channel.platform
  try {
    const config = await window.electronAPI.im.getConfig()
    let result: { success: boolean; error?: string }
    switch (channel.platform) {
      case 'dingtalk':
        result = await window.electronAPI.im.startDingTalk({ enabled: true, clientId: config.dingtalk.clientId, clientSecret: config.dingtalk.clientSecret })
        break
      case 'feishu':
        result = await window.electronAPI.im.startFeishu({ enabled: true, appId: config.feishu.appId, appSecret: config.feishu.appSecret })
        break
      case 'slack':
        result = await window.electronAPI.im.startSlack({ enabled: true, botToken: config.slack.botToken, appToken: config.slack.appToken })
        break
      case 'telegram':
        result = await window.electronAPI.im.startTelegram({ enabled: true, botToken: config.telegram.botToken })
        break
      case 'wecom':
        result = await window.electronAPI.im.startWeCom({
          enabled: true, botId: config.wecom.botId, secret: config.wecom.secret,
        })
        break
      case 'wechat':
        result = await window.electronAPI.im.startWeChat()
        break
      default:
        result = { success: false, error: 'Unknown platform' }
    }
    if (!result.success) console.error(`[IM] Connect ${channel.platform} failed:`, result.error)
  } catch (e) {
    console.error(`[IM] Connect ${channel.platform} error:`, e)
  } finally {
    imConnecting.value = null
    await loadIMData()
  }
}

const disconnectIM = async (channel: IMChannelState) => {
  switch (channel.platform) {
    case 'dingtalk': await window.electronAPI.im.stopDingTalk(); break
    case 'feishu': await window.electronAPI.im.stopFeishu(); break
    case 'slack': await window.electronAPI.im.stopSlack(); break
    case 'telegram': await window.electronAPI.im.stopTelegram(); break
    case 'wecom': await window.electronAPI.im.stopWeCom(); break
    case 'wechat': await window.electronAPI.im.stopWeChat(); break
  }
  await loadIMData()
}

// ==================== Gateway 操作 ====================

const toggleGateway = async () => {
  if (gatewayRunning.value) {
    await window.electronAPI.gateway.stop()
  } else {
    const config = await window.electronAPI.gateway.getConfig()
    await window.electronAPI.gateway.start(config)
  }
  await loadGatewayData()
}

// ==================== MCP 操作 ====================

const retryMcp = async (server: McpServerConfig) => {
  mcpConnecting.value = server.id
  try {
    await window.electronAPI.mcp.connect(JSON.parse(JSON.stringify(server)))
  } catch (e) {
    console.error('MCP retry error:', e)
  } finally {
    mcpConnecting.value = null
    await loadMcpData()
  }
}

// ==================== 弹窗控制 ====================

let gatewayPollTimer: ReturnType<typeof setInterval> | null = null
let waitPollTimer: ReturnType<typeof setInterval> | null = null

const POPOVER_WIDTH = 520
const VIEWPORT_MARGIN = 8

/**
 * sidebar 形态下面板贴着触发器向上弹：底边与触发器齐平、左边落在侧栏右侧。
 * 窗口窄到放不下时向内收，避免面板被切掉。
 */
const updateSidebarPosition = () => {
  const rect = buttonRef.value?.getBoundingClientRect()
  if (!rect) return
  const left = Math.max(
    VIEWPORT_MARGIN,
    Math.min(rect.right + VIEWPORT_MARGIN, window.innerWidth - POPOVER_WIDTH - VIEWPORT_MARGIN)
  )
  popoverStyle.value = {
    left: `${left}px`,
    bottom: `${Math.max(VIEWPORT_MARGIN, window.innerHeight - rect.bottom)}px`,
    // 面板从底部往上长，窗口矮时封顶让它自己滚，别把顶部溢出到视口外
    maxHeight: `${Math.max(240, rect.bottom - VIEWPORT_MARGIN * 2)}px`,
    top: 'auto',
    right: 'auto',
  }
}

const togglePopover = async () => {
  showPopover.value = !showPopover.value
  if (showPopover.value) {
    if (props.variant === 'sidebar') {
      updateSidebarPosition()
      window.addEventListener('resize', updateSidebarPosition)
    }
    await loadAll()
    gatewayPollTimer = setInterval(loadGatewayData, 5000)
  } else {
    hideTip()
    window.removeEventListener('resize', updateSidebarPosition)
    if (gatewayPollTimer) { clearInterval(gatewayPollTimer); gatewayPollTimer = null }
  }
}

const closePopover = () => {
  hideTip()
  showPopover.value = false
  window.removeEventListener('resize', updateSidebarPosition)
  if (gatewayPollTimer) { clearInterval(gatewayPollTimer); gatewayPollTimer = null }
}

/** 捕获阶段听按下：秘书菜单等处的 stop 拦不住，进设置也能收起来 */
const handlePointerDownOutside = (e: PointerEvent) => {
  if (!showPopover.value) return
  const target = e.target
  if (!(target instanceof Node)) {
    closePopover()
    return
  }
  if (popoverRef.value?.contains(target) || buttonRef.value?.contains(target)) return
  closePopover()
}

const handleKeydown = (e: KeyboardEvent) => {
  if (e.key === 'Escape' && showPopover.value) {
    e.stopImmediatePropagation()
    closePopover()
  }
}

const openSettings = (tab?: string) => {
  closePopover()
  emit('openSettings', tab)
}

// ==================== 生命周期 ====================

let unsubImChange: (() => void) | null = null
let unsubMcpConnected: (() => void) | null = null
let unsubMcpDisconnected: (() => void) | null = null
let unsubMcpError: (() => void) | null = null
let unsubBrowserBridge: (() => void) | null = null

onMounted(async () => {
  await loadAll()

  unsubImChange = window.electronAPI.im.onConnectionChange(async () => {
    await loadIMData()
  })
  unsubMcpConnected = window.electronAPI.mcp.onConnected(async () => { await loadMcpData() })
  unsubMcpDisconnected = window.electronAPI.mcp.onDisconnected(async () => { await loadMcpData() })
  unsubMcpError = window.electronAPI.mcp.onError(async () => { await loadMcpData() })
  unsubBrowserBridge = window.electronAPI.browserBridge.onConnectionsChanged((next) => {
    applyBrowserBridgeStatus(next)
  })

  document.addEventListener('pointerdown', handlePointerDownOutside, true)
  document.addEventListener('keydown', handleKeydown)

  waitPollTimer = setInterval(() => {
    if (wechatWaitingSession.value) void loadIMData()
  }, 5000)
})

onUnmounted(() => {
  unsubImChange?.()
  unsubMcpConnected?.()
  unsubMcpDisconnected?.()
  unsubMcpError?.()
  unsubBrowserBridge?.()
  if (gatewayPollTimer) clearInterval(gatewayPollTimer)
  if (waitPollTimer) clearInterval(waitPollTimer)
  document.removeEventListener('pointerdown', handlePointerDownOutside, true)
  document.removeEventListener('keydown', handleKeydown)
  window.removeEventListener('resize', updateSidebarPosition)
})
</script>

<template>
  <div class="conn-wrapper">
    <!-- 触发器：顶栏图标按钮 / 秘书行右部的紧凑胶囊 -->
    <button
      ref="buttonRef"
      class="btn-icon conn-btn"
      :class="[statusClass, { 'conn-btn--sidebar': props.variant === 'sidebar' }]"
      :title="statusTooltip"
      @click="togglePopover"
    >
      <span class="equip-icon">
        <Radio :size="props.variant === 'sidebar' ? 13 : 18" />
      </span>
      <span class="status-badge" :class="statusClass">
        <span v-if="statusType === 'connecting'" class="spinner"></span>
        <span v-else class="status-dot">{{ statusIcon }}</span>
        <span class="status-count">{{ totalConnected }}/{{ totalEnabled }}</span>
      </span>
    </button>

    <!-- 弹出面板 -->
    <Teleport to="body">
      <div
        v-if="showPopover"
        ref="popoverRef"
        class="conn-popover"
        :class="{ 'conn-popover--sidebar': props.variant === 'sidebar' }"
        :style="props.variant === 'sidebar' ? popoverStyle : undefined"
      >
        <!-- 双栏内容 -->
        <div class="conn-columns">
          <!-- 左栏：远程渠道 -->
          <div class="conn-col">
            <div class="col-header">
              <span class="col-title">📡 {{ t('conn.channels') }}</span>
              <span class="col-count" :class="imConnectedCount > 0 ? 'count-ok' : ''">{{ imConnectedCount }}/{{ imActiveCount }}</span>
            </div>
            <div class="col-body">
              <!-- IM 渠道列表 -->
              <div v-if="imChannels.length === 0" class="empty-hint">
                <span>{{ t('conn.noChannels') }}</span>
                <button class="btn-link" @click="openSettings('im')">{{ t('conn.goSetup') }}</button>
              </div>
              <div
                v-for="ch in imChannels" :key="ch.platform"
                class="item"
                :class="{ connected: ch.connected, waiting: isWechatWaitingSession(ch) }"
                @mouseenter="isWechatWaitingSession(ch) && showTip($event, t('conn.wechatNeedMessageTip'))"
                @mouseleave="hideTip"
              >
                <span
                  class="item-dot"
                  :class="{
                    'dot-on': ch.connected && !isWechatWaitingSession(ch),
                    'dot-wait': isWechatWaitingSession(ch),
                    'dot-off': !ch.connected
                  }"
                >{{ ch.connected ? '●' : '○' }}</span>
                <span class="item-name">{{ ch.label }}</span>
                <div class="item-actions">
                  <button v-if="!ch.connected" class="btn-sm btn-connect" :disabled="imConnecting === ch.platform" @click="connectIM(ch)">
                    <span v-if="imConnecting === ch.platform" class="spinner"></span>
                    <span v-else>{{ t('conn.connect') }}</span>
                  </button>
                  <button v-else class="btn-sm btn-disconnect" @click="disconnectIM(ch)">{{ t('conn.disconnect') }}</button>
                </div>
              </div>

              <!-- Browser Bridge -->
              <div v-if="imChannels.length > 0 || browserBridgeInstalled" class="section-divider"></div>
              <div v-if="!browserBridgeInstalled" class="item">
                <span class="item-dot dot-off">○</span>
                <span class="item-name">{{ t('conn.browserBridge') }}</span>
                <div class="item-actions">
                  <button class="btn-sm btn-connect" @click="openSettings('browserBridge')">{{ t('conn.connect') }}</button>
                </div>
              </div>
              <template v-else>
                <div class="item" :class="{ connected: browserBridgeChromiumConnected }">
                  <span class="item-dot" :class="browserBridgeChromiumConnected ? 'dot-on' : 'dot-off'">
                    {{ browserBridgeChromiumConnected ? '●' : '○' }}
                  </span>
                  <span class="item-name">{{ t('conn.browserBridgeChromium') }}</span>
                  <div v-if="!browserBridgeChromiumConnected" class="item-actions">
                    <button class="btn-sm btn-connect" @click="openSettings('browserBridge')">{{ t('conn.connect') }}</button>
                  </div>
                </div>
                <div class="item" :class="{ connected: browserBridgeFirefoxConnected }">
                  <span class="item-dot" :class="browserBridgeFirefoxConnected ? 'dot-on' : 'dot-off'">
                    {{ browserBridgeFirefoxConnected ? '●' : '○' }}
                  </span>
                  <span class="item-name">{{ t('conn.browserBridgeFirefox') }}</span>
                  <div v-if="!browserBridgeFirefoxConnected" class="item-actions">
                    <button class="btn-sm btn-connect" @click="openSettings('browserBridge')">{{ t('conn.connect') }}</button>
                  </div>
                </div>
              </template>

              <!-- Gateway：仅运行中显示，未启动时去 Web 服务设置页操作 -->
              <template v-if="showGateway">
                <div class="section-divider"></div>
                <div class="item connected">
                  <span class="item-dot dot-on">●</span>
                  <span class="item-name">Gateway</span>
                  <span class="item-detail">:{{ gatewayPort }}</span>
                  <div class="item-actions">
                    <button class="btn-sm btn-disconnect" @click="toggleGateway">{{ t('conn.stop') }}</button>
                  </div>
                </div>
              </template>
            </div>
          </div>

          <!-- 右栏：MCP 服务器 -->
          <div class="conn-col">
            <div class="col-header">
              <span class="col-title">🔌 {{ t('conn.mcpServers') }}</span>
              <span
                class="col-count"
                :class="mcpHeaderClass"
              >{{ mcpHeaderText }}</span>
            </div>
            <div class="col-body">
              <div v-if="mcpServers.length === 0" class="empty-hint">
                <span>{{ t('mcp.noServersConfigured') }}</span>
                <button class="btn-link" @click="openSettings('mcp')">{{ t('conn.goSetup') }}</button>
              </div>
              <div
                v-for="srv in mcpServers" :key="srv.id"
                class="item"
                :class="{ connected: getMcpStatus(srv.id)?.connected, disabled: !srv.enabled }"
              >
                <span class="item-dot" :class="{
                  'dot-on': getMcpStatus(srv.id)?.connected,
                  'dot-off': isMcpFailed(srv),
                  'dot-disabled': !srv.enabled
                }">
                  <span v-if="isMcpPending(srv)" class="spinner"></span>
                  <template v-else>{{ getMcpStatus(srv.id)?.connected ? '●' : '○' }}</template>
                </span>
                <div class="item-name-group">
                  <span class="item-name">{{ srv.name }}</span>
                  <span v-if="getMcpStatus(srv.id)?.connected" class="item-detail">{{ getMcpStatus(srv.id)?.toolCount }} {{ t('mcp.tools') }}</span>
                  <span v-else-if="!srv.enabled" class="item-tag">{{ t('mcp.disabled') }}</span>
                  <span v-else-if="isMcpPending(srv)" class="item-connecting">{{ t('mcp.connecting') }}</span>
                  <span
                    v-else-if="isMcpFailed(srv)"
                    class="item-detail item-error"
                    :title="getMcpStatus(srv.id)?.error"
                  >{{ getMcpStatus(srv.id)?.error }}</span>
                </div>
                <div class="item-actions" v-if="isMcpFailed(srv)">
                  <button class="btn-sm btn-connect" :disabled="mcpConnecting === srv.id" @click="retryMcp(srv)">
                    <span v-if="mcpConnecting === srv.id" class="spinner"></span>
                    <span v-else>{{ t('mcp.retry') }}</span>
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </Teleport>
    <HoverTipOverlay :tip="hoverTip" />
  </div>
</template>

<style scoped>
.conn-wrapper {
  position: relative;
}

.conn-btn {
  position: relative;
  display: flex;
  align-items: center;
  gap: 4px;
  /* 高度对齐 header-right 其他按钮（App.vue 中为 22px），避免 hover 背景顶到 header 边界 */
  height: 22px;
  padding: 2px 6px;
  border-radius: 6px;
  /* 与 .btn-icon-header 的层级对齐：默认弱化到次级文本色，hover 时回到主文本色 */
  color: var(--text-secondary);
}

/* 削弱 hover scale，避免在 32px 高的 header 里放大后贴到边缘（与 App.vue 对 header btn-icon 的 override 保持一致） */
.conn-btn:hover {
  transform: scale(1.04);
  color: var(--text-primary);
}

/* hover 不再发光：与其他 header 图标按钮保持一致的素净反馈 */
.conn-btn:hover svg {
  filter: none;
}

/* 秘书行右部的装备胶囊：整体收窄，让出空间给秘书名字 */
.conn-btn--sidebar {
  width: 100%;
  height: 22px;
  gap: 3px;
  padding: 0 5px;
  border-radius: 6px;
  flex-shrink: 0;
  justify-content: flex-start;
}

.conn-btn--sidebar .equip-icon {
  width: 14px;
  height: 14px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.conn-btn--sidebar .status-dot,
.conn-btn--sidebar .spinner {
  width: 8px;
  text-align: center;
  flex-shrink: 0;
}

.conn-btn--sidebar:hover {
  transform: none;
  background: var(--bg-hover, rgba(127, 127, 127, 0.14));
}

/* 胶囊内已有底板，徽章去掉自己的背景免得套两层 */
.conn-btn--sidebar .status-badge {
  padding: 0;
  background: transparent;
  opacity: 1;
}

/* 状态徽章：作为图标的附属信息，对比度刻意压低，不与 Radio 图标抢视觉重点 */
.status-badge {
  display: flex;
  align-items: center;
  gap: 2px;
  font-size: 10px;
  font-weight: 500;
  padding: 1px 4px;
  border-radius: 8px;
  background: var(--bg-tertiary);
  opacity: 0.85;
}

.status-dot { font-size: 9px; }
.status-count { font-family: var(--font-mono); font-size: 10px; }

.status-all .status-dot, .status-all.status-badge { color: var(--brand-vital); }
.status-connecting .status-dot, .status-connecting.status-badge { color: var(--accent-primary); }
.status-partial .status-dot, .status-partial.status-badge { color: var(--color-warning); }
.status-offline .status-dot, .status-offline.status-badge { color: var(--color-error); }
.status-none .status-dot, .status-none.status-badge { color: var(--text-muted); }

/* 弹出面板 */
.conn-popover {
  position: fixed;
  top: calc(var(--header-height, 44px) + 8px);
  right: 60px;
  width: 520px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 10px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3);
  z-index: 1100;
  animation: popIn 0.15s ease;
}

/* sidebar 形态：位置由脚本按触发器实时算出（贴侧栏向上弹），这里只负责让出 CSS 固定值 */
.conn-popover--sidebar {
  top: auto;
  right: auto;
  overflow-y: auto;
  animation: popInUp 0.15s ease;
}

/* 向上弹就从下方浮起，别再沿用顶栏那套自上而下的入场 */
@keyframes popInUp {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}

@keyframes popIn {
  from { opacity: 0; transform: translateY(-8px); }
  to { opacity: 1; transform: translateY(0); }
}

/* 双栏布局 */
.conn-columns {
  display: flex;
}

.conn-col {
  flex: 1;
  min-width: 0;
}

.conn-col:first-child {
  border-right: 1px solid var(--border-color);
}

/* 栏头 */
.col-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border-color);
}

.col-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-primary);
}

.col-count {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-muted);
}

.col-count.count-ok {
  color: var(--brand-vital);
}

.col-count.count-connecting {
  color: var(--accent-primary);
}

.col-count.count-bad {
  color: var(--accent-red, #e74c3c);
}

.item-error {
  color: var(--accent-red, #e74c3c);
}

.item-connecting {
  font-size: 10px;
  color: var(--accent-primary);
  flex-shrink: 0;
}

/* 栏体：左栏随内容撑开（无滚动条）；右栏 MCP 列表可能较长，保留滚动 */
.col-body {
  padding: 4px 0;
}

.conn-col:first-child .col-body {
  overflow: visible;
}

.conn-col:last-child .col-body {
  max-height: 300px;
  overflow-y: auto;
}

/* 列表项 */
.item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 12px;
  transition: background 0.15s ease;
}

.item:hover {
  background: var(--bg-hover);
}

.item.disabled {
  opacity: 0.5;
}

.item-dot {
  font-size: 11px;
  flex-shrink: 0;
}

.dot-on { color: var(--brand-vital); }
.dot-wait { color: var(--color-warning); }
.dot-off { color: var(--text-muted); }
.dot-disabled { color: var(--text-muted); opacity: 0.5; }

.item-name {
  font-size: 12px;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
  min-width: 0;
}

.item-name-group {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
}

.item-name-group .item-name {
  flex: unset;
}

.item-detail {
  font-size: 10px;
  color: var(--text-muted);
  flex-shrink: 0;
}

.item-tag {
  font-size: 10px;
  color: var(--text-muted);
  padding: 1px 5px;
  background: var(--bg-tertiary);
  border-radius: 3px;
  flex-shrink: 0;
}

.item-actions {
  flex-shrink: 0;
  margin-left: auto;
}

.section-divider {
  height: 1px;
  background: var(--border-color);
  margin: 2px 12px;
}

/* 按钮 */
.btn-sm {
  padding: 2px 7px;
  font-size: 10px;
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.btn-connect {
  color: var(--accent-primary);
  background: transparent;
  border: 1px solid var(--accent-primary);
}

.btn-connect:hover:not(:disabled) {
  background: rgba(var(--accent-rgb), 0.1);
}

.btn-connect:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-disconnect {
  color: var(--text-muted);
  background: transparent;
  border: 1px solid var(--border-color);
}

.btn-disconnect:hover {
  color: var(--color-error);
  border-color: var(--color-error);
  background: rgba(var(--color-error-rgb), 0.1);
}

.btn-link {
  font-size: 11px;
  color: var(--accent-primary);
  background: none;
  border: none;
  cursor: pointer;
  padding: 0;
  margin-left: auto;
}

.btn-link:hover {
  text-decoration: underline;
}

.empty-hint {
  padding: 16px 12px;
  text-align: center;
  color: var(--text-muted);
  font-size: 11px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: center;
}

.spinner {
  display: inline-block;
  width: 10px;
  height: 10px;
  border: 1.5px solid var(--border-color);
  border-top-color: var(--accent-primary);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}
</style>
