<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, provide, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Monitor, Bot, Settings, X, Loader2, Heart } from 'lucide-vue-next'
import { useTerminalStore } from './stores/terminal'
import { useConfigStore, type SshSession } from './stores/config'
import { useCanvasStore } from './stores/canvas'
import TabBar from './components/TabBar.vue'
import AiPanel from './components/AiPanel.vue'
import CanvasPanel from './components/Canvas/CanvasPanel.vue'
import TerminalTabView from './components/TerminalTabView.vue'
import SessionManager from './components/SessionManager.vue'
import SettingsModal from './components/Settings/SettingsModal.vue'
import FileExplorer from './components/FileExplorer/FileExplorer.vue'
import ConnectionStatusPopover from './components/ConnectionStatusPopover.vue'
import Awaken from './components/Awaken.vue'
import SetupWizard from './components/SetupWizard.vue'
import WelcomePage from './components/WelcomePage.vue'
import SmartPatrolPage from './components/SmartPatrolPage.vue'
import Toast from './components/common/Toast.vue'
import ConfirmDialog from './components/common/ConfirmDialog.vue'
import { useConfirm } from './composables/useConfirm'
import { toast } from './composables/useToast'
import { checkAudioDevicesGlobal, initSpeechGlobal } from './composables/useSpeechRecognition'
import type { SftpConnectionConfig } from './composables/useSftp'
import { uiThemes } from './themes/ui-themes'
import { createLogger } from './utils/logger'

const log = createLogger('App')

const { t } = useI18n()

// Steam 构建标识（由 vite define 注入），在 script 中取值供模板使用，避免模板直接访问全局
const isSteamBuild = typeof __STEAM_BUILD__ !== 'undefined' && __STEAM_BUILD__

// 知识库升级进度
const knowledgeUpgrading = ref(false)
const knowledgeUpgradeProgress = ref({ current: 0, total: 0, filename: '' })
const terminalStore = useTerminalStore()
const configStore = useConfigStore()
const canvasStore = useCanvasStore()

// Steam 版使用独立品牌名
const steamAppTitle = computed(() => {
  const lang = configStore.language || 'zh-CN'
  return lang.startsWith('zh') ? '旗鱼终端' : 'SFTerm'
})
const { show: showConfirmDialog, options: confirmOptions, handleConfirm, handleCancel, handleClose } = useConfirm()

const showSidebar = ref(false)
const showSettings = ref(false)
const showSmartPatrol = ref(false)
const showAwaken = ref(false)
const isAwakened = ref(false)

// 平台判断：macOS 使用 hiddenInset（左侧红绿灯），Windows 使用 titleBarOverlay（右侧按钮）
const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform)
const isWin = typeof navigator !== 'undefined' && /Win/i.test(navigator.platform)

// 全屏时红绿灯/系统标题栏按钮被隐藏，header 不再需要预留空间
const isFullScreen = ref(false)

// Windows: 将当前主题下的 header 背景色与前景色同步给系统标题栏 overlay
function syncTitleBarOverlay() {
  if (!isWin) return
  try {
    const styles = getComputedStyle(document.documentElement)
    // 需要把 CSS 变量值转成 #rrggbb 或 rgb()；Windows API 能接受 hex / rgb 字符串
    const bg = styles.getPropertyValue('--bg-secondary').trim() || '#101010'
    const fg = styles.getPropertyValue('--text-primary').trim() || '#e8e8e8'
    window.electronAPI.window.setTitleBarOverlay?.({ color: bg, symbolColor: fg })
  } catch {
    /* ignore */
  }
}

const hasTerminalTab = computed(() => terminalStore.tabs.some(t => t.type === 'local' || t.type === 'ssh'))

// UI 主题
const currentUiTheme = computed(() => configStore.uiTheme)
// 当前主题的颜色模式（dark/light）
const currentColorScheme = computed(() => {
  const theme = uiThemes[currentUiTheme.value as keyof typeof uiThemes]
  return theme?.colorScheme || 'dark'
})
const settingsInitialTab = ref<string | undefined>(undefined)
const pendingInstallSkillId = ref<string | undefined>(undefined)
const showFileExplorer = ref(false)
const sftpConfig = ref<SftpConnectionConfig | null>(null)
const showSetupWizard = ref(false)

// 每个终端 tab 对应的 TerminalTabView 实例引用（tabId -> instance）
const tabViewRefs = ref<Record<string, InstanceType<typeof TerminalTabView> | null>>({})

// Canvas 分割线拖拽
function startCanvasResize(e: MouseEvent, _tabId: string) {
  e.preventDefault()
  const startX = e.clientX
  const startRatio = canvasStore.splitRatio
  const container = (e.target as HTMLElement).parentElement
  if (!container) return
  const containerWidth = container.getBoundingClientRect().width

  const onMove = (ev: MouseEvent) => {
    const delta = ev.clientX - startX
    const newRatio = Math.max(0.2, Math.min(0.8, startRatio - delta / containerWidth))
    canvasStore.splitRatio = newRatio
  }

  const onUp = () => {
    document.removeEventListener('mousemove', onMove)
    document.removeEventListener('mouseup', onUp)
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
  }

  document.body.style.cursor = 'col-resize'
  document.body.style.userSelect = 'none'
  document.addEventListener('mousemove', onMove)
  document.addEventListener('mouseup', onUp)
}

async function onAwakenClose() {
  showAwaken.value = false
  try {
    isAwakened.value = !!(await window.electronAPI.config.get('agentAwakened'))
  } catch { /* ignore */ }
}

