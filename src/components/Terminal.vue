<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import { useConfigStore } from '../stores/config'
import { useTerminalStore, type SplitTarget } from '../stores/terminal'
import SplitTargetPicker from './SplitTargetPicker.vue'
import { getIntegratedTheme } from '../themes'
import { TerminalScreenService, type ScreenContent } from '../services/terminal-screen.service'
import { TerminalSnapshotManager, type TerminalSnapshot, type TerminalDiff } from '../services/terminal-snapshot.service'
import { createLogger } from '../utils/logger'
import { matchAccelerator, formatAccelerator } from '../utils/shortcut'
import '@xterm/xterm/css/xterm.css'

const log = createLogger('Terminal')

// 卡片状态类型定义
export interface CardStatus {
  state: 'pending' | 'running' | 'success' | 'error'
  title: string
  command?: string
  output?: string
  duration?: number
  error?: string
}

const { t } = useI18n()
const isSteamBuild = typeof __STEAM_BUILD__ !== 'undefined' && __STEAM_BUILD__

const props = defineProps<{
  tabId: string
  ptyId: string
  type: 'local' | 'ssh'
  isActive: boolean
}>()

const emit = defineEmits<{
  sendToAi: [text: string]
}>()

const configStore = useConfigStore()
const terminalStore = useTerminalStore()

const terminalRef = ref<HTMLDivElement | null>(null)
let terminal: XTerm | null = null
let fitAddon: FitAddon | null = null
let searchAddon: SearchAddon | null = null
let webglAddon: WebglAddon | null = null
let screenService: TerminalScreenService | null = null
let snapshotManager: TerminalSnapshotManager | null = null
let unsubscribe: (() => void) | null = null
let unsubscribeDisconnect: (() => void) | null = null  // SSH 断开连接事件取消订阅
let unsubscribeCommandExecution: (() => void) | null = null  // Agent 命令执行事件取消订阅
let unsubscribeScreenRequest: (() => void) | null = null  // 主进程屏幕内容请求监听
let unsubscribeVisibleRequest: (() => void) | null = null  // 主进程可视内容请求监听
let unsubscribeAnalysisRequest: (() => void) | null = null  // 主进程屏幕分析请求监听
let resizeObserver: ResizeObserver | null = null
let isDisposed = false
let isPasting = false
let keyDownHandler: ((event: KeyboardEvent) => void) | null = null
let resizeTimeout: ReturnType<typeof setTimeout> | null = null
let dprMediaQuery: MediaQueryList | null = null
let dprChangeHandler: (() => void) | null = null
// 用户输入缓冲区（用于 CWD 追踪）
let inputBuffer = ''

// 拖放视觉指示
const isDragOver = ref(false)

// ============== 命令行高亮功能 ==============
interface CommandHighlight {
  marker: any
  decoration: any
}

// 命令行高亮列表
const commandHighlights: CommandHighlight[] = []

// 是否启用命令行高亮
// 命令高亮开关（从配置读取）
const enableCommandHighlights = computed(() => configStore.terminalSettings.commandHighlight !== false)

// 右键菜单状态
const contextMenu = ref({
  visible: false,
  x: 0,
  y: 0,
  hasSelection: false,
  selectedText: ''
})

// SSH 断开连接状态（用于显示重连按钮）
const sshDisconnected = ref(false)
const isReconnecting = ref(false)

// ============== 实验性功能：终端内嵌卡片 (v2 - 使用 xterm Decoration API) ==============
interface OverlayCard {
  id: string
  element: HTMLElement           // DOM 元素
  marker: any                    // xterm Marker
  decoration: any                // xterm Decoration
  status: CardStatus
  executionId?: string           // 关联的命令执行 ID（用于 Agent 命令）
}

const overlayCards = ref<OverlayCard[]>([])

// 生成唯一卡片ID
let cardIdCounter = 0
const generateCardId = () => `card-${Date.now()}-${cardIdCounter++}`

/** 窗口隐藏/遮挡时暂停光标闪烁，减少空闲重绘 */
const syncCursorBlinkToVisibility = () => {
  if (!terminal) return
  const wantBlink = configStore.terminalSettings.cursorBlink
  terminal.options.cursorBlink =
    document.visibilityState === 'visible' && wantBlink
}