// 提供给子组件
provide('showSettings', () => {
  showSettings.value = true
})

// 同步主题到 body，让 Teleport 到 body 的弹窗也能使用正确的主题
watch([currentUiTheme, currentColorScheme], ([theme, colorScheme]) => {
  document.body.setAttribute('data-ui-theme', theme)
  document.body.setAttribute('data-color-scheme', colorScheme)
  // CSS 变量更新需等下一帧生效后再读
  requestAnimationFrame(syncTitleBarOverlay)
}, { immediate: true })

/**
 * 检测 KeyboardEvent 是否匹配 Electron Accelerator 字符串
 */
function matchAccelerator(event: KeyboardEvent, accelerator: string): boolean {
  if (!accelerator) return false
  const parts = accelerator.split('+')
  let needCtrl = false, needShift = false, needAlt = false
  let targetKey = ''
  for (const part of parts) {
    switch (part) {
      case 'CmdOrCtrl': needCtrl = true; break
      case 'Shift': needShift = true; break
      case 'Alt': needAlt = true; break
      default: targetKey = part; break
    }
  }
  if (needCtrl !== (event.ctrlKey || event.metaKey)) return false
  if (needShift !== event.shiftKey) return false
  if (needAlt !== event.altKey) return false

  const eventKey = event.key.length === 1 ? event.key.toUpperCase() : event.key
  if (targetKey === ',') return event.key === ','
  if (/^F\d{1,2}$/.test(targetKey)) return eventKey === targetKey
  return eventKey === targetKey || event.key.toLowerCase() === targetKey.toLowerCase()
}

// 全局快捷键处理
const handleGlobalKeydown = (event: KeyboardEvent) => {
  const shortcuts = configStore.keyboardShortcuts

  if (matchAccelerator(event, shortcuts.newAssistantTab)) {
    event.preventDefault()
    terminalStore.createAssistantTab()
    return
  }

  if (matchAccelerator(event, shortcuts.newLocalTerminal)) {
    event.preventDefault()
    terminalStore.createTab('local')
    return
  }

  // 侧栏 ESC 关闭需让路给上层模态（如主机凭证弹窗），否则会与全局 listener 顺序叠加导致侧栏被误关
  if (event.key === 'Escape' && showSidebar.value) {
    if (document.querySelector('.credential-overlay')) return
    showSidebar.value = false
    return
  }

  // Ctrl+W / Cmd+W 关闭当前终端或窗口（不可自定义，始终生效）
  if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === 'w') {
    event.preventDefault()
    handleCloseShortcut()
  }
}

// 处理关闭快捷键
const handleCloseShortcut = async () => {
  // 如果有活跃终端，关闭当前终端
  if (terminalStore.tabs.length > 0 && terminalStore.activeTabId) {
    await terminalStore.closeTab(terminalStore.activeTabId)
  } else {
    // 没有活跃终端时关闭窗口
    await window.electronAPI.window.close()
  }
}

// 清理函数存储
let cleanupTerminalCountListener: (() => void) | null = null
let cleanupKnowledgeUpgrading: (() => void) | null = null
let cleanupKnowledgeProgress: (() => void) | null = null
let cleanupKnowledgeReady: (() => void) | null = null
let cleanupMenuCommand: (() => void) | null = null
let cleanupSchedulerTaskStarted: (() => void) | null = null
let cleanupGatewayRemoteTab: (() => void) | null = null
let cleanupGatewayRemoteTask: (() => void) | null = null
let cleanupImConnectionChange: (() => void) | null = null
let cleanupRunTask: (() => void) | null = null
let cleanupInstallSkill: (() => void) | null = null
let cleanupWatchEnsureTab: (() => void) | null = null
let cleanupWatchProactiveMessage: (() => void) | null = null
let cleanupWatchActivateMessage: (() => void) | null = null
let cleanupAgentCompleteForProactive: (() => void) | null = null
let cleanupFullScreenChange: (() => void) | null = null