// 初始化终端
onMounted(async () => {
  if (!terminalRef.value) return

  // 获取与 UI 主题融合的终端主题（用 effectiveUiTheme 而非 uiTheme，
  // 跟随系统模式下才会和 UI 一起切换）
  const theme = getIntegratedTheme(configStore.effectiveUiTheme)
  const settings = configStore.terminalSettings

  // 创建终端实例
  terminal = new XTerm({
    theme,
    fontSize: settings.fontSize,
    fontFamily: settings.fontFamily,
    // 不可见时不闪烁，避免后台/遮挡时持续重绘
    cursorBlink: document.visibilityState === 'visible' && settings.cursorBlink,
    cursorStyle: settings.cursorStyle,
    scrollback: settings.scrollback,
    allowProposedApi: true,
    convertEol: true
  })

  document.addEventListener('visibilitychange', syncCursorBlinkToVisibility)

  // 加载插件
  fitAddon = new FitAddon()
  searchAddon = new SearchAddon()
  // 自定义 handler：直接传入 URL 触发 setWindowOpenHandler，避免默认行为先 open() 空窗口导致 macOS 报错
  const webLinksAddon = new WebLinksAddon((_event, uri) => {
    window.open(uri, '_blank')
  })

  terminal.loadAddon(fitAddon)
  terminal.loadAddon(searchAddon)
  terminal.loadAddon(webLinksAddon)

  // 挂载到 DOM
  terminal.open(terminalRef.value)

  // 尝试加载 WebGL 渲染器（GPU 加速）
  // 如果失败则自动降级到默认的 DOM 渲染
  try {
    webglAddon = new WebglAddon()

    // WebGL 上下文丢失后必须 dispose + refresh，否则 canvas 残留黑屏、DOM 渲染器不恢复
    webglAddon.onContextLoss(() => {
      log.warn('WebGL context lost, falling back to DOM renderer')
      try {
        webglAddon?.dispose()
      } catch (e) {
        log.warn('WebGL addon dispose failed:', e)
      }
      webglAddon = null
      try {
        if (terminal) {
          terminal.refresh(0, terminal.rows - 1)
          fitAddon?.fit()
        }
      } catch (e) {
        log.warn('Terminal refresh after WebGL loss failed:', e)
      }
    })

    terminal.loadAddon(webglAddon)
    log.debug('WebGL renderer enabled')
  } catch (e) {
    log.info('WebGL not available, using DOM renderer:', e)
    webglAddon = null
  }

  // 创建屏幕服务实例
  screenService = new TerminalScreenService(terminal)
  
  // 创建快照管理器
  snapshotManager = new TerminalSnapshotManager(screenService)
  
  // 注册屏幕服务和快照管理器到 store（供外部访问）
  // 注意：改为使用 ptyId 注册，以支持分屏模式
  terminalStore.registerScreenService(props.ptyId, screenService)
  terminalStore.registerSnapshotManager(props.ptyId, snapshotManager)

  // 初始化终端状态服务（CWD 追踪等）
  window.electronAPI.terminalState.init(props.ptyId, props.type)
  
  // 监听命令执行事件
  unsubscribeCommandExecution = window.electronAPI.terminalState.onCommandExecution((event) => {
    if (event.execution.terminalId !== props.ptyId) return
    
    const { type } = event
    
    if (type === 'start') {
      // 所有命令统一高亮（用户和 Agent 都一样）
      // Agent 卡片功能暂时关闭，保留底层 API 以后备用
      highlightCommandLine()
    }
    // complete 事件暂不处理（卡片功能关闭）
  })

  // 适配大小 - 使用 setTimeout 确保 DOM 完全渲染和布局完成
  await nextTick()
  setTimeout(async () => {
    if (fitAddon && terminal && terminalRef.value) {
      // 检查容器是否有有效尺寸
      const rect = terminalRef.value.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0) {
        fitAddon.fit()
        // 更新后端 PTY 大小（按 ptyId 直接路由，分屏安全）
        const { cols, rows } = terminal
        await terminalStore.resizePty(props.ptyId, props.type, cols, rows)
        // 注意：这里以前会 terminal.focus()——但 ResizeObserver 在 Agent 改变窗格
        // 布局 / 输出大量内容引发 reflow 时会触发 resize，不该抢用户输入焦点。
        // 焦点切换由 isActive watcher（用户交互/激活窗格变化）独家负责。
      }
    }
  }, 100)

  // 监听用户输入
  if (!terminal) return
  terminal.onData(data => {
    // 直接按本 Terminal 的 ptyId 写——分屏关键：A 输入只能去 A 的 pty，
    // 不能走 store.writeToTerminal(tabId)（那会路由到当前激活窗格）。
    terminalStore.writeToPty(props.ptyId, props.type, data)
    
    // 用户有输入操作时，清除错误提示
    terminalStore.clearError(props.tabId)
    
    // 追踪用户输入（用于 CWD 变化检测）
    // 当用户按下回车时，发送完整命令给终端状态服务
    if (data === '\r' || data === '\n') {
      // 用户按回车 - 无条件高亮当前命令行
      // （上翻历史、粘贴等方式输入的命令不会在 inputBuffer 中）
      highlightCommandLine()
      
      // CWD 追踪（仅当有手动输入时）
      if (inputBuffer.trim()) {
        window.electronAPI.terminalState.handleInput(props.ptyId, inputBuffer)
      }
      inputBuffer = ''
    } else if (data === '\x7f' || data === '\b') {
      // 退格键，删除缓冲区最后一个字符
      inputBuffer = inputBuffer.slice(0, -1)
    } else if (data.length === 1 && data.charCodeAt(0) >= 32) {
      // 普通可打印字符
      inputBuffer += data
    } else if (data.length > 1 && !data.includes('\x1b')) {
      // 粘贴的文本（不包含转义序列）
      // 检查是否包含换行符（用户粘贴了完整命令）
      if (data.includes('\r') || data.includes('\n')) {
        // 提取换行前的内容作为命令
        const lines = data.split(/[\r\n]+/)
        const command = (inputBuffer + lines[0]).trim()
        if (command) {
          window.electronAPI.terminalState.handleInput(props.ptyId, command)
          // 粘贴时需要等待终端渲染完成后再高亮
          setTimeout(() => highlightCommandLine(), 20)
        }
        // 剩余内容作为新的 buffer（处理多行粘贴的情况）
        inputBuffer = lines.slice(1).join('')
      } else {
        inputBuffer += data
      }
    }
  })

  // 处理 Ctrl+C 复制和 Ctrl+Shift+R 重连
  terminal.attachCustomKeyEventHandler((event: KeyboardEvent) => {
    // Ctrl+C 复制选中内容
    if ((event.ctrlKey || event.metaKey) && event.key === 'c' && event.type === 'keydown') {
      const selection = terminal?.getSelection()
      if (selection) {
        navigator.clipboard.writeText(selection)
        return false // 阻止默认行为（不发送 SIGINT）
      }
      // 没有选中内容时，让 Ctrl+C 发送到终端（作为中断信号）
      return true
    }
    // Ctrl+Shift+R SSH 重连
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key === 'R' && event.type === 'keydown') {
      if (props.type === 'ssh' && sshDisconnected.value) {
        handleReconnect()
        return false
      }
    }
    // 分屏快捷键不应被发送到 pty（仅做拦截，分屏动作由 App.vue 全局监听完成）。
    // 拦截范围 = 配置中的三个 split shortcuts，跟着用户改的快捷键走
    if (event.type === 'keydown') {
      const shortcuts = configStore.keyboardShortcuts
      if (
        matchAccelerator(event, shortcuts.splitHorizontal) ||
        matchAccelerator(event, shortcuts.splitVertical) ||
        matchAccelerator(event, shortcuts.closePane)
      ) {
        return false
      }
    }
    return true
  })

  // 处理 Ctrl+V 粘贴 - 监听 DOM 事件
  const handlePaste = async () => {
    if (isPasting || isDisposed || !terminal) return
    isPasting = true

    try {
      const items = await navigator.clipboard.read()
      const hasImage = items.some(item =>
        item.types.some(t => t.startsWith('image/'))
      )
      if (hasImage) {
        // 剪贴板含图片：透传 Ctrl+V 给 pty，让 CLI 进程（如 Claude Code）自行读剪贴板
        terminalStore.writeToPty(props.ptyId, props.type, '\x16')
      } else {
        const text = await navigator.clipboard.readText()
        if (text) {
          terminalStore.writeToPty(props.ptyId, props.type, text)
        }
      }
    } catch (e) {
      // fallback: 尝试纯文本
      try {
        const text = await navigator.clipboard.readText()
        if (text) {
          terminalStore.writeToPty(props.ptyId, props.type, text)
        }
      } catch {
        // clipboard readText also failed — nothing to paste
      }
    } finally {
      setTimeout(() => { isPasting = false }, 200)
    }
  }

  keyDownHandler = (event: KeyboardEvent) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'v') {
      event.preventDefault()
      event.stopPropagation()
      handlePaste()
    }
  }

  if (terminalRef.value) {
    terminalRef.value.addEventListener('keydown', keyDownHandler, true)
  }

  // 订阅后端数据
  if (props.type === 'local') {
    unsubscribe = window.electronAPI.pty.onData(props.ptyId, (data: string) => {
      if (!isDisposed && terminal) {
        try {
          terminal.write(data)
          // 捕获输出用于 AI 分析
          terminalStore.appendOutput(props.tabId, data)
        } catch (e) {
          // 忽略写入错误
        }
      }
    })
  } else {
    unsubscribe = window.electronAPI.ssh.onData(props.ptyId, (data: string) => {
      if (!isDisposed && terminal) {
        try {
          terminal.write(data)
          // 捕获输出用于 AI 分析
          terminalStore.appendOutput(props.tabId, data)
        } catch (e) {
          // 忽略写入错误
        }
      }
    })

    // 监听 SSH 断开连接事件
    unsubscribeDisconnect = window.electronAPI.ssh.onDisconnected(props.ptyId, (event) => {
      if (!isDisposed && terminal) {
        // 更新连接状态
        terminalStore.updateConnectionStatus(props.tabId, false)
        
        // 在终端显示断开连接消息
        const reasonMap: Record<string, string> = {
          'closed': t('terminal.disconnectReasons.closed'),
          'error': t('terminal.disconnectReasons.error'),
          'stream_closed': t('terminal.disconnectReasons.stream_closed'),
          'jump_host_closed': t('terminal.disconnectReasons.jump_host_closed')
        }
        const reasonText = reasonMap[event.reason] || event.reason
        const errorText = event.error ? `: ${event.error}` : ''
        terminal.write(`\r\n\x1b[31m${t('terminal.sshDisconnected')} ${reasonText}${errorText}\x1b[0m\r\n`)
        
        // 检查是否可以重连（有保存的会话 ID）
        const tab = terminalStore.tabs.find(tb => tb.id === props.tabId)
        if (tab?.sshSessionId) {
          // 设置断开状态（用于显示重连按钮）
          sshDisconnected.value = true
          terminal.write(`\x1b[33m${t('terminal.reconnectHint')}\x1b[0m\r\n`)
        } else {
          terminal.write(`\x1b[33m${t('terminal.noSessionSavedHint')}\x1b[0m\r\n`)
        }
      }
    })
  }

  // 监听选中文本变化
  terminal.onSelectionChange(() => {
    if (terminal) {
      const selection = terminal.getSelection()
      terminalStore.updateSelectedText(props.tabId, selection || '')
    }
  })

  // 重新适配终端大小的函数
  const doFit = () => {
    if (resizeTimeout) {
      clearTimeout(resizeTimeout)
    }
    resizeTimeout = setTimeout(() => {
      if (fitAddon && props.isActive && terminal && !isDisposed) {
        fitAddon.fit()
        terminalStore.resizePty(props.ptyId, props.type, terminal.cols, terminal.rows)
      }
    }, 50)
  }

  // 监听窗口大小变化（带防抖，确保最大化等动画完成后再计算）
  resizeObserver = new ResizeObserver(() => {
    doFit()
  })
  resizeObserver.observe(terminalRef.value)

  // 监听 devicePixelRatio 变化（窗口在不同 DPI 显示器间移动时）
  const updateDprListener = () => {
    if (dprMediaQuery && dprChangeHandler) {
      dprMediaQuery.removeEventListener('change', dprChangeHandler)
    }
    dprMediaQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
    dprMediaQuery.addEventListener('change', dprChangeHandler!)
  }

  dprChangeHandler = () => {
    // DPI 变化时重新适配终端
    doFit()
    // 更新监听器以跟踪新的 DPI 值
    updateDprListener()
  }

  updateDprListener()

  // 注册主进程屏幕内容请求监听器
  // 当主进程需要获取准确的终端输出时，会发送请求到渲染进程
  // 先清理旧的监听器，防止热重载时重复注册
  if (unsubscribeScreenRequest) {
    unsubscribeScreenRequest()
    unsubscribeScreenRequest = null
  }
  if (unsubscribeVisibleRequest) {
    unsubscribeVisibleRequest()
    unsubscribeVisibleRequest = null
  }
  if (unsubscribeAnalysisRequest) {
    unsubscribeAnalysisRequest()
    unsubscribeAnalysisRequest = null
  }
  
  unsubscribeScreenRequest = window.electronAPI.screen.onRequestLastNLines((data) => {
    // 检查是否是发给当前终端的请求
    log.debug(`收到获取终端输出请求: requestPtyId=${data.ptyId}, myPtyId=${props.ptyId}, match=${data.ptyId === props.ptyId}`)
    if (data.ptyId === props.ptyId && screenService && !isDisposed) {
      try {
        const lines = screenService.getLastNLines(data.lines)
        log.debug(`终端输出响应: lines=${lines.length}`)
        window.electronAPI.screen.responseLastNLines(data.requestId, lines)
      } catch (e) {
        // 出错时返回 null，让主进程回退到其他方式
        log.error(`获取终端输出异常:`, e)
        window.electronAPI.screen.responseLastNLines(data.requestId, null)
      }
    }
  })

  unsubscribeVisibleRequest = window.electronAPI.screen.onRequestVisibleContent((data) => {
    if (data.ptyId === props.ptyId && screenService && !isDisposed) {
      try {
        const lines = screenService.getVisibleContent()
        window.electronAPI.screen.responseVisibleContent(data.requestId, lines)
      } catch (e) {
        window.electronAPI.screen.responseVisibleContent(data.requestId, null)
      }
    }
  })

  // 注册屏幕分析请求监听器
  // 当主进程（Agent）需要实时获取终端状态分析时调用
  unsubscribeAnalysisRequest = window.electronAPI.screen.onRequestScreenAnalysis((data) => {
    log.debug(`收到屏幕分析请求: requestPtyId=${data.ptyId}, myPtyId=${props.ptyId}, match=${data.ptyId === props.ptyId}`)
    if (data.ptyId === props.ptyId && screenService && !isDisposed) {
      try {
        // 获取完整的终端感知状态（包含输入等待检测、输出模式识别、环境分析）
        const awarenessState = screenService.getAwarenessState()
        // 同时获取可视区域内容
        const visibleContent = screenService.getVisibleContent()
        log.debug(`屏幕分析响应: visibleLines=${visibleContent.length}, context=`, awarenessState.context)
        window.electronAPI.screen.responseScreenAnalysis(data.requestId, {
          ...awarenessState,
          visibleContent
        })
      } catch (e) {
        log.error(`屏幕分析异常:`, e)
        window.electronAPI.screen.responseScreenAnalysis(data.requestId, null)
      }
    }
  })

  // 监听菜单命令事件
  const handleMenuClear = () => {
    if (!props.isActive) return
    terminal?.clear()
  }
  
  const handleMenuSelectAll = () => {
    if (!props.isActive) return
    terminal?.selectAll()
  }
  
  const handleMenuOpenFileManager = () => {
    if (!props.isActive) return
    menuOpenFileManager()
  }
  
  window.addEventListener('menu:clear-terminal', handleMenuClear)
  window.addEventListener('menu:select-all', handleMenuSelectAll)
  window.addEventListener('menu:open-file-manager', handleMenuOpenFileManager)
  
  // 保存事件处理函数以便清理
  ;(window as any).__terminalMenuHandlers = (window as any).__terminalMenuHandlers || {}
  ;(window as any).__terminalMenuHandlers[props.tabId] = {
    clear: handleMenuClear,
    selectAll: handleMenuSelectAll,
    openFileManager: handleMenuOpenFileManager
  }

})