onMounted(async () => {
  // 注册全局快捷键
  document.addEventListener('keydown', handleGlobalKeydown)

  // 同步全屏状态：初始查询 + 监听变化（macOS 全屏会隐藏红绿灯，需要调整 header 左侧留白）
  try {
    isFullScreen.value = await window.electronAPI.window.isFullScreen()
  } catch { /* ignore */ }
  cleanupFullScreenChange = window.electronAPI.window.onFullScreenChange((fs) => {
    isFullScreen.value = fs
  })

  // Windows 焦点恢复：用户点击输入元素时确保 webContents 拥有键盘焦点
  // 修复 Windows 上因 setAlwaysOnTop/通知交互导致的"输入框看似有焦点但无法键入"问题
  if (navigator.platform === 'Win32') {
    document.addEventListener('mousedown', (e) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') {
        window.electronAPI.window.focusWebContents()
      }
    }, true)
  }

  // 加载觉醒状态
  try {
    isAwakened.value = !!(await window.electronAPI.config.get('agentAwakened'))
  } catch { /* ignore */ }

  // 注册终端数量查询响应（用于退出确认）
  cleanupTerminalCountListener = window.electronAPI.window.onRequestTerminalCount(() => {
    window.electronAPI.window.responseTerminalCount(terminalStore.tabs.length)
  })

  // 监听知识库升级事件
  cleanupKnowledgeUpgrading = window.electronAPI.knowledge.onUpgrading(() => {
    knowledgeUpgrading.value = true
  })
  cleanupKnowledgeProgress = window.electronAPI.knowledge.onRebuildProgress((data) => {
    knowledgeUpgradeProgress.value = data
  })
  cleanupKnowledgeReady = window.electronAPI.knowledge.onReady(() => {
    knowledgeUpgrading.value = false
  })

  // 监听菜单命令
  cleanupMenuCommand = window.electronAPI.menu.onCommand(({ command }) => {
    handleMenuCommand(command)
  })

  // 监听定时任务开始事件，创建可见的终端 tab 并自动执行 Agent
  cleanupSchedulerTaskStarted = window.electronAPI.scheduler.onTaskStarted((data) => {
    if (data.ptyId) {
      // 根据任务类型构建 tab 配置，包含 pendingTask 以便 AiPanel 自动执行
      const tabTitle = `⏰ ${data.taskName}`
      const pendingTask = data.prompt  // 任务 prompt 作为待执行任务
      
      if (data.targetType === 'local') {
        terminalStore.createTabWithExistingPty({
          ptyId: data.ptyId,
          title: tabTitle,
          type: 'local',
          pendingTask
        })
      } else if (data.targetType === 'ssh' && data.sshSessionId) {
        // 获取 SSH 会话配置
        const sshSession = configStore.sshSessions.find(s => s.id === data.sshSessionId)
        if (sshSession) {
          terminalStore.createTabWithExistingPty({
            ptyId: data.ptyId,
            title: tabTitle,
            type: 'ssh',
            sshConfig: {
              host: sshSession.host,
              port: sshSession.port,
              username: sshSession.username
            },
            sshSessionId: data.sshSessionId,
            pendingTask
          })
        }
      }
      
      // 打开新 tab 的 AI 面板确保可见（createTabWithExistingPty 会激活新 tab）
      ensureAiPanel()
      
      log.debug(`[Scheduler] 定时任务开始: ${data.taskName}, 已创建终端 tab，等待 AiPanel 执行`)
    }
  })

  // 监听深链调起：从官网技能示例等外部来源触发 Agent 任务
  cleanupRunTask = window.electronAPI.app.onRunTask((task: string) => {
    log.debug(`[DeepLink] 收到外部任务: ${task.substring(0, 80)}...`)
    terminalStore.createTabWithTask(task)
    ensureAiPanel()
  })

  // 监听深链调起：从官网一键安装技能
  cleanupInstallSkill = window.electronAPI.app.onInstallSkill((skillId: string) => {
    log.debug(`[DeepLink] 收到技能安装请求: ${skillId}`)
    pendingInstallSkillId.value = skillId
    settingsInitialTab.value = 'skills'
    showSettings.value = true
  })

  // 监听远程 Gateway 助手标签页创建事件
  cleanupGatewayRemoteTab = window.electronAPI.gateway.onRemoteTabCreated((data) => {
    if (!data.agentId) return
    const existingTab = terminalStore.tabs.find(tab => tab.agentId === data.agentId)
    if (!existingTab) {
      terminalStore.createAssistantTab({
        agentId: data.agentId,
        title: data.title || `📡 ${t('gateway.remoteChat', '远程对话')}`,
        isRemote: true,
        activate: false
      })
      log.debug(`[Gateway] 远程助手标签页已创建: agentId=${data.agentId}`)
    }
  })

  // 监听远程 Gateway 任务开始事件：Toast 通知 + 设置 tab running 状态
  // 后端 WebChatService 直驱 Agent 执行，前端仅渲染
  cleanupGatewayRemoteTask = window.electronAPI.gateway.onRemoteTaskStarted((data) => {
    log.debug(`[WebChat] onRemoteTaskStarted: agentId=${data.agentId}, message="${data.message.substring(0, 60)}"`)
    const preview = data.message.length > 60
      ? data.message.substring(0, 60) + '...'
      : data.message
    toast.info(`📡 ${t('gateway.remoteTaskStarted')}: ${preview}`, 5000)

    // 找到或创建远程助手 tab
    let remoteTab = terminalStore.tabs.find(tab => tab.agentId === data.agentId)
    if (!remoteTab) {
      const newTabId = terminalStore.createAssistantTab({
        agentId: data.agentId,
        title: `📡 ${t('gateway.remoteChat', '远程对话')}`,
        isRemote: true,
        remoteChannel: data.remoteChannel,
        activate: false
      })
      remoteTab = terminalStore.tabs.find(tab => tab.id === newTabId)
    } else if (data.remoteChannel) {
      remoteTab.remoteChannel = data.remoteChannel
    }
    if (remoteTab) {
      // 仅设置 running 状态，后端已在执行 Agent，steps 通过 agent:step IPC 事件流入
      terminalStore.setAgentRunning(remoteTab.id, true, data.agentId, data.message)
      log.debug(`[WebChat] 远程任务已开始: tabId=${remoteTab.id}, agentId=${data.agentId}`)
    }
  })

  // Watch desktop 输出：确保助手 tab 存在，后续 steps 通过标准 agent:step 事件流入
  cleanupWatchEnsureTab = window.electronAPI.watch.onEnsureTab((data) => {
    const existing = terminalStore.tabs.find(t => t.agentId === data.agentId)
    if (!existing) {
      terminalStore.createAssistantTab({
        agentId: data.agentId,
        title: t('watch.assistantTabTitle', '远程对话'),
        activate: false
      })
      log.debug(`[Watch] Created assistant tab: ${data.agentId}`)
    }
  })

  // 觉醒主动推送：收到消息先存着，弹通知；用户点击通知后才创建标签页展开对话
  const pendingProactiveMessages: Array<{ agentId: string; message: string; watchName: string; timestamp: number }> = []

  // 将 proactive 消息注入 tab steps 的辅助函数
  const injectProactiveSteps = (tabId: string, message: string, timestamp?: number) => {
    const ts = timestamp || Date.now()
    const uid = `proactive-${ts}-${Math.random().toString(36).substring(2, 6)}`
    terminalStore.addAgentStep(tabId, {
      id: `${uid}-task`,
      type: 'user_task',
      content: '__proactive__',
      timestamp: ts
    })
    terminalStore.addAgentStep(tabId, {
      id: `${uid}-result`,
      type: 'final_result',
      content: message,
      timestamp: ts
    })
  }

  const activateProactiveMessages = (agentId: string) => {
    const messages = pendingProactiveMessages.filter(m => m.agentId === agentId)
    if (messages.length === 0) return

    let tab = terminalStore.tabs.find(t => t.agentId === agentId)
    if (!tab) {
      const tabId = terminalStore.createAssistantTab({
        agentId,
        title: configStore.agentName || t('watch.assistantTabTitle'),
        activate: true
      })
      tab = terminalStore.tabs.find(t => t.id === tabId)
    } else {
      terminalStore.setActiveTab(tab.id)
    }

    if (tab) {
      for (const msg of messages) {
        injectProactiveSteps(tab.id, msg.message, msg.timestamp)
      }
    }

    // 清除已展示的消息
    pendingProactiveMessages.splice(0, pendingProactiveMessages.length,
      ...pendingProactiveMessages.filter(m => m.agentId !== agentId))
  }

  // Agent 完成时，将延迟的 proactive 消息注入 tab
  const flushDeferredProactive = (agentId: string) => {
    const tab = terminalStore.tabs.find(t => t.agentId === agentId)
    if (!tab) return
    const deferred = pendingProactiveMessages.filter(m => m.agentId === agentId)
    if (deferred.length === 0) return
    for (const msg of deferred) {
      injectProactiveSteps(tab.id, msg.message, msg.timestamp)
    }
    pendingProactiveMessages.splice(0, pendingProactiveMessages.length,
      ...pendingProactiveMessages.filter(m => m.agentId !== agentId))
    terminalStore.clearDeferredProactive(tab.id)
  }

  // 全局监听 agent 完成事件，刷新延迟的 proactive 消息
  cleanupAgentCompleteForProactive = window.electronAPI.agent.onComplete((data: { agentId: string }) => {
    const tab = terminalStore.tabs.find(t => t.agentId === data.agentId)
    if (tab && terminalStore.hasDeferredProactive(tab.id)) {
      flushDeferredProactive(data.agentId)
    }
  })

  cleanupWatchProactiveMessage = window.electronAPI.watch.onProactiveMessage((data) => {
    const preview = data.message.length > 100
      ? data.message.substring(0, 100) + '...'
      : data.message

    // 优先精确匹配 agentId，回退到 companion tab（IM 对话镜像）
    const tab = terminalStore.tabs.find(t => t.agentId === data.agentId)
      || terminalStore.tabs.find(t => t.agentId === '__companion__')

    if (tab) {
      const tabId = tab.id
      // Agent 忙时延迟注入，防止用户误回复干扰正在执行的任务
      if (tab.agentState?.isRunning) {
        pendingProactiveMessages.push({
          agentId: data.agentId,
          message: data.message,
          watchName: data.watchName,
          timestamp: Date.now()
        })
        terminalStore.markDeferredProactive(tabId)
        toast.proactive(preview, () => {
          if (terminalStore.tabs.find(t => t.id === tabId)) {
            terminalStore.setActiveTab(tabId)
          }
        })
      } else {
        injectProactiveSteps(tabId, data.message)
        toast.proactive(preview, () => {
          if (terminalStore.tabs.find(t => t.id === tabId)) {
            terminalStore.setActiveTab(tabId)
          }
        })
      }
    } else {
      pendingProactiveMessages.push({
        agentId: data.agentId,
        message: data.message,
        watchName: data.watchName,
        timestamp: Date.now()
      })
      toast.proactive(preview, () => {
        activateProactiveMessages(data.agentId)
      })
    }
  })

  // 系统通知点击：激活应用并展开对话
  cleanupWatchActivateMessage = window.electronAPI.watch.onActivateMessage?.((data: { agentId: string }) => {
    activateProactiveMessages(data.agentId)
  }) || null

  // 全局监听 IM 渠道连接状态变化，弹 toast 通知
  const imPlatformNames: Record<string, string> = {
    dingtalk: t('settings.im.dingtalk'),
    feishu: t('settings.im.feishu'),
    slack: t('settings.im.slack'),
    telegram: t('settings.im.telegram'),
    wecom: t('settings.im.wecom'),
  }
  const imConnectedState = new Map<string, boolean>()
  cleanupImConnectionChange = window.electronAPI.im.onConnectionChange((data) => {
    const prev = imConnectedState.get(data.platform)
    imConnectedState.set(data.platform, data.connected)
    // 仅在状态真正变化时提示（跳过首次上报，避免启动时刷屏）
    if (prev === undefined) return
    const name = imPlatformNames[data.platform] || data.platform
    if (data.connected) {
      toast.success(t('im.channelConnected', { platform: name }))
    } else {
      toast.warning(t('im.channelDisconnected', { platform: name }))
    }
  })

  // 加载配置
  await configStore.loadConfig()

  // 检查是否完成首次设置（Steam 版跳过引导向导）
  const setupCompleted = await window.electronAPI.config.getSetupCompleted()
  if (!setupCompleted) {
    if (isSteamBuild) {
      await configStore.setSetupCompleted(true)
    } else {
      showSetupWizard.value = true
      return // 显示向导，暂不创建终端
    }
  }

  // 已完成设置，正常启动
  await initializeApp()
})

// 初始化应用（正常启动流程）
const initializeApp = async () => {
  // 不再自动创建本地终端，显示欢迎页让用户选择

  // 延迟连接 MCP 服务器，不阻塞首屏渲染
  // 使用 requestIdleCallback 或 setTimeout 在浏览器空闲时执行
  const connectMcpServers = async () => {
    try {
      const results = await window.electronAPI.mcp.connectEnabledServers()
      const connected = results.filter(r => r.success).length
      const failed = results.filter(r => !r.success)
      if (connected > 0) {
        log.info(`[MCP] 自动连接了 ${connected} 个服务器`)
      }
      if (failed.length > 0) {
        log.warn('[MCP] 部分服务器连接失败:', failed)
      }
    } catch (error) {
      log.error('[MCP] 自动连接服务器失败:', error)
    }
  }

  // 延迟执行，让 UI 先渲染完成
  if ('requestIdleCallback' in window) {
    requestIdleCallback(() => connectMcpServers(), { timeout: 3000 })
  } else {
    setTimeout(connectMcpServers, 500)
  }

  // 全局音频设备检测 + 语音模型预初始化（只执行一次）
  if (configStore.keyboardShortcuts.voiceInput) {
    checkAudioDevicesGlobal().then(available => {
      if (available) {
        initSpeechGlobal()
      } else {
        toast.warning(t('ai.noAudioDevice'))
      }
    })
  }
}