// 清理
onUnmounted(() => {
  // 先标记为已销毁，防止后续回调执行
  isDisposed = true
  
  // 清理选择状态检查的 timeout
  if (selectionCheckTimeout) {
    clearTimeout(selectionCheckTimeout)
    selectionCheckTimeout = null
  }
  
  // 清理菜单事件监听
  const handlers = (window as any).__terminalMenuHandlers?.[props.tabId]
  if (handlers) {
    window.removeEventListener('menu:clear-terminal', handlers.clear)
    window.removeEventListener('menu:select-all', handlers.selectAll)
    window.removeEventListener('menu:open-file-manager', handlers.openFileManager)
    delete (window as any).__terminalMenuHandlers[props.tabId]
  }
  
  // 清理命令执行事件监听
  if (unsubscribeCommandExecution) {
    unsubscribeCommandExecution()
  }
  
  // 清理命令行高亮
  clearCommandHighlights()
  
  if (resizeTimeout) {
    clearTimeout(resizeTimeout)
    resizeTimeout = null
  }
  if (dprMediaQuery && dprChangeHandler) {
    dprMediaQuery.removeEventListener('change', dprChangeHandler)
    dprMediaQuery = null
    dprChangeHandler = null
  }
  if (unsubscribe) {
    unsubscribe()
    unsubscribe = null
  }
  if (unsubscribeDisconnect) {
    unsubscribeDisconnect()
    unsubscribeDisconnect = null
  }
  if (unsubscribeScreenRequest) {
    unsubscribeScreenRequest()
    unsubscribeScreenRequest = null
  }
  if (unsubscribeVisibleRequest) {
    unsubscribeVisibleRequest()
    unsubscribeVisibleRequest = null
  }
  if (unsubscribeAnalysisRequest) {
    unsubscribeAnalysisRequest()
    unsubscribeAnalysisRequest = null
  }
  if (resizeObserver) {
    resizeObserver.disconnect()
    resizeObserver = null
  }
  if (keyDownHandler && terminalRef.value) {
    terminalRef.value.removeEventListener('keydown', keyDownHandler, true)
    keyDownHandler = null
  }
  // 注销屏幕服务和快照管理器
  terminalStore.unregisterScreenService(props.ptyId)
  terminalStore.unregisterSnapshotManager(props.ptyId)
  screenService = null
  snapshotManager = null
  
  // 移除终端状态
  window.electronAPI.terminalState.remove(props.ptyId)
  inputBuffer = ''
  
  document.removeEventListener('visibilitychange', syncCursorBlinkToVisibility)

  // 清理 WebGL 渲染器
  if (webglAddon) {
    webglAddon.dispose()
    webglAddon = null
  }
  
  if (terminal) {
    terminal.dispose()
    terminal = null
  }
  fitAddon = null
  searchAddon = null
})