// 是否显示欢迎页（没有打开任何终端且不在智能巡检界面时显示）
const showWelcomePage = computed(() => terminalStore.tabs.length === 0 && !showSmartPatrol.value)
// 从欢迎页打开助手
const openAssistantFromWelcome = () => {
  terminalStore.createAssistantTab()
}

// 从欢迎页打开本地终端
const openLocalFromWelcome = async () => {
  await terminalStore.createTab('local')
}

// 从欢迎页连接 SSH
const openSshFromWelcome = async (session: SshSession) => {
  // 更新最近使用时间
  await configStore.updateSessionLastUsed(session.id)
  
  // 获取有效的跳板机配置
  const jumpHost = configStore.getEffectiveJumpHost(session)
  
  await terminalStore.createTab('ssh', {
    host: session.host,
    port: session.port,
    username: session.username,
    password: session.password,
    privateKeyPath: session.privateKeyPath,  // 私钥文件路径
    passphrase: session.passphrase,  // 私钥密码
    jumpHost,
    encoding: session.encoding || 'utf-8',
    sessionId: session.id  // 传递会话 ID（用于重连）
  })
}

// 从欢迎页打开会话管理器
const openSessionManagerFromWelcome = () => {
  showSidebar.value = true
}

// 从欢迎页打开智能巡检
const openSmartPatrolFromWelcome = () => {
  showSmartPatrol.value = true
}

// 从智能巡检返回欢迎页
const backFromSmartPatrol = () => {
  showSmartPatrol.value = false
}

// 完成引导向导
const onSetupComplete = async () => {
  showSetupWizard.value = false
  // 向导完成后初始化应用并打开 AI 面板（触发诞生对话）
  await initializeApp()
  ensureAiPanel()
}

// 切换侧边栏
const toggleSidebar = () => {
  showSidebar.value = !showSidebar.value
}

// 获取当前活跃终端 tab 的 TerminalTabView 实例
function getActiveTabView() {
  return tabViewRefs.value[terminalStore.activeTabId] as InstanceType<typeof TerminalTabView> | null
}

// 切换当前 tab 的 AI 面板
const toggleAiPanel = () => {
  getActiveTabView()?.toggleAiPanel()
}

// 确保指定 tab 的 AI 面板可见
function ensureAiPanel(tabId?: string) {
  const id = tabId || terminalStore.activeTabId
  const view = tabViewRefs.value[id] as InstanceType<typeof TerminalTabView> | null
  view?.ensureAiPanel()
}

// 打开 SFTP 文件管理器（模态框模式）
const openSftp = (session: SshSession) => {
  sftpConfig.value = {
    host: session.host,
    port: session.port,
    username: session.username,
    password: session.password,
    privateKeyPath: session.privateKeyPath,
    passphrase: session.passphrase
  }
  showFileExplorer.value = true
}

// 关闭 SFTP 文件管理器
const closeSftp = () => {
  showFileExplorer.value = false
  sftpConfig.value = null
}

// 有新的 Agent 任务时确保对应 tab 的 AI 面板可见
watch(() => Object.keys(terminalStore.pendingSchedulerTasks), (tabIds) => {
  for (const tabId of tabIds) {
    ensureAiPanel(tabId)
  }
})

// 同步终端标签页状态到菜单栏（控制文件管理器等菜单项的启用/禁用）
watch(hasTerminalTab, (val) => {
  window.electronAPI.menu.setTerminalState(val)
}, { immediate: true })

const openConnectionSettings = (tab?: string) => {
  settingsInitialTab.value = tab || undefined
  showSettings.value = true
}

// 关闭控制面板
const closeSettings = () => {
  showSettings.value = false
  settingsInitialTab.value = undefined
  pendingInstallSkillId.value = undefined
}

// 重新运行引导
const restartSetup = async () => {
  showSetupWizard.value = true
}

// 处理菜单命令
const handleMenuCommand = async (command: string) => {
  // 需要主界面可见的命令，先关闭设置面板
  const requiresMainView = [
    'newLocalTerminal', 'newAssistantTab', 'newSshConnection',
    'openFileManager', 'importXshell', 'closeTab',
    'toggleSidebar', 'toggleAiPanel',
    'clearTerminal', 'find', 'selectAll', 'batchCommand'
  ]
  if (showSettings.value && requiresMainView.includes(command)) {
    closeSettings()
  }

  switch (command) {
    case 'newLocalTerminal':
      terminalStore.createTab('local')
      break
    case 'newAssistantTab':
      terminalStore.createAssistantTab()
      break
    case 'newSshConnection':
      showSidebar.value = true
      break
    case 'openFileManager':
      window.dispatchEvent(new CustomEvent('menu:open-file-manager'))
      break
    case 'importXshell':
      showSidebar.value = true
      setTimeout(() => {
        window.dispatchEvent(new CustomEvent('menu:import-xshell'))
      }, 100)
      break
    case 'closeTab':
      handleCloseShortcut()
      break
    case 'toggleSidebar':
      toggleSidebar()
      break
    case 'toggleAiPanel':
      if (!isSteamBuild) toggleAiPanel()
      break
    case 'toggleKnowledge':
      if (!isSteamBuild) {
        settingsInitialTab.value = 'knowledge'
        showSettings.value = true
      }
      break
    case 'openSettings':
      showSettings.value = true
      break
    case 'showAbout':
      settingsInitialTab.value = 'about'
      showSettings.value = true
      break
    case 'checkUpdate':
      settingsInitialTab.value = 'about'
      showSettings.value = true
      setTimeout(() => {
        window.electronAPI.updater.checkForUpdates()
      }, 500)
      break
    case 'restartAndUpdate':
      window.electronAPI.updater.quitAndInstall()
      break
    case 'clearTerminal':
      window.dispatchEvent(new CustomEvent('menu:clear-terminal'))
      break
    case 'find':
      window.dispatchEvent(new CustomEvent('menu:find'))
      break
    case 'selectAll':
      window.dispatchEvent(new CustomEvent('menu:select-all'))
      break
    case 'batchCommand':
      window.dispatchEvent(new CustomEvent('toggle-batch-panel'))
      break
    case 'openAiDebugConsole':
      if (!isSteamBuild) window.electronAPI.aiDebugOpenWindow()
      break
  }
}

onUnmounted(() => {
  document.removeEventListener('keydown', handleGlobalKeydown)
  // 清理监听器
  cleanupTerminalCountListener?.()
  cleanupKnowledgeUpgrading?.()
  cleanupKnowledgeProgress?.()
  cleanupKnowledgeReady?.()
  cleanupMenuCommand?.()
  cleanupSchedulerTaskStarted?.()
  cleanupGatewayRemoteTab?.()
  cleanupGatewayRemoteTask?.()
  cleanupImConnectionChange?.()
  cleanupRunTask?.()
  cleanupInstallSkill?.()
  cleanupWatchEnsureTab?.()
  cleanupWatchProactiveMessage?.()
  cleanupWatchActivateMessage?.()
  cleanupAgentCompleteForProactive?.()
  cleanupFullScreenChange?.()
})
</script>