// 激活/失活切换：active 时 fit + focus；非 active 时 blur 释放焦点
//
// 分屏场景必须显式 blur：多个 Terminal 同时可见时，textarea 焦点决定输入路由，
// 旧窗格不 blur 会导致用户点击新激活窗格但输入仍发到旧窗格的 pty。
watch(
  () => props.isActive,
  async active => {
    if (!terminal) return

    if (active) {
      // 等 DOM 稳定后再 fit/focus（Teleport 搬迁、splitLayout 变化都在 nextTick 内完成）
      await nextTick()
      if (!terminal || !fitAddon || !terminalRef.value) return
      const rect = terminalRef.value.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0) {
        fitAddon.fit()
        terminalStore.resizePty(props.ptyId, props.type, terminal.cols, terminal.rows)
      }
      terminal.focus()
      log.debug(`[focus] pane activated ptyId=${props.ptyId} activeElement=${(document.activeElement as HTMLElement)?.tagName ?? 'null'}`)
    } else {
      terminal.blur()
      log.debug(`[focus] pane blurred ptyId=${props.ptyId}`)
    }
  },
  { immediate: true }
)

// 监听 UI 主题变化，同步更新终端配色（订阅 effectiveUiTheme，
// 这样 mode 切换、系统外观切换都会触发）
watch(
  () => configStore.effectiveUiTheme,
  uiThemeName => {
    if (terminal) {
      const theme = getIntegratedTheme(uiThemeName)
      terminal.options.theme = theme
    }
  }
)

// 监听终端设置变化，动态更新
watch(
  () => configStore.terminalSettings,
  settings => {
    if (terminal) {
      terminal.options.fontSize = settings.fontSize
      terminal.options.fontFamily = settings.fontFamily
      syncCursorBlinkToVisibility()
      terminal.options.cursorStyle = settings.cursorStyle
      // 重新适配大小并刷新显示（字体变化后需要重新计算）
      nextTick(() => {
        if (fitAddon) fitAddon.fit()
        terminal?.refresh(0, terminal.rows - 1)
      })
    }
  },
  { deep: true }
)

// 监听焦点请求（从 AI 助手发送代码到终端后自动聚焦）
// 注意分屏：同一 tab 下有多个 Terminal 实例，必须只让激活窗格响应，
// 否则后 mount 的实例会"赢"焦点，输入会路由到错误窗格。
watch(
  () => terminalStore.pendingFocusTabId,
  (focusTabId) => {
    if (focusTabId !== props.tabId || !terminal) return
    if (!props.isActive) return
    nextTick(() => {
      terminal?.focus()
      terminalStore.clearPendingFocus()
    })
  }
)

// 右键菜单处理
const handleContextMenu = (event: MouseEvent) => {
  event.preventDefault()

  // 右键即视为用户的窗格交互意图，切换 UI 焦点到本窗格。
  // setActivePaneInTab 支持以 ptyId 直接定位窗格（无需先查 paneId）。
  // 注意：这只切前端 UI 焦点（让用户看到高亮 + 后续键盘输入路由到此），
  // 不影响 Agent 的命令路由——Agent 只认它启动时绑定的 ptyId 或 pane_id 参数。
  terminalStore.setActivePaneInTab(props.tabId, props.ptyId)

  const selection = terminal?.getSelection() || ''
  
  // 菜单尺寸估算（5个菜单项 + 2个分隔线 + padding）
  const menuHeight = 220
  const menuWidth = 200
  
  // 计算位置，确保菜单不会超出屏幕边界
  let x = event.clientX
  let y = event.clientY
  
  // 检查右边界
  if (x + menuWidth > window.innerWidth) {
    x = window.innerWidth - menuWidth - 8
  }
  
  // 检查下边界：如果菜单会超出底部，则向上显示
  if (y + menuHeight > window.innerHeight) {
    y = window.innerHeight - menuHeight - 8
  }
  
  // 确保不会超出顶部或左侧
  x = Math.max(8, x)
  y = Math.max(8, y)
  
  contextMenu.value = {
    visible: true,
    x,
    y,
    hasSelection: selection.length > 0,
    selectedText: selection
  }
}

const hideContextMenu = () => {
  contextMenu.value.visible = false
  // 让终端重新获得焦点
  nextTick(() => {
    terminal?.focus()
  })
}

// 鼠标按下：先于 xterm 在捕获阶段切换激活窗格（兜底）。
//
// 普通文本输出时 click 事件会冒泡到外层 SplitPaneView 触发 handlePaneClick；
// 但 top / vim / htop 等开启 mouse tracking 的 alt-screen 应用会让 xterm.js
// 直接消费鼠标事件转成 ESC 序列发回 PTY，click 不再冒泡——用户感受就是
// "点 top 输出区域无法激活窗格，必须点旁边"。
// 这里用 .capture 在 xterm 拿到事件之前先激活，xterm 后续做什么都不影响。
const handleTerminalMouseDown = () => {
  if (props.isActive) return
  terminalStore.setActivePaneInTab(props.tabId, props.ptyId)
}

// 处理终端点击 - 修复 cmd+a 全选后点击不清除选中状态的问题
// xterm.js 的 onSelectionChange 在 selectAll() 后点击取消选择时可能不触发
let selectionCheckTimeout: ReturnType<typeof setTimeout> | null = null
const handleTerminalClick = () => {
  hideContextMenu()
  // 防抖：清除之前的检查，避免快速连续点击时累积
  if (selectionCheckTimeout) {
    clearTimeout(selectionCheckTimeout)
  }
  // 延迟检查选择状态，确保 xterm.js 内部状态已更新
  selectionCheckTimeout = setTimeout(() => {
    selectionCheckTimeout = null
    // 检查组件是否已销毁
    if (!isDisposed && terminal) {
      const selection = terminal.getSelection()
      terminalStore.updateSelectedText(props.tabId, selection || '')
    }
  }, 10)
}

const menuCopy = async () => {
  if (contextMenu.value.selectedText) {
    await navigator.clipboard.writeText(contextMenu.value.selectedText)
  }
  hideContextMenu()
}

const menuPaste = async () => {
  try {
    const text = await navigator.clipboard.readText()
    if (text) {
      terminalStore.writeToPty(props.ptyId, props.type, text)
    }
  } catch (e) {
    // 忽略错误
  }
  hideContextMenu()
}

const menuSendToAi = () => {
  if (contextMenu.value.selectedText) {
    emit('sendToAi', contextMenu.value.selectedText)
  }
  hideContextMenu()
}

// ============== 拖放文件到终端 ==============
const handleDragOver = (e: DragEvent) => {
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
}

const handleDragEnter = () => {
  isDragOver.value = true
}