<template>
  <div class="app-container" :class="{ 'sidebar-open': showSidebar, 'is-mac': isMac, 'is-win': isWin, 'is-fullscreen': isFullScreen }" :data-ui-theme="currentUiTheme" :data-color-scheme="currentColorScheme">
    <!-- 顶部工具栏 -->
    <header class="app-header">
      <div class="header-left">
        <span class="app-title">{{ isSteamBuild ? steamAppTitle : t('app.title') }}</span>
      </div>
      <div class="header-center">
        <TabBar @open-ssh="showSidebar = true" />
      </div>
      <div class="header-right">
        <template v-if="!isSteamBuild">
          <button v-if="hasTerminalTab" class="btn-icon btn-icon-header" @click="toggleAiPanel" :title="t('header.aiAssistant')">
            <Bot :size="18" />
          </button>
        </template>
        <button class="btn-icon btn-icon-header" @click="toggleSidebar" :title="t('header.hostManager')">
          <Monitor :size="18" />
        </button>
        <template v-if="!isSteamBuild">
          <button class="btn-icon btn-icon-header" :class="{ 'awakened-active': isAwakened }" @click="showAwaken = true" :title="t('awaken.title') + ' — ' + t('awaken.description')">
            <Heart :size="18" fill="currentColor" />
          </button>
          <ConnectionStatusPopover @open-settings="openConnectionSettings" />
        </template>
        <button class="btn-icon btn-icon-header" @click="showSettings = true" :title="t('header.settings')">
          <Settings :size="18" />
        </button>
      </div>
    </header>

    <!-- 主体内容 -->
    <div class="app-body">
      <!-- 左侧边栏 - 主机管理 -->
      <aside v-show="showSidebar" class="sidebar">
        <div class="sidebar-header">
          <span>{{ t('header.hostManager') }}</span>
          <button class="btn-icon btn-sm" @click="showSidebar = false" :title="t('header.closeSidebar')">
            <X :size="14" />
          </button>
        </div>
        <div class="sidebar-content">
          <SessionManager @open-sftp="openSftp" />
        </div>
      </aside>

      <!-- 终端区域 / 欢迎页 / 智能巡检 -->
      <main class="terminal-area">
        <WelcomePage 
          v-if="showWelcomePage"
          @open-assistant="openAssistantFromWelcome"
          @open-local="openLocalFromWelcome"
          @open-ssh="openSshFromWelcome"
          @open-session-manager="openSessionManagerFromWelcome"
          @open-smart-patrol="openSmartPatrolFromWelcome"
        />
        <SmartPatrolPage 
          v-else-if="showSmartPatrol"
          @back="backFromSmartPatrol"
        />
        <!-- 每个 Tab 一个独立 div，始终挂载，v-show 控制可见性 -->
        <template v-else v-for="tab in terminalStore.tabs" :key="tab.id">
          <!-- ===== 助手 Tab（Steam 版不渲染） ===== -->
          <div v-if="tab.type === 'assistant' && !isSteamBuild" v-show="tab.id === terminalStore.activeTabId" class="tab-view assistant-tab">
            <div class="assistant-split">
              <div class="assistant-chat" :style="canvasStore.isVisible(tab.id) ? { flex: `0 0 ${(1 - canvasStore.splitRatio) * 100}%` } : undefined">
                <AiPanel
                  :tab-id="tab.id"
                  :visible="tab.id === terminalStore.activeTabId"
                />
              </div>
              <div
                v-show="canvasStore.isVisible(tab.id)"
                class="assistant-divider"
                @mousedown="startCanvasResize($event, tab.id)"
              ></div>
              <div
                class="assistant-canvas"
                :class="{ 'canvas-open': canvasStore.isVisible(tab.id) }"
                :style="canvasStore.isVisible(tab.id) ? { flex: `0 0 ${canvasStore.splitRatio * 100}%` } : undefined"
              >
                <CanvasPanel v-if="canvasStore.isVisible(tab.id)" :tab-id="tab.id" />
              </div>
            </div>
          </div>
          <!-- ===== 终端 Tab (local / ssh) ===== -->
          <TerminalTabView
            v-else
            v-show="tab.id === terminalStore.activeTabId"
            :ref="(el: any) => { tabViewRefs[tab.id] = el }"
            :tab="tab"
            :is-active="tab.id === terminalStore.activeTabId"
            class="tab-view"
          />
        </template>
      </main>
    </div>

    <!-- 控制面板 -->
    <SettingsModal 
      v-if="showSettings" 
      :initial-tab="settingsInitialTab"
      :pending-install-skill-id="pendingInstallSkillId"
      @close="closeSettings"
      @restart-setup="restartSetup"
    />

    <!-- SFTP 文件管理器弹窗 -->
    <FileExplorer
      v-if="showFileExplorer && sftpConfig"
      :config="sftpConfig"
      @close="closeSftp"
    />

    <!-- 首次启动引导向导 -->
    <SetupWizard
      v-if="showSetupWizard"
      @complete="onSetupComplete"
    />


    <!-- 关切面板（Steam 版不渲染） -->
    <Awaken
      v-if="showAwaken && !isSteamBuild"
      @close="onAwakenClose"
      @awakened-change="isAwakened = $event"
    />

    <!-- 知识库升级进度提示（Steam 版不渲染） -->
    <Transition name="slide-down">
      <div v-if="knowledgeUpgrading && !isSteamBuild" class="knowledge-upgrade-bar">
        <div class="upgrade-content">
          <Loader2 class="upgrade-icon" :size="16" />
          <span class="upgrade-text">
            {{ t('knowledge.upgrading') }}
            <template v-if="knowledgeUpgradeProgress.total > 0">
              ({{ knowledgeUpgradeProgress.current }}/{{ knowledgeUpgradeProgress.total }})
            </template>
          </span>
          <span v-if="knowledgeUpgradeProgress.filename" class="upgrade-filename">
            {{ knowledgeUpgradeProgress.filename }}
          </span>
        </div>
        <div class="upgrade-progress">
          <div 
            class="upgrade-progress-bar" 
            :style="{ width: knowledgeUpgradeProgress.total > 0 ? (knowledgeUpgradeProgress.current / knowledgeUpgradeProgress.total * 100) + '%' : '0%' }"
          ></div>
        </div>
      </div>
    </Transition>

    <!-- 全局 Toast 提示 -->
    <Toast />

    <!-- 全局确认对话框 -->
    <ConfirmDialog
      :show="showConfirmDialog"
      :options="confirmOptions"
      @confirm="handleConfirm"
      @cancel="handleCancel"
      @close="handleClose"
    />
  </div>
</template>

<style scoped>
.app-container {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  background: var(--bg-primary);
}

/* 顶部工具栏 */
.app-header {
  display: flex;
  align-items: center;
  height: var(--header-height);
  padding: 0 12px;
  background: var(--bg-secondary);
  -webkit-app-region: drag;
  position: relative;
  z-index: 10;
}

/* macOS: hiddenInset 标题栏下红绿灯按钮浮在内容上，左侧留出空间避免遮挡；
   使用 --mac-traffic-light-inset 统一管理，与 modal header 保持同一起点 */
.app-container.is-mac .app-header {
  padding-left: var(--mac-traffic-light-inset);
}

/* macOS 全屏：红绿灯按钮被系统隐藏，恢复左侧默认留白让应用标题贴最左 */
.app-container.is-mac.is-fullscreen .app-header {
  padding-left: 12px;
}

/* Windows: titleBarOverlay 在右上角绘制最小化/最大化/关闭按钮（约 138px），右侧留位避免遮挡 */
.app-container.is-win .app-header {
  padding-right: 146px;
}

/* Windows 全屏：系统标题栏按钮被隐藏，恢复右侧默认留白 */
.app-container.is-win.is-fullscreen .app-header {
  padding-right: 12px;
}

/* 深色主题：顶部渐变效果 */
[data-color-scheme="dark"] .app-header {
  background: linear-gradient(180deg, var(--bg-secondary) 0%, rgba(var(--bg-secondary-rgb, 24, 24, 37), 0.95) 100%);
}

/* 浅色主题：简洁干净的顶部栏 */
[data-color-scheme="light"] .app-header {
  background: var(--bg-secondary);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);
}

/* 深色主题：顶部微光效果 */
[data-color-scheme="dark"] .app-header::after {
  content: '';
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  height: 1px;
  background: linear-gradient(90deg, transparent, rgba(var(--accent-rgb, 137, 180, 250), 0.2), transparent);
  pointer-events: none;
}

.header-left,
.header-right {
  display: flex;
  align-items: center;
  gap: 4px;
  -webkit-app-region: no-drag;
}

/* header 按钮尺寸与 hover scale 统一由 main.css 的 .btn-icon-header 变体提供 */

.btn-icon.awakened-active {
  color: var(--brand-vital);
}

.header-center {
  flex: 1;
  display: flex;
  justify-content: center;
  overflow: hidden;
  /* 继承 app-header 的 drag：TabBar 空白区支持按住拖动窗口、双击最大化等系统行为 */
  margin: 0 12px;
  min-width: 0;
}

.app-title {
  font-size: 14px;
  font-weight: 700;
  color: var(--text-primary);
  margin-left: 4px;
  letter-spacing: 0.3px;
  /* line-height: 1 消除行盒额外空间，让文字与同行图标在 flex 垂直居中下严格对齐 */
  line-height: 1;
}

/* 主体 */
.app-body {
  display: flex;
  flex: 1;
  overflow: hidden;
}

/* 侧边栏 */
.sidebar {
  width: var(--sidebar-width);
  background: linear-gradient(180deg, var(--bg-secondary) 0%, var(--bg-tertiary) 100%);
  border-right: 1px solid var(--border-color);
  display: flex;
  flex-direction: column;
  position: relative;
  animation: slideInLeft 0.3s cubic-bezier(0.16, 1, 0.3, 1);
}

@keyframes slideInLeft {
  from {
    opacity: 0;
    transform: translateX(-20px);
  }
  to {
    opacity: 1;
    transform: translateX(0);
  }
}

/* 侧边栏右边缘光效 */
.sidebar::after {
  content: '';
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  width: 1px;
  background: linear-gradient(180deg, transparent, rgba(var(--accent-rgb, 137, 180, 250), 0.15), transparent);
  pointer-events: none;
}

.sidebar-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: var(--header-height);
  padding: 0 12px;
  font-size: 13px;
  font-weight: 700;
  color: var(--text-primary);
  border-bottom: 1px solid var(--border-color);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.sidebar-header .btn-icon {
  width: 22px;
  height: 22px;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 5px;
}

.sidebar-content {
  flex: 1;
  overflow-y: auto;
}

/* 终端区域 */
.terminal-area {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* 每个 Tab 的独立容器 */
.tab-view {
  flex: 1;
  overflow: hidden;
}

.assistant-tab {
  display: flex;
  flex-direction: column;
}

/* Canvas 分割布局 */
.assistant-split {
  display: flex;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.assistant-chat {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 300px;
  overflow: hidden;
  transition: flex-basis 0.3s ease;
}

.assistant-divider {
  flex-shrink: 0;
  width: 4px;
  cursor: col-resize;
  background: transparent;
  transition: background 0.15s;
  z-index: 1;
}

.assistant-divider:hover,
.assistant-divider:active {
  background: var(--accent-color, #4a9eff);
}

.assistant-canvas {
  display: flex;
  flex-basis: 0;
  max-width: 0;
  min-width: 0;
  overflow: hidden;
  opacity: 0;
  transition: flex-basis 0.3s ease, max-width 0.3s ease, opacity 0.25s ease;
}

.assistant-canvas.canvas-open {
  min-width: 200px;
  max-width: 100%;
  opacity: 1;
}


/* 知识库升级进度条 */
.knowledge-upgrade-bar {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  background: var(--bg-secondary);
  border-top: 1px solid var(--border-color);
  z-index: 1000;
}

.upgrade-content {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  font-size: 13px;
  color: var(--text-secondary);
}

.upgrade-icon {
  animation: spin 1s linear infinite;
  color: var(--accent-primary);
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.upgrade-text {
  color: var(--text-primary);
}

.upgrade-filename {
  color: var(--text-tertiary);
  font-size: 12px;
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.upgrade-progress {
  height: 2px;
  background: var(--bg-tertiary);
}

.upgrade-progress-bar {
  height: 100%;
  background: var(--accent-primary);
  transition: width 0.3s ease;
}

/* 进度条动画 */
.slide-down-enter-active,
.slide-down-leave-active {
  transition: transform 0.3s ease, opacity 0.3s ease;
}

.slide-down-enter-from,
.slide-down-leave-to {
  transform: translateY(100%);
  opacity: 0;
}

</style>