const handleDragLeave = (e: DragEvent) => {
  if (e.currentTarget && !(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) {
    isDragOver.value = false
  }
}

const handleDrop = (e: DragEvent) => {
  isDragOver.value = false
  const files = e.dataTransfer?.files
  if (!files?.length) return

  const paths: string[] = []
  for (const file of files) {
    const filePath = window.electronAPI.fileUtils.getPathForFile(file)
    if (filePath) {
      paths.push(filePath.includes(' ') ? `"${filePath}"` : filePath)
    }
  }
  if (paths.length > 0) {
    terminalStore.writeToPty(props.ptyId, props.type, paths.join(' '))
  }
}

const menuClear = () => {
  terminal?.clear()
  hideContextMenu()
}

const menuSplitHorizontal = async () => {
  hideContextMenu()
  await terminalStore.splitTerminal('horizontal')
}

const menuSplitVertical = async () => {
  hideContextMenu()
  await terminalStore.splitTerminal('vertical')
}

// 分屏目标选择器（"分屏并连接到..." 入口）：
// 默认行为（左右/上下分屏菜单）继续直接复用激活窗格的连接，不打断现有用户习惯；
// 想换连接源时再走这条路径，明确选择本地或某个 SSH 会话。
const splitPickerVisible = ref(false)
const splitPickerDefaultDirection = ref<'horizontal' | 'vertical'>('horizontal')

const menuSplitConnectTo = () => {
  hideContextMenu()
  splitPickerDefaultDirection.value = 'horizontal'
  splitPickerVisible.value = true
}

const handlePickerConfirm = async (
  direction: 'horizontal' | 'vertical',
  target: SplitTarget
) => {
  splitPickerVisible.value = false
  await terminalStore.splitTerminal(direction, target)
}

const handlePickerCancel = () => {
  splitPickerVisible.value = false
}

const menuClosePane = async () => {
  hideContextMenu()
  const tab = terminalStore.tabs.find(t => t.id === props.tabId)
  if (!tab || !terminalStore.isSplitTab(tab) || !tab.splitLayout) return
  // 找到本 Terminal 所在窗格 id：通过 ptyId 在分屏布局中查
  const findPaneIdByPty = (node: import('../stores/terminal').SplitPane): string | null => {
    if (node.type === 'terminal') return node.ptyId === props.ptyId ? node.id : null
    for (const c of node.children || []) {
      const r = findPaneIdByPty(c)
      if (r) return r
    }
    return null
  }
  const paneId = findPaneIdByPty(tab.splitLayout)
  if (paneId) {
    await terminalStore.closePane(tab.id, paneId)
  }
}

const isCurrentTabSplit = computed(() => {
  const tab = terminalStore.tabs.find(t => t.id === props.tabId)
  return tab ? terminalStore.isSplitTab(tab) : false
})

// 跟随 configStore.keyboardShortcuts 实时变化——用户在设置面板里改了 split 快捷键，
// 右键菜单里显示的提示也会立刻同步
const splitHorizontalShortcut = computed(() => formatAccelerator(configStore.keyboardShortcuts.splitHorizontal))
const splitVerticalShortcut = computed(() => formatAccelerator(configStore.keyboardShortcuts.splitVertical))
const closePaneShortcut = computed(() => formatAccelerator(configStore.keyboardShortcuts.closePane))

// 打开文件管理器
const menuOpenFileManager = async () => {
  hideContextMenu()
  
  try {
    // 获取当前工作目录（使用 refreshCwd 强制刷新，确保获取最新的 CWD）
    const cwd = await window.electronAPI.terminalState.refreshCwd(props.ptyId)
    
    log.debug(`menuOpenFileManager: type=${props.type}, ptyId=${props.ptyId}, cwd=${cwd}`)
    
    if (props.type === 'local') {
      // 本地终端：只传入本地路径
      await window.electronAPI.fileManager.open({
        initialLocalPath: cwd || undefined
      })
    } else {
      // SSH 终端：需要 SFTP 配置和远程路径
      const tab = terminalStore.tabs.find(t => t.id === props.tabId)
      if (!tab?.sshSessionId) {
        // 没有保存的会话 ID，尝试使用基本的 SSH 配置
        if (tab?.sshConfig) {
          await window.electronAPI.fileManager.open({
            sftpConfig: {
              host: tab.sshConfig.host,
              port: tab.sshConfig.port,
              username: tab.sshConfig.username
            },
            initialRemotePath: cwd || undefined
          })
        }
        return
      }
      
      // 从 configStore 获取完整的会话配置
      const session = configStore.sshSessions.find(s => s.id === tab.sshSessionId)
      if (session) {
        await window.electronAPI.fileManager.open({
          sessionId: session.id,
          sftpConfig: {
            host: session.host,
            port: session.port,
            username: session.username,
            password: session.password,
            privateKeyPath: session.privateKeyPath,
            passphrase: session.passphrase
          },
          initialRemotePath: cwd || undefined
        })
      }
    }
  } catch (error) {
    log.error('Failed to open file manager:', error)
  }
}

// SSH 重新连接
const handleReconnect = async () => {
  if (props.type !== 'ssh' || isReconnecting.value) return
  
  isReconnecting.value = true
  
  try {
    // 在终端显示正在重连的消息
    terminal?.write(`\r\n\x1b[36m[${t('terminal.reconnecting')}]\x1b[0m\r\n`)
    
    // 调用 store 的重连方法（多屏下传当前窗格的 ptyId，让 store 只重连这一个窗格，
    // 不影响 tab 内其他 SSH 连接 / active 窗格）
    const result = await terminalStore.reconnectSsh(props.tabId, props.ptyId)
    
    // 如果会话未保存，无法重连
    if (result.needsSession) {
      terminal?.write(`\r\n\x1b[33m[${t('terminal.cannotReconnect')}] ${t('terminal.cannotReconnectHint')}\x1b[0m\r\n`)
      // 隐藏重连按钮（无法重连）
      sshDisconnected.value = false
      return
    }
    
    if (!result.success) {
      terminal?.write(`\r\n\x1b[31m[${t('terminal.reconnectFailed')}]\x1b[0m\r\n`)
      return
    }
    
    // 重连成功，清除断开状态
    sshDisconnected.value = false
    
    // 在终端显示成功消息
    terminal?.write(`\r\n\x1b[32m[连接成功]\x1b[0m\r\n`)
    
    // 重新订阅数据
    if (unsubscribe) {
      unsubscribe()
    }
    const tab = terminalStore.tabs.find(t => t.id === props.tabId)
    if (tab?.ptyId) {
      unsubscribe = window.electronAPI.ssh.onData(tab.ptyId, (data: string) => {
        if (!isDisposed && terminal) {
          try {
            terminal.write(data)
            terminalStore.appendOutput(props.tabId, data)
          } catch (e) {
            // 忽略写入错误
          }
        }
      })
      
      // 重新订阅断开事件
      if (unsubscribeDisconnect) {
        unsubscribeDisconnect()
      }
      unsubscribeDisconnect = window.electronAPI.ssh.onDisconnected(tab.ptyId, (event) => {
        if (!isDisposed && terminal) {
          terminalStore.updateConnectionStatus(props.tabId, false)
          sshDisconnected.value = true
          const reasonKey = `terminal.disconnectReasons.${event.reason}`
          const reasonText = t(reasonKey) || event.reason
          const errorText = event.error ? `: ${event.error}` : ''
          terminal.write(`\r\n\x1b[31m${t('terminal.sshDisconnected')} ${reasonText}${errorText}\x1b[0m\r\n`)
          terminal.write(`\x1b[33m${t('terminal.reconnectHint')}\x1b[0m\r\n`)
        }
      })
      
      // 重新调整终端大小
      if (fitAddon && terminal) {
        fitAddon.fit()
        await terminalStore.resizePty(props.ptyId, props.type, terminal.cols, terminal.rows)
      }
    }
  } catch (error) {
    // 在终端显示错误消息
    const errorMsg = error instanceof Error ? error.message : t('ai.unknownError')
    terminal?.write(`\r\n\x1b[31m[${t('terminal.reconnectFailed')}] ${errorMsg}\x1b[0m\r\n`)
    terminal?.write(`\x1b[33m${t('terminal.reconnectHint')}\x1b[0m\r\n`)
  } finally {
    isReconnecting.value = false
  }
}

// ============== 命令行高亮功能实现 ==============

/**
 * 高亮当前命令行
 * 使用 xterm Decoration API 给命令行添加背景色，方便区分命令和输出
 */
const highlightCommandLine = () => {
  if (!terminal || !enableCommandHighlights.value) return
  
  // 在当前行创建 marker
  const marker = terminal.registerMarker(0)
  if (!marker) return
  
    // 注册装饰器
  const decoration = terminal.registerDecoration({
    marker,
    anchor: 'left'
  })
  
  if (!decoration) {
    marker.dispose()
    return
  }
  
  let rendered = false
  
  // 设置渲染回调 - 添加命令行高亮背景
  decoration.onRender((container: HTMLElement) => {
    if (rendered) return
    rendered = true
    
    // 设置容器样式
    container.style.overflow = 'visible'
    container.style.pointerEvents = 'none'
    container.style.zIndex = '5'
    container.style.width = '100%'
    container.style.position = 'absolute'
    container.style.left = '0'
    
    // 创建高亮背景元素
    const highlight = document.createElement('div')
    highlight.className = 'cmd-highlight'
    
    // 获取 xterm 实际行高（通过内部 API 或计算）
    const cellHeight = (terminal as any)?._core?._renderService?.dimensions?.css?.cell?.height
    const fontSize = terminal?.options.fontSize || 14
    // 优先使用 xterm 内部行高，否则用字体大小估算（lineHeight 约 1.0）
    const lineHeight = cellHeight || fontSize
    highlight.style.height = `${lineHeight}px`
    
    container.appendChild(highlight)
  })
  
  commandHighlights.push({ marker, decoration })
  
  // 限制数量（保留最近 100 个）
  while (commandHighlights.length > 100) {
    const old = commandHighlights.shift()
    old?.decoration?.dispose()
    old?.marker?.dispose()
  }
}

/**
 * 清除所有命令行高亮
 */
const clearCommandHighlights = () => {
  for (const hl of commandHighlights) {
    hl.decoration?.dispose()
    hl.marker?.dispose()
  }
  commandHighlights.length = 0
}

// ============== 实验性功能：卡片管理方法 (v2 - xterm Decoration API) ==============

/**
 * 创建卡片 DOM 元素
 */
const createCardElement = (status: CardStatus): HTMLElement => {
  const el = document.createElement('div')
  el.className = 'xterm-overlay-card'
  // 紧凑样式 - 浮动在命令行右侧
  el.style.cssText = `
    display: inline-flex !important;
    align-items: center;
    gap: 8px;
    visibility: visible !important;
    background: rgba(30, 30, 30, 0.95);
    border-radius: 4px;
    font-size: 11px;
    color: #e0e0e0;
    padding: 4px 10px;
    margin: 0;
    box-shadow: 0 2px 8px rgba(0,0,0,0.4);
    white-space: nowrap;
    backdrop-filter: blur(4px);
    border-left: 3px solid #3794ff;
  `
  updateCardElement(el, status)
  return el
}

/**
 * 更新卡片 DOM 元素内容
 */
const updateCardElement = (el: HTMLElement, status: CardStatus) => {
  const stateIcons: Record<string, string> = {
    pending: '⏳',
    running: '⚡',
    success: '✓',
    error: '✗'
  }
  
  const stateColors: Record<string, string> = {
    pending: '#888',
    running: '#3794ff',
    success: '#4ec9b0',
    error: '#f14c4c'
  }
  
  const duration = status.duration 
    ? (status.duration < 1000 ? `${status.duration}ms` : `${(status.duration / 1000).toFixed(1)}s`)
    : ''
  
  // 更新边框颜色
  el.style.borderLeftColor = stateColors[status.state]
  
  // 紧凑布局：图标 + 命令片段 + 时间 + 关闭按钮
  const shortCommand = status.command 
    ? (status.command.length > 30 ? status.command.slice(0, 30) + '...' : status.command)
    : ''
  
  el.innerHTML = `
    <span class="status-icon" style="font-size: 12px;">${stateIcons[status.state]}</span>
    <span class="cmd-text" style="color: #aaa; font-family: monospace;">${shortCommand}</span>
    ${duration ? `<span class="duration" style="color: #888; margin-left: 4px;">${duration}</span>` : ''}
    <button class="close-btn" data-action="close" style="
      background: none;
      border: none;
      color: #666;
      cursor: pointer;
      font-size: 14px;
      padding: 0 2px;
      margin-left: 4px;
    ">×</button>
  `
}

/**
 * 在终端当前位置创建一个覆盖卡片（使用 xterm Decoration API）
 * 
 * @param title 卡片标题
 * @param command 命令内容
 * @param lineOffset 相对于当前行的偏移（负数=向上，0=当前行）
 */
const createOverlayCard = (title: string, command?: string, lineOffset = 0): string | null => {
  if (!terminal) return null

  const cardId = generateCardId()
  const status: CardStatus = { state: 'pending', title, command }
  
  // 创建 Marker（标记在当前光标位置，可以偏移）
  const marker = terminal.registerMarker(lineOffset)
  if (!marker) {
    return null
  }
  
  // 创建卡片 DOM 元素
  const element = createCardElement(status)
  
  // 绑定关闭事件
  element.addEventListener('click', (e) => {
    const target = e.target as HTMLElement
    if (target.dataset.action === 'close') {
      removeCard(cardId)
    }
  })
  
  // 使用 xterm Decoration API（自动处理滚动同步）
  const decoration = terminal.registerDecoration({
    marker,
    anchor: 'left'  // 锚定在左侧
  })
  
  if (!decoration) {
    marker.dispose()
    return null
  }
  
  // 当 decoration 渲染时，手动添加我们的元素到容器
  decoration.onRender((container: HTMLElement) => {
    // 手动添加卡片元素
    if (!container.contains(element)) {
      container.appendChild(element)
    }
    
    // 设置容器样式 - 紧凑模式，不占用空间
    container.style.position = 'absolute'
    container.style.zIndex = '100'
    container.style.overflow = 'visible'
    container.style.pointerEvents = 'auto'
    container.style.background = 'transparent'
    container.style.width = 'auto'
    container.style.maxWidth = '400px'
    container.style.right = '8px'  // 靠右显示
    container.style.left = 'auto'
  })
  
  const card: OverlayCard = {
    id: cardId,
    element,
    marker,
    decoration,
    status
  }
  
  overlayCards.value.push(card)
  
  return cardId
}

/**
 * 更新卡片状态
 */
const updateCardStatus = (cardId: string, updates: Partial<CardStatus>) => {
  const card = overlayCards.value.find(c => c.id === cardId)
  if (card) {
    card.status = { ...card.status, ...updates }
    // 更新 DOM
    updateCardElement(card.element, card.status)
  }
}

/**
 * 移除卡片
 */
const removeCard = (cardId: string) => {
  const index = overlayCards.value.findIndex(c => c.id === cardId)
  if (index !== -1) {
    const card = overlayCards.value[index]
    // 清理 xterm 资源
    card.decoration?.dispose()
    card.marker?.dispose()
    overlayCards.value.splice(index, 1)
  }
}

/**
 * 清除所有卡片
 */
const clearAllCards = () => {
  for (const card of overlayCards.value) {
    card.decoration?.dispose()
    card.marker?.dispose()
  }
  overlayCards.value = []
}

/**
 * 执行带卡片UI的命令
 * 
 * @param command 要执行的命令
 * @param title 卡片标题
 * @param options 可选配置
 */
const executeWithCard = async (
  command: string, 
  title: string,
  options?: {
    timeout?: number      // 超时时间（ms），默认 30000
    captureOutput?: boolean  // 是否捕获输出
  }
): Promise<{ success: boolean; output?: string; duration: number }> => {
  if (!terminal || !screenService) {
    return { success: false, duration: 0 }
  }
  
  const timeout = options?.timeout ?? 30000
  const captureOutput = options?.captureOutput ?? true
  
  // 创建卡片
  const cardId = createOverlayCard(title, command, 4)
  if (!cardId) {
    return { success: false, duration: 0 }
  }
  
  const startTime = Date.now()
  
  // 更新状态为运行中
  updateCardStatus(cardId, { state: 'running' })
  
  // 发送命令到终端（按本 Terminal 的 ptyId 直接路由，分屏安全）
  terminalStore.writeToPty(props.ptyId, props.type, command + '\r')
  
  // 等待命令完成（通过检测是否回到 prompt）
  return new Promise((resolve) => {
    let checkCount = 0
    const maxChecks = Math.ceil(timeout / 200)  // 每 200ms 检查一次
    
    const checkCompletion = () => {
      checkCount++
      const duration = Date.now() - startTime
      
      // 检查是否回到 prompt（命令完成）
      const awarenessState = screenService!.getAwarenessState()
      const isComplete = awarenessState.input.type === 'prompt' && 
                         awarenessState.input.isWaiting &&
                         duration > 300  // 至少等 300ms，避免检测到执行前的 prompt
      
      if (isComplete) {
        // 命令完成，获取输出
        let output = ''
        if (captureOutput) {
          const afterLines = screenService!.getLastNLines(20)
          // 简单提取新增的输出（跳过命令行本身）
          output = afterLines
            .filter(line => !line.includes(command) && line.trim())
            .slice(0, 5)
            .join('\n')
        }
        
        // 检查是否有错误
        const errors = screenService!.detectErrors(10)
        const hasError = errors.length > 0
        
        updateCardStatus(cardId, {
          state: hasError ? 'error' : 'success',
          duration,
          output: hasError ? errors[0].content : (output || t('terminal.commandDone')),
          error: hasError ? errors[0].content : undefined
        })
        
        resolve({ success: !hasError, output, duration })
        return
      }
      
      // 超时检查
      if (checkCount >= maxChecks) {
        updateCardStatus(cardId, {
          state: 'error',
          duration,
          error: t('terminal.commandTimeout', { seconds: timeout / 1000 })
        })
        resolve({ success: false, duration })
        return
      }
      
      // 继续检查
      setTimeout(checkCompletion, 200)
    }
    
    // 延迟开始检查，给命令一点执行时间
    setTimeout(checkCompletion, 300)
  })
}


// 暴露方法供外部调用
defineExpose({
  focus: () => terminal?.focus(),
  search: (text: string) => searchAddon?.findNext(text),
  clear: () => terminal?.clear(),
  // 屏幕内容读取方法
  getScreenContent: (): ScreenContent | null => screenService?.getScreenContent() ?? null,
  getVisibleContent: (): string[] => screenService?.getVisibleContent() ?? [],
  getLastNLines: (n: number): string[] => screenService?.getLastNLines(n) ?? [],
  getCursorPosition: () => screenService?.getCursorPosition() ?? { x: 0, y: 0 },
  getCurrentLine: () => screenService?.getCurrentLine() ?? '',
  isAtPrompt: () => screenService?.isAtPrompt() ?? false,
  detectErrors: (maxLines?: number) => screenService?.detectErrors(maxLines) ?? [],
  // 快照相关方法
  createSnapshot: (name?: string): TerminalSnapshot | null => snapshotManager?.createSnapshot(name) ?? null,
  getSnapshot: (name: string): TerminalSnapshot | undefined => snapshotManager?.getSnapshot(name),
  snapshotAndCompare: (): { snapshot: TerminalSnapshot; diff: TerminalDiff | null } | null => 
    snapshotManager?.snapshotAndCompare() ?? null,
  hasContentChanged: (): boolean => snapshotManager?.hasContentChanged() ?? true,
  getNewOutputSinceLastSnapshot: (): string[] => snapshotManager?.getNewOutputSinceLastSnapshot() ?? [],
  // 实验性功能：覆盖卡片 API
  createOverlayCard,
  updateCardStatus,
  removeCard,
  clearAllCards,
  executeWithCard
})
</script>

<template>
  <div
    class="terminal-wrapper"
    @mousedown.capture="handleTerminalMouseDown"
    @contextmenu="handleContextMenu"
    @click="handleTerminalClick"
    @dragover.prevent="handleDragOver"
    @drop.prevent="handleDrop"
    @dragenter="handleDragEnter"
    @dragleave="handleDragLeave"
  >
    <div ref="terminalRef" class="terminal-inner"></div>
    <div v-if="isDragOver" class="drop-overlay">{{ t('terminal.dropFiles') }}</div>
    
    <!-- 卡片现在由 xterm Decoration API 直接渲染到终端内部 -->
    
    <!-- SSH 重连按钮 -->
    <div 
      v-if="type === 'ssh' && sshDisconnected" 
      class="reconnect-overlay"
    >
      <button 
        class="reconnect-btn"
        :disabled="isReconnecting"
        @click="handleReconnect"
      >
        <span v-if="isReconnecting" class="reconnect-spinner">⟳</span>
        <span v-else>🔌</span>
        {{ isReconnecting ? t('terminal.reconnecting') : t('terminal.reconnect') }}
      </button>
    </div>
  </div>
  
  <!-- 右键菜单 -->
  <Teleport to="body">
    <div 
      v-if="contextMenu.visible" 
      class="context-menu"
      :style="{ left: contextMenu.x + 'px', top: contextMenu.y + 'px' }"
      @click.stop
    >
      <template v-if="!isSteamBuild">
        <div 
          class="menu-item"
          :class="{ disabled: !contextMenu.hasSelection }"
          @click="contextMenu.hasSelection && menuSendToAi()"
        >
          <span class="menu-icon">🤖</span>
          <span>{{ t('terminal.contextMenu.sendToAi') }}</span>
        </div>
        <div class="menu-divider"></div>
      </template>
      <div 
        class="menu-item" 
        :class="{ disabled: !contextMenu.hasSelection }"
        @click="contextMenu.hasSelection && menuCopy()"
      >
        <span class="menu-icon">📋</span>
        <span>{{ t('terminal.contextMenu.copy') }}</span>
        <span class="shortcut">Ctrl+C</span>
      </div>
      <div class="menu-item" @click="menuPaste()">
        <span class="menu-icon">📄</span>
        <span>{{ t('terminal.contextMenu.paste') }}</span>
        <span class="shortcut">Ctrl+V</span>
      </div>
      <div class="menu-divider"></div>
      <div class="menu-item" @click="menuClear()">
        <span class="menu-icon">🗑️</span>
        <span>{{ t('terminal.contextMenu.clear') }}</span>
      </div>
      <div class="menu-item" @click="menuOpenFileManager()">
        <span class="menu-icon">📁</span>
        <span>{{ t('terminal.contextMenu.openFileManager') }}</span>
      </div>
      <div class="menu-divider"></div>
      <div class="menu-item" @click="menuSplitHorizontal()">
        <span class="menu-icon">▬</span>
        <span>{{ t('terminal.split.menu.horizontal') }}</span>
        <span class="shortcut">{{ splitHorizontalShortcut }}</span>
      </div>
      <div class="menu-item" @click="menuSplitVertical()">
        <span class="menu-icon">▮</span>
        <span>{{ t('terminal.split.menu.vertical') }}</span>
        <span class="shortcut">{{ splitVerticalShortcut }}</span>
      </div>
      <div class="menu-item" @click="menuSplitConnectTo()">
        <span class="menu-icon">🌐</span>
        <span>{{ t('terminal.split.menu.connectTo') }}</span>
      </div>
      <div v-if="isCurrentTabSplit" class="menu-item danger" @click="menuClosePane()">
        <span class="menu-icon">✕</span>
        <span>{{ t('terminal.split.menu.close') }}</span>
        <span class="shortcut">{{ closePaneShortcut }}</span>
      </div>
    </div>
    <div 
      v-if="contextMenu.visible" 
      class="context-menu-overlay" 
      @click="hideContextMenu"
    ></div>
  </Teleport>

  <SplitTargetPicker
    :visible="splitPickerVisible"
    :default-direction="splitPickerDefaultDirection"
    @confirm="handlePickerConfirm"
    @cancel="handlePickerCancel"
  />
</template>

<style scoped>
.terminal-wrapper {
  position: relative;
  width: 100%;
  height: 100%;
  /* 4px padding 给 xterm 内容一圈呼吸感；显式 bg = bg-primary 保证这 4px
     与 xterm 内部 background（已在 themes/index.ts 中对齐 bg-primary）
     完全同色，避免浅色主题下透显 app-container 出现亮缝。 */
  padding: 4px;
  background: var(--bg-primary);
  box-sizing: border-box;
  overflow: hidden;
}

.terminal-inner {
  width: 100%;
  height: 100%;
  overflow: hidden;
}

.drop-overlay {
  position: absolute;
  inset: 0;
  background: rgba(100, 150, 255, 0.08);
  border: 2px dashed var(--accent-primary);
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  color: var(--text-secondary);
  pointer-events: none;
  z-index: 10;
}

.terminal-inner :deep(.xterm) {
  height: 100% !important;
}

.terminal-inner :deep(.xterm-viewport) {
  overflow-y: auto !important;
}

/* 右键菜单遮罩层 */
.context-menu-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 999;
}

/* 右键菜单 */
.context-menu {
  position: fixed;
  z-index: 1000;
  min-width: 180px;
  background: var(--bg-secondary, #2d2d30);
  border: 1px solid var(--border-color, #404040);
  border-radius: 6px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
  padding: 4px 0;
  font-size: 13px;
}

.menu-item {
  display: flex;
  align-items: center;
  padding: 8px 12px;
  cursor: pointer;
  color: var(--text-primary, #e0e0e0);
  transition: background-color 0.15s;
}

.menu-item:hover:not(.disabled) {
  background: var(--bg-hover, #094771);
}

.menu-item.disabled {
  color: var(--text-disabled, #6e6e6e);
  cursor: not-allowed;
}

.menu-icon {
  width: 20px;
  margin-right: 8px;
  font-size: 14px;
}

.shortcut {
  margin-left: auto;
  color: var(--text-secondary, #888);
  font-size: 11px;
}

.menu-divider {
  height: 1px;
  background: var(--border-color, #404040);
  margin: 4px 0;
}

/* SSH 重连按钮 */
.reconnect-overlay {
  position: absolute;
  bottom: 16px;
  right: 16px;
  z-index: 10;
}

.reconnect-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  background: var(--bg-accent, #094771);
  color: var(--text-primary, #fff);
  border: 1px solid var(--border-color, #404040);
  border-radius: 6px;
  font-size: 13px;
  cursor: pointer;
  transition: all 0.2s ease;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
}

.reconnect-btn:hover:not(:disabled) {
  background: var(--bg-hover, #0d5a8c);
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
}

.reconnect-btn:active:not(:disabled) {
  transform: translateY(0);
}

.reconnect-btn:disabled {
  opacity: 0.7;
  cursor: not-allowed;
}

.reconnect-spinner {
  display: inline-block;
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

/* ============== xterm Decoration 容器样式 ============== */
.terminal-inner :deep(.xterm-decoration) {
  overflow: visible !important;
  z-index: 100 !important;
  pointer-events: auto !important;
}

/* ============== xterm Decoration 卡片样式 (使用 :deep 穿透) ============== */
.terminal-inner :deep(.xterm-overlay-card) {
  background: rgba(30, 30, 30, 0.95);
  border: 1px solid #404040;
  border-radius: 6px;
  font-family: var(--font-mono, 'SF Mono', Monaco, 'Cascadia Code', monospace);
  font-size: 12px;
  overflow: hidden;
  backdrop-filter: blur(4px);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
  margin: 2px 8px;
}

.terminal-inner :deep(.xterm-overlay-card.status-pending) {
  border-left: 3px solid #888;
}

.terminal-inner :deep(.xterm-overlay-card.status-running) {
  border-left: 3px solid #3794ff;
}

.terminal-inner :deep(.xterm-overlay-card.status-success) {
  border-left: 3px solid #4ec9b0;
}

.terminal-inner :deep(.xterm-overlay-card.status-error) {
  border-left: 3px solid #f14c4c;
}

.terminal-inner :deep(.xterm-overlay-card .card-header) {
  display: flex;
  align-items: center;
  padding: 6px 10px;
  background: rgba(255, 255, 255, 0.03);
  border-bottom: 1px solid #333;
  gap: 8px;
}

.terminal-inner :deep(.xterm-overlay-card .status-icon) {
  font-size: 14px;
}

.terminal-inner :deep(.xterm-overlay-card.status-running .status-icon) {
  animation: spin 1s linear infinite;
}

.terminal-inner :deep(.xterm-overlay-card .card-title) {
  flex: 1;
  color: #e0e0e0;
  font-weight: 500;
}

.terminal-inner :deep(.xterm-overlay-card .duration) {
  color: #888;
  font-size: 11px;
}

.terminal-inner :deep(.xterm-overlay-card .close-btn) {
  background: none;
  border: none;
  color: #888;
  cursor: pointer;
  font-size: 16px;
  line-height: 1;
  padding: 0 4px;
}

.terminal-inner :deep(.xterm-overlay-card .close-btn:hover) {
  color: #fff;
}

.terminal-inner :deep(.xterm-overlay-card .command-line) {
  padding: 6px 10px;
  background: rgba(0, 0, 0, 0.2);
  display: flex;
  align-items: center;
  gap: 8px;
}

.terminal-inner :deep(.xterm-overlay-card .prompt) {
  color: #4ec9b0;
  font-weight: bold;
}

.terminal-inner :deep(.xterm-overlay-card .command-line code) {
  color: #dcdcaa;
}

.terminal-inner :deep(.xterm-overlay-card .card-body) {
  padding: 6px 10px;
  max-height: 40px;
  overflow: auto;
}

.terminal-inner :deep(.xterm-overlay-card .output-text) {
  color: #888;
  font-size: 11px;
  white-space: pre-wrap;
}

.terminal-inner :deep(.xterm-overlay-card .error-text) {
  color: #f14c4c;
  font-size: 11px;
}

/* ============== 命令行高亮样式 ============== */
.terminal-inner :deep(.cmd-highlight) {
  position: absolute;
  top: -1px;
  left: 0;
  right: 0;
  width: 100vw;
  max-width: 100%;
  /* height 由 JavaScript 动态设置 */
  background: linear-gradient(
    90deg,
    color-mix(in srgb, var(--accent-primary, #4299e1) 8%, transparent) 0%,
    color-mix(in srgb, var(--accent-primary, #4299e1) 22%, transparent) 100%
  );
  border-right: 3px solid color-mix(in srgb, var(--accent-primary, #4299e1) 70%, transparent);
  border-radius: 2px;
  pointer-events: none;
  animation: highlightFadeIn 0.3s ease-out;
}

@keyframes highlightFadeIn {
  from {
    opacity: 0;
    transform: translateX(10px);
  }
  to {
    opacity: 1;
    transform: translateX(0);
  }
}

/* 深色主题 - 稍微调亮 */
[data-color-scheme="dark"] .terminal-inner :deep(.cmd-highlight) {
  background: linear-gradient(
    90deg,
    color-mix(in srgb, var(--accent-primary, #4299e1) 6%, transparent) 0%,
    color-mix(in srgb, var(--accent-primary, #4299e1) 20%, transparent) 100%
  );
}

/* 浅色主题 - 稍微调深 */
[data-color-scheme="light"] .terminal-inner :deep(.cmd-highlight) {
  background: linear-gradient(
    90deg,
    color-mix(in srgb, var(--accent-primary, #4299e1) 10%, transparent) 0%,
    color-mix(in srgb, var(--accent-primary, #4299e1) 25%, transparent) 100%
  );
}
</style>

