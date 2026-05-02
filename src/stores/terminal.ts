import { defineStore } from 'pinia'
import { ref, computed, watch, toRaw } from 'vue'
import { v4 as uuidv4 } from 'uuid'
import stripAnsiLib from 'strip-ansi'
import i18n from '../i18n'
import type { JumpHostConfig } from './config'
import { useConfigStore } from './config'
import type { TerminalScreenService, ScreenContent } from '../services/terminal-screen.service'
import type { TerminalSnapshotManager, TerminalSnapshot, TerminalDiff } from '../services/terminal-snapshot.service'
import { createLogger } from '../utils/logger'
import {
  findActivePaneInLayout,
  replacePaneInLayout,
  findPaneById,
  getAllTerminalPanes,
  removePaneFromLayout
} from './split-pane-tree'

const log = createLogger('Store')

export type ShellType = 'powershell' | 'cmd' | 'bash' | 'zsh' | 'sh' | 'unknown'
export type OSType = 'windows' | 'linux' | 'macos' | 'unknown'

export interface SystemInfo {
  os: OSType
  shell: ShellType
  shellPath?: string
  description: string
}

export interface AiMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: Date
}

// Agent 共享类型（从 @shared/types 统一导入）
export type {
  TerminalType,
  RiskLevel,
  StepProgress,
  AgentPlanStep,
  AgentPlan,
  AgentStep,
  PendingConfirmation,
} from '@shared/types'

import type { TerminalType, AgentStep, PendingConfirmation, RemoteChannel, AttachmentInfo } from '@shared/types'

export interface AgentState {
  isRunning: boolean
  agentId?: string
  sessionId?: string     // 会话 ID（用于会话级保存，后端通过此 ID 从 HistoryService 加载历史数据）
  sessionStartTime?: number  // 会话开始时间
  userTask?: string      // 用户任务描述
  steps: AgentStep[]
  pendingConfirm?: PendingConfirmation
  finalResult?: string   // Agent 完成后的最终回复
}

// 上传的文档类型（与 electron/services/document-parser.service.ts 同步）
export interface ParsedDocument {
  filename: string
  filePath?: string
  fileType: string
  content: string
  fileSize: number
  parseTime: number
  pageCount?: number
  totalPages?: number
  images?: string[]
  metadata?: Record<string, string>
  error?: string
}

export interface TerminalTab {
  id: string
  title: string
  type: TerminalType
  ptyId?: string
  sshConfig?: {
    host: string
    port: number
    username: string
  }
  // SSH 会话 ID（用于重连时从 configStore 获取完整配置）
  sshSessionId?: string
  systemInfo?: SystemInfo
  isConnected: boolean
  isLoading: boolean
  // 加载提示信息（用于显示具体的加载原因）
  loadingMessage?: string
  // 连接错误信息（用于显示连接失败的具体原因）
  connectionError?: string
  // 终端输出缓冲（最近的输出）
  outputBuffer?: string[]
  // 最近检测到的错误
  lastError?: {
    content: string
    timestamp: Date
  }
  // 当前选中的文本
  selectedText?: string
  // AI 对话历史（每个终端独立）
  aiMessages?: AiMessage[]
  // AI 是否正在生成回复
  aiLoading?: boolean
  // AI 对话滚动位置状态（用户是否在底部附近）
  aiScrollNearBottom?: boolean
  // AI 对话滚动位置（用于切换 tab 时恢复）
  aiScrollTop?: number
  // Agent 状态（每个终端独立）
  agentState?: AgentState
  // 上传的文档（每个终端独立）
  uploadedDocs?: ParsedDocument[]
  // 是否为远程 Gateway Agent 标签页
  isRemote?: boolean
  // 远程 IM 通道类型（仅远程 Agent 标签页使用，决定可用的 IM 工具集）
  remoteChannel?: RemoteChannel
  // 独立助手 Agent ID（仅 assistant 类型标签页使用）
  agentId?: string
  // 分屏布局（分屏模式时使用）
  splitLayout?: SplitPane
}

/**
 * 分屏新窗格的目标连接源。
 *
 * - `inherit`：复用当前激活窗格的连接（默认；激活窗格是 SSH 就开同一会话的新连接，
 *   是本地就开新本地 shell）
 * - `local`：强制新开本地 shell（不论当前激活窗格是什么）
 * - `ssh`：连接到指定的已配置 SSH 会话（sessionId 取自 configStore.sshSessions）
 */
export type SplitTarget =
  | { kind: 'inherit' }
  | { kind: 'local' }
  | { kind: 'ssh', sessionId: string }

export interface SplitPane {
  id: string
  type: 'terminal' | 'split'
  direction?: 'horizontal' | 'vertical'
  children?: SplitPane[]
  // 终端窗格属性（type='terminal' 时使用）
  ptyId?: string        // 终端实例 ID
  terminalType?: 'local' | 'ssh'  // 终端类型
  sshConfig?: {         // SSH 配置（仅 SSH 类型）
    host: string
    port: number
    username: string
  }
  sshSessionId?: string // SSH 会话 ID
  label?: string        // 窗格标签（如 "左侧"、"右上"）
  isActive?: boolean    // 是否为当前焦点窗格
  // 布局属性
  size?: number         // 窗格大小（百分比，0-100）
}

/**
 * Agent 终端上下文（用于发送给后端 Agent）
 *
 * 使用 discriminated union 强制调用方按 mode 分支处理：
 * - mode='single' 时可访问 ptyId、terminalOutput
 * - mode='split' 时可访问 panes、activePaneId
 *
 * 这样可以在 TS 编译期阻止"分屏模式下错误读 ptyId"这类静默 bug
 */
export interface AgentTerminalContextSingle {
  mode: 'single'
  ptyId: string
  terminalOutput: string[]
  systemInfo: { os: string; shell: string }
  terminalType: TerminalType
}

export interface AgentTerminalContextSplit {
  mode: 'split'
  // 兼容字段：取自激活窗格，后端 agent.ts 仍按单值消费这些字段
  ptyId: string
  terminalOutput: string[]
  terminalType: TerminalType
  systemInfo: { os: string; shell: string }
  // 多屏专属
  activePaneId: string | undefined
  panes: Array<{
    paneId: string
    ptyId: string
    label: string
    isActive: boolean
    terminalOutput: string[]
    terminalType: 'local' | 'ssh'
  }>
}

export type AgentTerminalContext = AgentTerminalContextSingle | AgentTerminalContextSplit

export const useTerminalStore = defineStore('terminal', () => {
  // 状态
  const tabs = ref<TerminalTab[]>([])
  const activeTabId = ref<string>('')

  // 终端计数器（用于生成唯一标题）
  const localTerminalCounter = ref(0)
  const sshTerminalCounters = ref<Record<string, number>>({})
  // 需要获得焦点的终端 ID（用于从 AI 助手发送代码后自动聚焦）
  const pendingFocusTabId = ref<string>('')
  // 定时任务待执行的 prompt（tabId -> prompt）
  const pendingSchedulerTasks = ref<Record<string, string>>({})
  
  // 屏幕服务实例存储（ptyId -> TerminalScreenService）
  // 使用普通对象而非 ref，因为 TerminalScreenService 实例不需要响应式
  // 注意：改为按 ptyId 存储，以支持分屏模式
  const screenServices = new Map<string, TerminalScreenService>()
  
  // 快照管理器存储（tabId -> TerminalSnapshotManager）
  const snapshotManagers = new Map<string, TerminalSnapshotManager>()

  // 计算属性
  const activeTab = computed(() => tabs.value.find(t => t.id === activeTabId.value))
  const tabCount = computed(() => tabs.value.length)

  /**
   * 检测本地系统信息
   */
  function detectLocalSystemInfo(shellPath?: string): SystemInfo {
    const platform = navigator.platform.toLowerCase()
    
    // 根据 shell 路径判断 shell 类型
    const detectShellType = (path?: string): ShellType => {
      if (!path) return 'unknown'
      const lowerPath = path.toLowerCase()
      if (lowerPath.includes('powershell')) return 'powershell'
      if (lowerPath.includes('cmd')) return 'cmd'
      if (lowerPath.includes('bash')) return 'bash'
      if (lowerPath.includes('zsh')) return 'zsh'
      if (lowerPath.includes('sh')) return 'sh'
      return 'unknown'
    }
    
    if (platform.includes('win')) {
      const shell = shellPath ? detectShellType(shellPath) : 'cmd'
      const shellNames: Record<ShellType, string> = {
        powershell: 'PowerShell',
        cmd: 'CMD 命令提示符',
        bash: 'Bash',
        zsh: 'Zsh',
        sh: 'Shell',
        unknown: '终端'
      }
      return {
        os: 'windows',
        shell,
        shellPath: shellPath || 'cmd.exe',
        description: `Windows ${shellNames[shell]}`
      }
    } else if (platform.includes('mac')) {
      const shell = shellPath ? detectShellType(shellPath) : 'zsh'
      return {
        os: 'macos',
        shell,
        shellPath: shellPath || '/bin/zsh',
        description: `macOS ${shell === 'zsh' ? 'Zsh' : shell} 终端`
      }
    } else if (platform.includes('linux')) {
      const shell = shellPath ? detectShellType(shellPath) : 'bash'
      return {
        os: 'linux',
        shell,
        shellPath: shellPath || '/bin/bash',
        description: `Linux ${shell === 'bash' ? 'Bash' : shell} 终端`
      }
    }
    
    return {
      os: 'unknown',
      shell: 'unknown',
      description: '未知终端类型'
    }
  }

  /**
   * 更新终端系统信息
   */
  function updateSystemInfo(tabId: string, systemInfo: Partial<SystemInfo>): void {
    const tab = tabs.value.find(t => t.id === tabId)
    if (tab) {
      tab.systemInfo = {
        ...tab.systemInfo,
        ...systemInfo
      } as SystemInfo
    }
  }

  /**
   * 追加终端输出到缓冲区
   */
  const MAX_OUTPUT_LINES = 100
  function appendOutput(tabId: string, output: string): void {
    const tab = tabs.value.find(t => t.id === tabId)
    if (!tab) return

    if (!tab.outputBuffer) {
      tab.outputBuffer = []
    }

    // 按行分割并追加
    const lines = output.split('\n')
    tab.outputBuffer.push(...lines)

    // 保持最大行数限制
    if (tab.outputBuffer.length > MAX_OUTPUT_LINES) {
      tab.outputBuffer = tab.outputBuffer.slice(-MAX_OUTPUT_LINES)
    }

    // 检测错误
    detectError(tabId, output)
  }

  /**
   * 检测终端输出中的错误
   */
  const errorPatterns = [
    /error:/i,
    /错误/,
    /failed/i,
    /失败/,
    /exception/i,
    /异常/,
    /not found/i,
    /找不到/,
    /permission denied/i,
    /拒绝访问/,
    /command not found/i,
    /无法识别/,
    /cannot /i,
    /unable to/i
  ]

  function detectError(tabId: string, output: string): void {
    const tab = tabs.value.find(t => t.id === tabId)
    if (!tab) return

    // 检查是否包含错误模式
    const hasError = errorPatterns.some(pattern => pattern.test(output))
    if (hasError) {
      tab.lastError = {
        content: stripAnsi(output.trim()).slice(0, 500), // 清理 ANSI 转义码并限制长度
        timestamp: new Date()
      }
    }
  }

  /**
   * 清除错误提示
   */
  function clearError(tabId: string): void {
    const tab = tabs.value.find(t => t.id === tabId)
    if (tab) {
      tab.lastError = undefined
    }
  }

  /**
   * 更新选中的文本
   */
  function updateSelectedText(tabId: string, text: string): void {
    const tab = tabs.value.find(t => t.id === tabId)
    if (tab) {
      tab.selectedText = text
    }
  }

  


  /**
   * 去除 ANSI 转义序列
   */
  function stripAnsi(str: string): string {
    return stripAnsiLib(str)
  }

  /**
   * 获取终端最近的输出
   */
  function getRecentOutput(tabId: string, lines: number = 20): string {
    const tab = tabs.value.find(t => t.id === tabId)
    if (!tab?.outputBuffer) return ''
    // 清理 ANSI 转义序列后返回
    const rawOutput = tab.outputBuffer.slice(-lines).join('\n')
    return stripAnsi(rawOutput)
  }

  /**
   * 创建新标签页
   */
  async function createTab(
    type: 'local' | 'ssh',
    sshConfig?: { 
      host: string
      port: number
      username: string
      password?: string
      privateKeyPath?: string  // 私钥文件路径
      passphrase?: string  // 私钥密码（可选）
      jumpHost?: JumpHostConfig  // 跳板机配置
      encoding?: string  // 字符编码，默认 utf-8
      sessionId?: string  // SSH 会话 ID（用于重连）
    },
    shell?: string,
    pendingTask?: string
  ): Promise<string> {
    const id = uuidv4()
    
    // 生成唯一标题
    const t = i18n.global.t
    let title: string
    if (type === 'local') {
      localTerminalCounter.value++
      const shellName = shell ? (shell.includes('powershell') ? 'PowerShell' : shell.includes('cmd') ? 'CMD' : shell.split(/[/\\]/).pop()) : ''
      title = shellName ? `${shellName} ${localTerminalCounter.value}` : `${t('tabs.localTerminal')} ${localTerminalCounter.value}`
    } else if (sshConfig) {
      const sshKey = `${sshConfig.username}@${sshConfig.host}`
      // 如果有跳板机，在标题中显示
      const jumpSuffix = sshConfig.jumpHost ? ` (via ${sshConfig.jumpHost.host})` : ''
      sshTerminalCounters.value[sshKey] = (sshTerminalCounters.value[sshKey] || 0) + 1
      const count = sshTerminalCounters.value[sshKey]
      title = count > 1 ? `${sshKey}${jumpSuffix} (${count})` : `${sshKey}${jumpSuffix}`
    } else {
      title = t('tabs.sshTerminal')
    }
    
    const tab: TerminalTab = {
      id,
      title,
      type,
      isConnected: false,
      isLoading: true
    }

    if (type === 'ssh' && sshConfig) {
      tab.sshConfig = {
        host: sshConfig.host,
        port: sshConfig.port,
        username: sshConfig.username
      }
      // 保存 SSH 会话 ID（用于重连时从 configStore 获取完整配置）
      if (sshConfig.sessionId) {
        tab.sshSessionId = sshConfig.sessionId
      }
    }

    tabs.value.push(tab)
    activeTabId.value = id

    if (pendingTask) {
      pendingSchedulerTasks.value[id] = pendingTask
    }

    // 获取响应式 tab 对象的引用
    const reactiveTab = tabs.value.find(t => t.id === id)!

    // 初始化终端连接
    try {
      if (type === 'local') {
        // 获取本地终端编码设置
        const configStore = useConfigStore()
        const localEncoding = configStore.terminalSettings.localEncoding || 'auto'
        
        // 检查 PATH 是否就绪，如果还没就绪，显示加载提示
        const pathReady = await window.electronAPI.path.isReady()
        if (!pathReady) {
          reactiveTab.loadingMessage = t('terminal.loadingEnv') || '正在加载环境变量...'
        }
        
        const ptyId = await window.electronAPI.pty.create({
          cols: 80,
          rows: 24,
          shell: shell,
          encoding: localEncoding
        })
        reactiveTab.loadingMessage = undefined  // 清除加载提示
        reactiveTab.ptyId = ptyId
        reactiveTab.isConnected = true
        // 检测本地系统信息
        reactiveTab.systemInfo = detectLocalSystemInfo(shell)
        ensureRootSplitLayoutForTab(reactiveTab)
      } else if (type === 'ssh' && sshConfig) {
        const sshId = await window.electronAPI.ssh.connect({
          host: sshConfig.host,
          port: sshConfig.port,
          username: sshConfig.username,
          password: sshConfig.password,
          privateKeyPath: sshConfig.privateKeyPath,  // 私钥文件路径
          passphrase: sshConfig.passphrase,  // 私钥密码
          jumpHost: sshConfig.jumpHost ? toRaw(sshConfig.jumpHost) : undefined,
          encoding: sshConfig.encoding,  // 传递编码配置
          cols: 80,
          rows: 24
        })
        reactiveTab.ptyId = sshId
        reactiveTab.isConnected = true
        // SSH 连接默认假设是 Linux/Unix 系统
        const jumpInfo = sshConfig.jumpHost ? ` (via ${sshConfig.jumpHost.host})` : ''
        reactiveTab.systemInfo = {
          os: 'linux',
          shell: 'bash',
          description: `SSH 连接: ${sshConfig.username}@${sshConfig.host}${jumpInfo}`
        }
        ensureRootSplitLayoutForTab(reactiveTab)
      }
    } catch (error) {
      console.error('Failed to create terminal:', error)
      reactiveTab.isConnected = false
      // 保存连接错误信息，便于显示给用户
      reactiveTab.connectionError = error instanceof Error ? error.message : '连接失败'
    } finally {
      reactiveTab.isLoading = false
    }

    return id
  }

  /**
   * 创建独立助手标签页（无终端绑定）
   */
  function createAssistantTab(options?: {
    agentId?: string
    title?: string
    isRemote?: boolean
    remoteChannel?: TerminalTab['remoteChannel']
    activate?: boolean
  }): string {
    const id = uuidv4()
    const agentId = options?.agentId || `assistant-${id}`
    const t = i18n.global.t
    
    const configStore = useConfigStore()
    const defaultTitle = configStore.agentName || t('tabs.assistant', '助手')

    const tab: TerminalTab = {
      id,
      title: options?.title || defaultTitle,
      type: 'assistant',
      agentId,
      isConnected: true,
      isLoading: false,
      isRemote: options?.isRemote,
      remoteChannel: options?.remoteChannel,
      agentState: {
        isRunning: false,
        steps: [],
        agentId
      }
    }
    
    tabs.value.push(tab)
    if (options?.activate !== false) {
      activeTabId.value = id
    } else {
      // 不抢焦点：仅当当前没有选中 tab 时才选中新 tab（例如首个 tab）
      if (!activeTabId.value) {
        activeTabId.value = id
      }
    }
    return id
  }

  // 当助手名字变更时，同步更新非远程助手标签页的标题
  {
    const configStore = useConfigStore()
    watch(() => configStore.agentName, (newName) => {
      const t = i18n.global.t
      const title = newName || t('tabs.assistant', '助手')
      for (const tab of tabs.value) {
        if (tab.type === 'assistant' && !tab.isRemote) {
          tab.title = title
        }
      }
    })
  }

  /**
   * 创建终端并自动执行 Agent 任务（通用入口）
   * @param prompt Agent 任务指令
   * @param options.type 终端类型，默认 'local'；'headless' 为无终端纯助手（预留）
   * @param options.sshConfig SSH 连接配置（type='ssh' 时必填）
   * @param options.shell 本地终端 shell 路径
   */
  async function createTabWithTask(prompt: string, options?: {
    type?: 'local' | 'ssh' | 'headless'
    sshConfig?: Parameters<typeof createTab>[1]
    shell?: string
  }): Promise<string> {
    const type = options?.type ?? 'local'

    if (type === 'headless') {
      return createAssistantTab()
    }

    const tabId = await createTab(type, options?.sshConfig, options?.shell, prompt)
    return tabId
  }

  /**
   * 关闭标签页
   * @param tabId 标签页 ID
   * @param skipConfirm 是否跳过确认（默认 false）
   */
  async function closeTab(tabId: string, skipConfirm: boolean = false): Promise<boolean> {
    const tab = tabs.value.find(t => t.id === tabId)
    if (!tab) return false

    const t = i18n.global.t

    // 如果不跳过确认，检查是否需要确认
    if (!skipConfirm) {
      // 检查 Agent 是否正在运行
      const isAgentRunning = tab.agentState?.isRunning === true

      if (isAgentRunning) {
        // Agent 正在运行，显示警告确认
        const confirmed = window.confirm(t('tabs.confirmCloseAgentRunning'))
        if (!confirmed) return false
      }
    }

    // 清理连接
    if (tab.type === 'assistant') {
      if (tab.agentId) {
        window.electronAPI.agent.cleanup(tab.agentId).catch(() => {})
      }
    } else if (tab.ptyId && !tab.isRemote) {
      if (tab.type === 'local') {
        await window.electronAPI.pty.dispose(tab.ptyId)
      } else {
        await window.electronAPI.ssh.disconnect(tab.ptyId)
      }
    }

    // 清理延迟的 proactive 状态
    clearDeferredProactive(tabId)

    // 移除标签
    const index = tabs.value.findIndex(t => t.id === tabId)
    tabs.value.splice(index, 1)

    // 如果关闭的是当前标签，切换到其他标签
    if (activeTabId.value === tabId) {
      if (tabs.value.length > 0) {
        const newIndex = Math.min(index, tabs.value.length - 1)
        activeTabId.value = tabs.value[newIndex].id
      } else {
        activeTabId.value = ''
      }
    }

    return true
  }

  /**
   * 创建关联到现有 ptyId 的标签页
   * 用于定时任务执行时，后端已创建终端，前端需要显示
   * @param options.activate 是否激活新 tab（默认 true）。远程 Gateway/IM 创建时传 false，避免抢焦点
   */
  function createTabWithExistingPty(options: {
    ptyId: string
    title: string
    type: 'local' | 'ssh'
    sshConfig?: {
      host: string
      port: number
      username: string
    }
    sshSessionId?: string
    pendingTask?: string  // 创建后自动执行的任务 prompt
    isRemote?: boolean    // 是否为远程 Gateway Agent 标签页
    activate?: boolean   // 是否激活新 tab，默认 true；远程任务创建时传 false 不抢焦点
  }): string {
    const id = uuidv4()
    const shouldActivate = options.activate !== false

    const tab: TerminalTab = {
      id,
      title: options.title,
      type: options.type,
      ptyId: options.ptyId,
      isConnected: true,
      isLoading: false,
      isRemote: options.isRemote
    }

    if (options.type === 'ssh' && options.sshConfig) {
      tab.sshConfig = options.sshConfig
      if (options.sshSessionId) {
        tab.sshSessionId = options.sshSessionId
      }
    }

    ensureRootSplitLayoutForTab(tab)

    tabs.value.push(tab)
    if (shouldActivate) {
      activeTabId.value = id
    } else {
      // 不抢焦点：仅当当前没有选中 tab 时才选中新 tab（例如首个 tab）
      if (!activeTabId.value) {
        activeTabId.value = id
      }
    }

    // 如果有待执行任务，记录下来让 AiPanel 自动执行
    if (options.pendingTask) {
      pendingSchedulerTasks.value[id] = options.pendingTask
    }

    return id
  }

  /**
   * 获取并清除 tab 的待执行定时任务
   */
  function consumePendingSchedulerTask(tabId: string): string | undefined {
    const task = pendingSchedulerTasks.value[tabId]
    if (task) {
      delete pendingSchedulerTasks.value[tabId]
    }
    return task
  }

  /**
   * 重新连接 SSH 终端
   * 需要从 configStore 获取会话配置，返回 { success, needsSession } 指示结果
   */
  async function reconnectSsh(tabId: string): Promise<{ success: boolean; needsSession?: boolean }> {
    const tab = tabs.value.find(t => t.id === tabId)
    if (!tab || tab.type !== 'ssh') {
      console.error('Cannot reconnect: tab not found or not SSH type')
      return { success: false }
    }

    // 如果没有 sessionId，无法重连（配置未保存）
    if (!tab.sshSessionId) {
      console.warn('Cannot reconnect: no sessionId saved (session was not saved)')
      return { success: false, needsSession: true }
    }

    // 从 configStore 获取会话配置
    const configStore = useConfigStore()
    const session = configStore.sshSessions.find(s => s.id === tab.sshSessionId)
    if (!session) {
      console.error('Cannot reconnect: session not found in config')
      return { success: false, needsSession: true }
    }

    // 标记正在重连
    tab.isLoading = true
    tab.isConnected = false

    try {
      // 尝试断开旧连接（如果还存在）
      if (tab.ptyId) {
        try {
          await window.electronAPI.ssh.disconnect(tab.ptyId)
        } catch (e) {
          // 忽略断开连接的错误
        }
      }

      // 获取跳板机配置
      const jumpHost = configStore.getEffectiveJumpHost(session)

      // 使用会话配置重新连接
      const sshId = await window.electronAPI.ssh.connect({
        host: session.host,
        port: session.port,
        username: session.username,
        password: session.password,
        privateKeyPath: session.privateKeyPath,  // 私钥文件路径
        passphrase: session.passphrase,  // 私钥密码
        jumpHost: jumpHost ? toRaw(jumpHost) : undefined,
        encoding: session.encoding || 'utf-8',
        cols: 80,
        rows: 24
      })

      // 更新 tab
      tab.ptyId = sshId
      tab.isConnected = true

      // 更新系统信息
      const jumpInfo = jumpHost ? ` (via ${jumpHost.host})` : ''
      tab.systemInfo = {
        os: 'linux',
        shell: 'bash',
        description: `SSH 连接: ${session.username}@${session.host}${jumpInfo}`
      }

      // 同步 splitLayout：单屏时把 root 唯一 terminal 子节点的 ptyId 更新到新 sshId；
      // 没有 layout 则创建。多屏 + 重连为复杂场景，暂不在这里处理。
      if (tab.splitLayout?.children?.length === 1 && tab.splitLayout.children[0].type === 'terminal') {
        tab.splitLayout.children[0].ptyId = sshId
        tab.splitLayout.children[0].sshConfig = tab.sshConfig
        tab.splitLayout.children[0].sshSessionId = tab.sshSessionId
      } else if (!tab.splitLayout) {
        ensureRootSplitLayoutForTab(tab)
      }

      return { success: true }
    } catch (error) {
      console.error('Failed to reconnect SSH:', error)
      tab.isConnected = false
      throw error
    } finally {
      tab.isLoading = false
    }
  }

  /**
   * 切换标签页
   */
  function setActiveTab(tabId: string): void {
    if (tabs.value.find(t => t.id === tabId)) {
      activeTabId.value = tabId
    }
  }

  /**
   * 更新标签标题
   */
  function updateTabTitle(tabId: string, title: string): void {
    const tab = tabs.value.find(t => t.id === tabId)
    if (tab) {
      tab.title = title
    }
  }

  /**
   * 更新连接状态
   */
  function updateConnectionStatus(tabId: string, isConnected: boolean): void {
    const tab = tabs.value.find(t => t.id === tabId)
    if (tab) {
      tab.isConnected = isConnected
    }
  }

  /**
   * 直接按 ptyId + 终端类型写入数据（分屏安全）
   *
   * 调用方需要持有 ptyId（Terminal 组件内部、Agent IPC 等场景）。
   * 不要用 tab.ptyId 路由：分屏后 tab.ptyId 是"当前激活窗格的 ptyId"，
   * 而 Terminal 组件 onData 要写自己（可能是非激活窗格）的 pty。
   */
  async function writeToPty(ptyId: string, terminalType: 'local' | 'ssh', data: string): Promise<void> {
    if (!ptyId) return
    if (terminalType === 'local') {
      await window.electronAPI.pty.write(ptyId, data)
    } else {
      await window.electronAPI.ssh.write(ptyId, data)
    }
  }

  /**
   * 直接按 ptyId + 终端类型 resize（分屏安全，理由同 writeToPty）
   */
  async function resizePty(ptyId: string, terminalType: 'local' | 'ssh', cols: number, rows: number): Promise<void> {
    if (!ptyId) return
    if (terminalType === 'local') {
      await window.electronAPI.pty.resize(ptyId, cols, rows)
    } else {
      await window.electronAPI.ssh.resize(ptyId, cols, rows)
    }
  }

  /**
   * 向 tab 当前激活窗格写入数据（外部调用接口：AI Panel、批量命令等）
   *
   * 分屏时路由到激活窗格的 ptyId（不再用 tab.ptyId，因为它在 setActivePaneInTab 时
   * 不会同步更新）。
   */
  async function writeToTerminal(tabId: string, data: string): Promise<void> {
    const tab = tabs.value.find(t => t.id === tabId)
    if (!tab) return
    const ptyId = getActivePtyId(tab)
    if (!ptyId) return
    await writeToPty(ptyId, tab.type as 'local' | 'ssh', data)
  }

  /**
   * 调整 tab 当前激活窗格的终端大小（保留给外部调用；Terminal 组件内部应用 resizePty）
   */
  async function resizeTerminal(tabId: string, cols: number, rows: number): Promise<void> {
    const tab = tabs.value.find(t => t.id === tabId)
    if (!tab) return
    const ptyId = getActivePtyId(tab)
    if (!ptyId) return
    await resizePty(ptyId, tab.type as 'local' | 'ssh', cols, rows)
  }

  /**
   * 创建分屏
   * 将当前激活的终端分割为两个窗格
   *
   * @param direction horizontal=左右、vertical=上下
   * @param target    新窗格连接哪里：
   *                  - 不传 / `{kind:'inherit'}`：复用当前激活窗格的连接（默认，与历史行为一致）
   *                  - `{kind:'local'}`：新开本地 shell
   *                  - `{kind:'ssh', sessionId}`：新开已配置的 SSH 会话
   */
  /** 最近一次分屏失败的具体原因——给 Agent / UI 调用方读取（非 reactive，仅模块内单值缓存） */
  let lastSplitError: string | null = null
  function getLastSplitError(): string | null { return lastSplitError }

  async function splitTerminal(
    direction: 'horizontal' | 'vertical',
    target: SplitTarget = { kind: 'inherit' }
  ): Promise<string | null> {
    lastSplitError = null

    const currentTab = activeTab.value
    if (!currentTab) {
      lastSplitError = 'no active tab'
      log.warn('No active tab to split')
      return null
    }

    if (currentTab.type === 'assistant') {
      lastSplitError = 'cannot split assistant tab'
      log.warn('Cannot split assistant tab')
      return null
    }

    // 兜底：老数据可能无 splitLayout，补齐
    if (!currentTab.splitLayout) {
      ensureRootSplitLayoutForTab(currentTab)
    }
    if (!currentTab.splitLayout) {
      lastSplitError = 'tab has no splitLayout'
      log.warn('Cannot split: tab has no ptyId or splitLayout')
      return null
    }

    assertTabLayoutInvariant(currentTab)

    const activePane = findActivePaneInLayout(currentTab.splitLayout)
      ?? getAllTerminalPanes(currentTab.splitLayout)[0]
    if (!activePane || activePane.type !== 'terminal') {
      lastSplitError = 'no terminal pane in layout to split on'
      log.warn('No terminal pane in layout to split on')
      return null
    }

    // 解析目标连接源：inherit 时回退到激活窗格的连接（不依赖 tab 顶层字段，
    // 因为分屏后 tab.type/sshConfig 只跟 root 兼容，激活窗格的连接才是真相）
    const resolved = resolveSplitTarget(target, activePane)
    if (!resolved) {
      lastSplitError = lastSplitError || 'failed to resolve split target'
      return null
    }

    const newPtyId = await createTerminalInstanceForTarget(resolved)
    if (!newPtyId) {
      lastSplitError = lastSplitError || 'failed to create new terminal instance'
      return null
    }

    // 把 active 终端节点替换为一个 split 子容器（含原节点 + 新节点）。
    //
    // Terminal 实例的存活由 TerminalTabView 的 Teleport 池保证（Terminal 组件按 ptyId
    // 在外层 v-for 维护，DOM 通过 Teleport 投影到 SplitPaneView 渲染的占位 div）。
    // 因此布局节点 id 是否稳定，对 xterm 内容不再敏感——本函数只关心数据正确性。
    const newPane: SplitPane = {
      id: uuidv4(),
      type: 'terminal',
      ptyId: newPtyId,
      terminalType: resolved.terminalType,
      sshConfig: resolved.sshConfig,
      sshSessionId: resolved.sshSessionId,
      label: resolved.label || i18n.global.t('terminal.split.label.new'),
      isActive: true,
      size: 50
    }

    // 复用原节点的 id（不要 uuidv4 新建）：
    // - Agent 通过 list_panes 拿到的 paneId 在分屏后仍然有效，避免"持旧 id 调 close_pane 静默失败"
    // - 用户体验上"原本那个窗格"在结构上确实是同一个，标识符延续也更合理
    const originalChild: SplitPane = {
      id: activePane.id,
      type: 'terminal',
      ptyId: activePane.ptyId,
      terminalType: activePane.terminalType,
      sshConfig: activePane.sshConfig,
      sshSessionId: activePane.sshSessionId,
      label: activePane.label,
      isActive: false,
      size: 50
    }

    // 继承被替换节点在父容器中分配到的 size，避免破坏外层窗格已有的尺寸比例。
    // 否则二次分屏（如把右窗格再上下分）会让 splitContainer 失去 flex 权重，
    // 表现为外层左右比例从 50:50 变成 50:1，新嵌套的窗格被挤成几乎不可见。
    const splitContainer: SplitPane = {
      id: uuidv4(),
      type: 'split',
      direction,
      size: activePane.size,
      children: [originalChild, newPane]
    }

    replacePaneInLayout(currentTab.splitLayout, activePane.id, splitContainer)

    // 同步 tab.ptyId 为新激活窗格的 ptyId（外部兼容字段）
    currentTab.ptyId = newPtyId

    updatePaneLabels(currentTab.splitLayout)

    log.debug('Split active pane:', direction)
    return newPane.id
  }

  /**
   * 把 SplitTarget 解析成创建 PTY 所需的全部参数。
   *
   * 失败时返回 null（如 ssh sessionId 不存在）。inherit 模式回退到 activePane 的连接：
   * - 激活窗格是 ssh → 复用其 sshSessionId 重新 ssh.connect 一次（不会复用同一个 PTY，
   *   Agent / 用户预期是"新开一个相同的连接"）
   * - 激活窗格是 local → 走本地 shell
   */
  function resolveSplitTarget(
    target: SplitTarget,
    activePane: SplitPane
  ): {
    terminalType: 'local' | 'ssh'
    sshSessionId?: string
    sshConfig?: { host: string; port: number; username: string }
    label?: string
  } | null {
    const configStore = useConfigStore()

    const finalTarget: SplitTarget = (() => {
      if (target.kind === 'inherit') {
        if (activePane.terminalType === 'ssh' && activePane.sshSessionId) {
          return { kind: 'ssh' as const, sessionId: activePane.sshSessionId }
        }
        return { kind: 'local' as const }
      }
      return target
    })()

    if (finalTarget.kind === 'local') {
      return { terminalType: 'local' }
    }

    const session = configStore.sshSessions.find(s => s.id === finalTarget.sessionId)
    if (!session) {
      lastSplitError = `SSH session not found: ${finalTarget.sessionId}`
      log.error('SSH session not found:', finalTarget.sessionId)
      return null
    }
    return {
      terminalType: 'ssh',
      sshSessionId: session.id,
      sshConfig: { host: session.host, port: session.port, username: session.username },
      label: session.name
    }
  }

  /**
   * 按已解析的 target 创建一个新终端实例（PTY 或 SSH）
   */
  async function createTerminalInstanceForTarget(resolved: {
    terminalType: 'local' | 'ssh'
    sshSessionId?: string
  }): Promise<string | null> {
    const configStore = useConfigStore()
    try {
      if (resolved.terminalType === 'local') {
        const localEncoding = configStore.terminalSettings.localEncoding || 'auto'
        return await window.electronAPI.pty.create({
          cols: 80,
          rows: 24,
          encoding: localEncoding
        })
      }

      if (!resolved.sshSessionId) {
        lastSplitError = 'ssh target missing sessionId'
        return null
      }
      const session = configStore.sshSessions.find(s => s.id === resolved.sshSessionId)
      if (!session) {
        lastSplitError = `SSH session not found: ${resolved.sshSessionId}`
        log.error('SSH session not found:', resolved.sshSessionId)
        return null
      }

      const jumpHost = configStore.getEffectiveJumpHost(session)

      return await window.electronAPI.ssh.connect({
        host: session.host,
        port: session.port,
        username: session.username,
        password: session.password,
        privateKeyPath: session.privateKeyPath,
        passphrase: session.passphrase,
        jumpHost: jumpHost ? toRaw(jumpHost) : undefined,
        encoding: session.encoding || 'utf-8',
        cols: 80,
        rows: 24
      })
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      lastSplitError = `failed to create terminal instance: ${msg}`
      log.error('Failed to create terminal instance:', error)
      return null
    }
  }

  /**
   * 更新所有窗格的标签
   * 标签语义化为可翻译字符串；切换语言后下次分屏操作会刷新
   */
  function updatePaneLabels(layout: SplitPane, path: string = ''): void {
    const t = i18n.global.t
    if (layout.type === 'terminal') {
      layout.label = path || t('terminal.split.label.main')
      return
    }

    if (layout.children) {
      layout.children.forEach((child, index) => {
        const position = layout.direction === 'horizontal'
          ? (index === 0 ? t('terminal.split.position.left') : t('terminal.split.position.right'))
          : (index === 0 ? t('terminal.split.position.top') : t('terminal.split.position.bottom'))
        const newPath = path ? `${path}-${position}` : position
        updatePaneLabels(child, newPath)
      })
    }
  }

  /**
   * 关闭分屏窗格。
   *
   * `paneId` 接受两种值——优先按布局节点 id 查找；找不到时按 ptyId 查找。
   * 这样 Agent 可以传 list_panes 返回的 paneId 或 ptyId 任一种来关闭窗格，
   * 即使持有的 paneId 因某些边缘场景过期，也能用稳定的 ptyId 兜底。
   *
   * 返回 true 表示成功移除，false 表示找不到对应节点。
   * 如果只剩一个窗格，则关闭整个 tab。
   */
  async function closePaneInternal(tabId: string, paneId: string): Promise<boolean> {
    const tab = tabs.value.find(t => t.id === tabId)
    if (!tab?.splitLayout) return false

    assertTabLayoutInvariant(tab)

    let pane = findPaneById(tab.splitLayout, paneId)
    if (!pane) {
      // 兼容路径：传入的可能是 ptyId 而非 paneId
      pane = getAllTerminalPanes(tab.splitLayout).find(p => p.ptyId === paneId) ?? null
    }
    if (!pane) return false

    // 清理终端连接
    if (pane.ptyId) {
      try {
        if (pane.terminalType === 'local') {
          await window.electronAPI.pty.dispose(pane.ptyId)
        } else {
          await window.electronAPI.ssh.disconnect(pane.ptyId)
        }
      } catch (e) {
        log.error('Failed to dispose pane terminal:', e)
      }
    }

    // 从布局中移除窗格
    const allPanes = getAllTerminalPanes(tab.splitLayout)

    // 关掉最后一个窗格 → 关闭整个 tab
    if (allPanes.length <= 1) {
      log.debug('Last pane closed, closing tab')
      await closeTab(tabId)
      return true
    }

    // 移除指定窗格（用 pane.id 而非入参 paneId——后者可能是 ptyId 兜底匹配进来的）；
    // 嵌套 split 容器在只剩 1 child 时由 removePaneFromLayout 自动 lift
    removePaneFromLayout(tab.splitLayout, pane.id)
    updatePaneLabels(tab.splitLayout)

    // 同步 root 终端身份字段（用激活窗格 / 第一个窗格）
    const remainingPanes = getAllTerminalPanes(tab.splitLayout)
    const fallbackPane = remainingPanes.find(p => p.isActive) || remainingPanes[0]
    if (fallbackPane?.ptyId) {
      tab.ptyId = fallbackPane.ptyId
      if (fallbackPane.terminalType) {
        tab.type = fallbackPane.terminalType
      }
      if (fallbackPane.terminalType === 'ssh') {
        tab.sshConfig = fallbackPane.sshConfig
        tab.sshSessionId = fallbackPane.sshSessionId
      } else {
        tab.sshConfig = undefined
        tab.sshSessionId = undefined
      }
    }

    // 维护不变量：splitLayout 永远至少有一个激活窗格。
    // 关掉激活窗格时（pane.isActive === true）需要转移激活权；
    // 关掉非激活窗格但 lift 路径让原激活节点的 isActive 字段被冲掉、
    // 或被关闭的本身是 split 容器（没有 isActive 字段）等场景下，
    // 剩余 panes 也可能全部 inactive——此时同样要补一个激活，
    // 否则 getActivePtyId 找不到激活窗格会让 Agent 报"无法获取终端上下文"。
    const hasAnyActive = remainingPanes.some(p => p.isActive)
    if (!hasAnyActive && fallbackPane) {
      setActivePaneInTab(tabId, fallbackPane.id)
    }

    return true
  }

  /**
   * 设置激活的窗格。
   *
   * `paneId` 优先按布局节点 id 查找；找不到时按 ptyId 兜底——跟 closePane 行为一致，
   * Agent 拿到的 pane 标识符可以是 paneId 或 ptyId 任一种。
   *
   * 返回 true 表示成功激活，false 表示找不到目标节点（此时不修改任何状态，
   * 避免把所有窗格都清成 inactive 破坏"至少一个激活"不变量）。
   */
  function setActivePaneInTab(tabId: string, paneId: string): boolean {
    const tab = tabs.value.find(t => t.id === tabId)
    if (!tab?.splitLayout) return false

    let targetPane = findPaneById(tab.splitLayout, paneId)
    if (!targetPane) {
      targetPane = getAllTerminalPanes(tab.splitLayout).find(p => p.ptyId === paneId) ?? null
    }
    if (!targetPane) return false

    const allPanes = getAllTerminalPanes(tab.splitLayout)
    allPanes.forEach(p => p.isActive = false)
    targetPane.isActive = true
    return true
  }

  /**
   * 更新窗格大小
   */
  function updatePaneSize(tabId: string, paneId: string, size: number): void {
    const tab = tabs.value.find(t => t.id === tabId)
    if (!tab?.splitLayout) return

    const pane = findPaneById(tab.splitLayout, paneId)
    if (pane) {
      pane.size = Math.max(10, Math.min(90, size)) // 限制在 10-90% 之间
    }
  }

  /**
   * 重新排序标签页（用于拖拽）
   */
  function reorderTabs(fromIndex: number, toIndex: number): void {
    if (fromIndex === toIndex) return
    if (fromIndex < 0 || fromIndex >= tabs.value.length) return
    if (toIndex < 0 || toIndex >= tabs.value.length) return

    const [movedTab] = tabs.value.splice(fromIndex, 1)
    tabs.value.splice(toIndex, 0, movedTab)
  }

  // ==================== AI 消息管理 ====================

  /**
   * 获取当前终端的 AI 消息
   */
  function getAiMessages(tabId: string): AiMessage[] {
    const tab = tabs.value.find(t => t.id === tabId)
    return tab?.aiMessages || []
  }

  /**
   * 添加 AI 消息
   */
  function addAiMessage(tabId: string, message: AiMessage): number {
    const tab = tabs.value.find(t => t.id === tabId)
    if (!tab) return -1
    
    if (!tab.aiMessages) {
      tab.aiMessages = []
    }
    tab.aiMessages.push(message)
    return tab.aiMessages.length - 1
  }

  /**
   * 更新 AI 消息内容
   */
  function updateAiMessage(tabId: string, index: number, content: string): void {
    const tab = tabs.value.find(t => t.id === tabId)
    if (tab?.aiMessages && tab.aiMessages[index]) {
      tab.aiMessages[index].content = content
    }
  }

  /**
   * 清空 AI 消息
   */
  function clearAiMessages(tabId: string): void {
    const tab = tabs.value.find(t => t.id === tabId)
    if (tab) {
      tab.aiMessages = []
    }
  }

  /**
   * 设置 AI 加载状态
   */
  function setAiLoading(tabId: string, loading: boolean): void {
    const tab = tabs.value.find(t => t.id === tabId)
    if (tab) {
      tab.aiLoading = loading
    }
  }

  /**
   * 设置 AI 对话滚动位置状态
   */
  function setAiScrollNearBottom(tabId: string, nearBottom: boolean): void {
    const tab = tabs.value.find(t => t.id === tabId)
    if (tab) {
      tab.aiScrollNearBottom = nearBottom
    }
  }

  /**
   * 获取 AI 对话滚动位置状态
   */
  function getAiScrollNearBottom(tabId: string): boolean {
    const tab = tabs.value.find(t => t.id === tabId)
    return tab?.aiScrollNearBottom ?? true  // 默认为 true
  }

  /**
   * 设置 AI 对话滚动位置
   */
  function setAiScrollTop(tabId: string, scrollTop: number): void {
    const tab = tabs.value.find(t => t.id === tabId)
    if (tab) {
      tab.aiScrollTop = scrollTop
    }
  }

  /**
   * 获取 AI 对话滚动位置
   */
  function getAiScrollTop(tabId: string): number | undefined {
    const tab = tabs.value.find(t => t.id === tabId)
    return tab?.aiScrollTop
  }

  /**
   * 请求终端获得焦点
   */
  function focusTerminal(tabId?: string): void {
    pendingFocusTabId.value = tabId || activeTabId.value
  }

  /**
   * 清除焦点请求
   */
  function clearPendingFocus(): void {
    pendingFocusTabId.value = ''
  }

  // ==================== Agent 状态管理 ====================

  /**
   * 根据 agentId 查找对应的终端 ID
   */
  function findTabIdByAgentId(agentId: string): string | undefined {
    const tab = tabs.value.find(t => t.agentState?.agentId === agentId)
    return tab?.id
  }

  /**
   * 根据 ptyId 查找对应的终端 ID
   * 用于 Agent 事件匹配（比 agentId 更可靠，因为 ptyId 在启动前就已知）
   *
   * 分屏时 tab.ptyId 只是"激活窗格"的 ptyId，非激活窗格的 ptyId 在 splitLayout 树里。
   * 这里同时检查 tab.ptyId 和 splitLayout 中所有窗格，避免分屏后 Agent 用旧 ptyId 推
   * step 时被误判为"不属于本 tab"而丢弃（典型表现：分屏后任务还在跑但前端不再收到消息）。
   */
  function findTabIdByPtyId(ptyId: string): string | undefined {
    for (const tab of tabs.value) {
      if (tab.ptyId === ptyId) return tab.id
      if (tab.splitLayout) {
        const panes = getAllTerminalPanes(tab.splitLayout)
        if (panes.some(p => p.ptyId === ptyId)) return tab.id
      }
    }
    return undefined
  }

  /**
   * 获取当前终端的 Agent 状态
   */
  function getAgentState(tabId: string): AgentState | undefined {
    const tab = tabs.value.find(t => t.id === tabId)
    return tab?.agentState
  }

  /**
   * 设置 Agent 运行状态
   */
  function setAgentRunning(tabId: string, isRunning: boolean, agentId?: string, userTask?: string): void {
    log.debug('setAgentRunning called:', { tabId, isRunning, agentId })
    const tabIndex = tabs.value.findIndex(t => t.id === tabId)
    if (tabIndex === -1) {
      log.warn('setAgentRunning: tab not found for tabId:', tabId)
      return
    }

    const tab = tabs.value[tabIndex]

    if (!tab.agentState) {
      tab.agentState = {
        isRunning: false,
        steps: []
      }
    }

    // 创建新的 agentState 对象以确保响应式更新
    tab.agentState = {
      ...tab.agentState,
      isRunning,
      ...(agentId !== undefined && { agentId }),
      ...(userTask !== undefined && { userTask }),
      ...(!isRunning && { pendingConfirm: undefined })
    }

    // 强制触发数组更新
    tabs.value = [...tabs.value]
    log.debug('setAgentRunning completed, new isRunning:', tab.agentState.isRunning)
  }

  /**
   * 设置 Agent 会话 ID 和开始时间（用于会话级保存）
   */
  function setAgentSession(tabId: string, sessionId: string, sessionStartTime: number): void {
    const tab = tabs.value.find(t => t.id === tabId)
    if (!tab) return

    if (!tab.agentState) {
      tab.agentState = {
        isRunning: false,
        steps: []
      }
    }

    tab.agentState = {
      ...tab.agentState,
      sessionId,
      sessionStartTime
    }
  }

  /**
   * 只设置 Agent ID，不改变运行状态
   * 用于在接收步骤事件时关联 agentId 和 tabId
   */
  function setAgentId(tabId: string, agentId: string): void {
    const tab = tabs.value.find(t => t.id === tabId)
    if (!tab) return

    if (!tab.agentState) {
      tab.agentState = {
        isRunning: false,
        steps: []
      }
    }

    // 只更新 agentId，不改变其他状态
    if (tab.agentState.agentId !== agentId) {
      tab.agentState = {
        ...tab.agentState,
        agentId
      }
      tabs.value = [...tabs.value]
    }
  }

  /**
   * 添加或更新 Agent 执行步骤
   * 如果步骤 id 已存在，则更新；否则添加新步骤
   */
  function addAgentStep(tabId: string, step: AgentStep): void {
    const tab = tabs.value.find(t => t.id === tabId)
    if (!tab) {
      log.warn(`addAgentStep: tab not found, tabId=${tabId}, step.type=${step.type}`)
      return
    }

    if (!tab.agentState) {
      log.warn(`addAgentStep: 创建缺失的 agentState, tabId=${tabId}`)
      tab.agentState = {
        isRunning: false,
        steps: []
      }
    }

    // 查找是否存在相同 id 的步骤
    const existingIndex = tab.agentState.steps.findIndex(s => s.id === step.id)
    
    if (existingIndex >= 0) {
      // 更新现有步骤（用于流式输出）
      tab.agentState.steps[existingIndex] = step
    } else {
      // 添加新步骤
      tab.agentState.steps.push(step)
      // 对关键步骤类型打印日志（user_task 和 final_result 是分组依据）
      if (step.type === 'user_task' || step.type === 'final_result') {
        log.debug(`addAgentStep 新增关键步骤: tabId=${tabId}, type=${step.type}, totalSteps=${tab.agentState.steps.length}, isRemote=${tab.isRemote}`)
      }
    }
  }

  /**
   * 按 ID 移除指定的 Agent 执行步骤
   * 用于后端撤销临时占位步骤（如初始"正在准备..."）后同步前端状态
   */
  function removeAgentStep(tabId: string, stepId: string): void {
    const tab = tabs.value.find(t => t.id === tabId)
    if (!tab?.agentState) return
    const index = tab.agentState.steps.findIndex(s => s.id === stepId)
    if (index !== -1) {
      tab.agentState.steps.splice(index, 1)
    }
  }

  /**
   * 设置待确认的工具调用
   */
  function setAgentPendingConfirm(tabId: string, confirmation: PendingConfirmation | undefined): void {
    const tab = tabs.value.find(t => t.id === tabId)
    if (!tab?.agentState) return

    tab.agentState.pendingConfirm = confirmation
  }

  /**
   * 清空 Agent 当前任务状态（保留 UI 步骤和会话标识）
   */
  function clearAgentState(tabId: string, preserveSession: boolean = true): void {
    const tab = tabs.value.find(t => t.id === tabId)
    if (tab) {
      tab.agentState = {
        isRunning: false,
        agentId: tab.agentState?.agentId,
        sessionId: preserveSession ? tab.agentState?.sessionId : undefined,
        sessionStartTime: preserveSession ? tab.agentState?.sessionStartTime : undefined,
        steps: preserveSession ? (tab.agentState?.steps || []) : []
      }
    }
  }

  /**
   * 设置 Agent 最终结果
   */
  function setAgentFinalResult(tabId: string, result: string): void {
    const tab = tabs.value.find(t => t.id === tabId)
    if (!tab?.agentState) return
    tab.agentState.finalResult = result
  }

  /**
   * 恢复历史 Agent 对话（从历史记录加载）
   */
  function restoreAgentHistory(tabId: string, record: {
    id: string
    timestamp: number
    userTask: string
    steps: Array<{
      id: string
      type: string
      content: string
      images?: string[]
      attachments?: AttachmentInfo[]
      toolName?: string
      toolArgs?: Record<string, unknown>
      toolResult?: string
      riskLevel?: string
      timestamp: number
      webSearchResults?: import('@shared/types').WebSearchResultItem[]
      success?: boolean
      subAgents?: import('@shared/types').SubAgentResult[]
    }>
    finalResult?: string
    duration: number
    status: 'completed' | 'failed' | 'aborted'
  }): void {
    const tab = tabs.value.find(t => t.id === tabId)
    if (!tab) return

    // 转换历史记录的 steps 为完整的 AgentStep 数组
    const convertedSteps = record.steps.map(s => ({
      id: s.id,
      type: s.type as AgentStep['type'],
      content: s.content,
      images: s.images,
      attachments: s.attachments,
      toolName: s.toolName,
      toolArgs: s.toolArgs,
      toolResult: s.toolResult,
      riskLevel: s.riskLevel as RiskLevel | undefined,
      timestamp: s.timestamp,
      webSearchResults: s.webSearchResults,
      success: s.success,
      subAgents: s.subAgents
    }))
    
    // 兼容旧数据：确保有 user_task 和 final_result 步骤
    const hasUserTask = convertedSteps.some(s => s.type === 'user_task')
    const steps: AgentStep[] = [
      ...(!hasUserTask ? [{
        id: `user_task_${record.timestamp}`,
        type: 'user_task' as const,
        content: record.userTask,
        timestamp: record.timestamp
      }] : []),
      ...convertedSteps,
      ...(record.finalResult && !convertedSteps.some(s => s.type === 'final_result') ? [{
        id: `final_result_${record.timestamp}`,
        type: 'final_result' as const,
        content: record.finalResult,
        timestamp: record.timestamp + record.duration
      }] : [])
    ]

    // 设置 agentState：sessionId 传给后端后，后端从 HistoryService 自行加载 messages 和 TaskMemory
    tab.agentState = {
      isRunning: false,
      sessionId: record.id,
      sessionStartTime: record.timestamp,
      steps: steps
    }
  }

  /**
   * 获取 Agent 上下文（用于发送给后端）
   * 支持多屏感知：如果有分屏布局，返回所有窗格的信息
   * 返回纯 JavaScript 对象，确保可以通过 IPC 序列化
   *
   * 返回 discriminated union（mode='single'|'split'）以强制调用方分支处理
   */
  function getAgentContext(tabId: string): AgentTerminalContext | null {
    const tab = tabs.value.find(t => t.id === tabId)
    if (!tab) return null

    assertTabLayoutInvariant(tab)

    if (tab.splitLayout) {
      const panes = getAllTerminalPanes(tab.splitLayout)
      const activePaneId = findActivePaneInLayout(tab.splitLayout)?.id

      const panesContext = panes
        .filter(pane => Boolean(pane.ptyId))
        .map(pane => {
          const screenService = screenServices.get(pane.ptyId || '')
          let terminalOutput: string[] = []
          if (screenService) {
            terminalOutput = screenService.getLastNLines(50)
          }
          // tab.type 在 assistant 时已被分屏入口排除，此处一定是 local|ssh
          const fallbackType = (pane.terminalType || tab.type) as 'local' | 'ssh'
          return {
            paneId: pane.id,
            ptyId: pane.ptyId as string,
            label: pane.label || 'Unknown',
            isActive: pane.id === activePaneId,
            terminalOutput,
            terminalType: fallbackType
          }
        })

      // 默认窗格（激活窗格优先；否则第一个窗格）作为兼容字段填充
      const defaultPane = panesContext.find(p => p.isActive) || panesContext[0]

      const result: AgentTerminalContextSplit = {
        mode: 'split',
        ptyId: defaultPane?.ptyId || '',
        terminalOutput: defaultPane?.terminalOutput || [],
        terminalType: defaultPane?.terminalType || tab.type,
        activePaneId,
        panes: panesContext,
        systemInfo: {
          os: tab.systemInfo?.os || 'unknown',
          shell: tab.systemInfo?.shell || 'unknown'
        }
      }
      return JSON.parse(JSON.stringify(result)) as AgentTerminalContextSplit
    }

    const screenService = screenServices.get(tab.ptyId || '')
    let terminalOutput: string[]
    if (screenService) {
      terminalOutput = screenService.getLastNLines(50)
    } else {
      terminalOutput = (tab.outputBuffer || []).slice(-50).map(line => stripAnsi(line))
    }

    const result: AgentTerminalContextSingle = {
      mode: 'single',
      ptyId: tab.ptyId || '',
      terminalOutput,
      systemInfo: {
        os: tab.systemInfo?.os || 'unknown',
        shell: tab.systemInfo?.shell || 'unknown'
      },
      terminalType: tab.type
    }
    return JSON.parse(JSON.stringify(result)) as AgentTerminalContextSingle
  }

  // ==================== 分屏 helpers（对外暴露，避免外部直接读 tab.ptyId/splitLayout）====================

  /**
   * 是否处于分屏模式
   */
  function isSplitTab(tab: TerminalTab): boolean {
    return Boolean(tab.splitLayout)
  }

  /**
   * 获取激活窗格（或单屏）的 ptyId
   * 分屏模式：返回当前激活窗格的 ptyId
   * 单屏模式：返回 tab.ptyId
   */
  function getActivePtyId(tab: TerminalTab): string | undefined {
    if (tab.splitLayout) {
      // 找不到激活窗格时退回到第一个终端窗格——跟 getAgentContext 的兜底保持一致，
      // 避免某些边缘场景（如关闭后 isActive 状态丢失）让上层误判为"没有可用终端"。
      return findActivePaneInLayout(tab.splitLayout)?.ptyId
        ?? getAllTerminalPanes(tab.splitLayout)[0]?.ptyId
    }
    return tab.ptyId
  }

  /**
   * 获取 tab 内所有 ptyId（单屏返回单个，分屏返回所有窗格）
   */
  function getAllTabPtyIds(tab: TerminalTab): string[] {
    if (tab.splitLayout) {
      return getAllTerminalPanes(tab.splitLayout)
        .map(p => p.ptyId)
        .filter((id): id is string => Boolean(id))
    }
    return tab.ptyId ? [tab.ptyId] : []
  }

  /**
   * 校验 tab.ptyId 与 tab.splitLayout 的不变量
   *
   * 设计：终端类型 tab 一旦持有 ptyId，就**始终**有一个 root split 容器作为 splitLayout，
   * 单屏时 children 仅含 1 个 terminal 节点，分屏时 ≥2 个。这样 SplitPaneView 始终是
   * 终端的渲染入口，从单屏到分屏只是给 root 容器添加兄弟节点，原 terminal 节点 id 稳定，
   * Vue 通过 :key 复用组件实例 → xterm 内容自然保留。
   *
   * 违反时仅记录日志，不抛异常，避免阻塞用户操作；便于排查状态机 bug。
   */
  function assertTabLayoutInvariant(tab: TerminalTab): void {
    if (tab.type === 'assistant') return
    if (tab.ptyId && !tab.splitLayout) {
      log.error(
        `[invariant] Tab ${tab.id} has ptyId (${tab.ptyId}) but no splitLayout — should have been initialized`
      )
    }
    if (tab.splitLayout && tab.splitLayout.type !== 'split') {
      log.error(
        `[invariant] Tab ${tab.id} root splitLayout must be a split container, got ${tab.splitLayout.type}`
      )
    }
  }

  /**
   * 为 tab 初始化 root splitLayout（终端类型 tab，已分配 ptyId 后调用）
   *
   * 单屏 layout = split 容器 + 1 个 terminal 子节点。子节点 id 在此处分配并保持稳定，
   * 之后无论分屏/关窗格，原 terminal 子节点 id 都不变（除非该窗格被关闭），
   * 保证 SplitPaneView v-for 的 :key 稳定，原 Terminal 组件实例不重建。
   *
   * 已有 splitLayout 时本函数 no-op，避免覆盖。
   */
  function ensureRootSplitLayoutForTab(tab: TerminalTab): void {
    if (tab.type === 'assistant') return
    if (!tab.ptyId) return
    if (tab.splitLayout) return

    const t = i18n.global.t
    tab.splitLayout = {
      id: uuidv4(),
      type: 'split',
      direction: 'horizontal',
      children: [
        {
          id: uuidv4(),
          type: 'terminal',
          ptyId: tab.ptyId,
          terminalType: tab.type,
          sshConfig: tab.sshConfig,
          sshSessionId: tab.sshSessionId,
          label: t('terminal.split.label.main'),
          isActive: true,
          size: 100
        }
      ]
    }
  }

  /**
   * 获取布局中的所有终端窗格
   */
  // ==================== 文档管理 ====================

  /**
   * 获取终端的上传文档
   */
  function getUploadedDocs(tabId: string): ParsedDocument[] {
    const tab = tabs.value.find(t => t.id === tabId)
    return tab?.uploadedDocs || []
  }

  /**
   * 设置终端的上传文档（替换模式，不是追加）
   */
  function setUploadedDocs(tabId: string, docs: ParsedDocument[]): void {
    const tab = tabs.value.find(t => t.id === tabId)
    if (tab) {
      tab.uploadedDocs = docs
    }
  }

  /**
   * 添加文档到终端（追加到现有列表）
   */
  function addUploadedDocs(tabId: string, docs: ParsedDocument[]): void {
    const tab = tabs.value.find(t => t.id === tabId)
    if (tab) {
      if (!tab.uploadedDocs) {
        tab.uploadedDocs = []
      }
      tab.uploadedDocs = [...tab.uploadedDocs, ...docs]
    }
  }

  /**
   * 移除终端的指定文档
   */
  function removeUploadedDoc(tabId: string, index: number): void {
    const tab = tabs.value.find(t => t.id === tabId)
    if (tab?.uploadedDocs) {
      tab.uploadedDocs.splice(index, 1)
    }
  }

  /**
   * 清空终端的所有文档
   */
  function clearUploadedDocs(tabId: string): void {
    const tab = tabs.value.find(t => t.id === tabId)
    if (tab) {
      tab.uploadedDocs = []
    }
  }

  // ==================== 屏幕服务管理 ====================

  /**
   * 注册屏幕服务实例
   * 由 Terminal.vue 组件在创建时调用
   * @param ptyId 终端实例 ID（改为使用 ptyId 而不是 tabId，以支持分屏）
   */
  function registerScreenService(ptyId: string, service: TerminalScreenService): void {
    screenServices.set(ptyId, service)
  }

  /**
   * 注销屏幕服务实例
   * 由 Terminal.vue 组件在销毁时调用
   * @param ptyId 终端实例 ID
   */
  function unregisterScreenService(ptyId: string): void {
    screenServices.delete(ptyId)
  }

  /**
   * 获取屏幕服务实例
   * @param ptyId 终端实例 ID
   */
  function getScreenService(ptyId: string): TerminalScreenService | undefined {
    return screenServices.get(ptyId)
  }

  /**
   * 获取终端屏幕内容
   * 比 getRecentOutput 更准确，直接从 xterm buffer 读取
   * @param ptyId 终端实例 ID
   */
  function getScreenContent(ptyId: string): ScreenContent | null {
    const service = screenServices.get(ptyId)
    if (!service) return null
    return service.getScreenContent()
  }

  /**
   * 获取终端最近 N 行（从屏幕服务获取，更准确）
   * @param ptyId 终端实例 ID
   */
  function getScreenLastNLines(ptyId: string, n: number): string[] {
    const service = screenServices.get(ptyId)
    if (!service) {
      // 降级到 outputBuffer（通过 ptyId 查找 tab）
      const tab = tabs.value.find(t => t.ptyId === ptyId)
      if (!tab?.outputBuffer) return []
      return tab.outputBuffer.slice(-n).map(line => stripAnsi(line))
    }
    return service.getLastNLines(n)
  }

  /**
   * 检测终端是否处于命令提示符状态
   * @param ptyId 终端实例 ID
   */
  function isTerminalAtPrompt(ptyId: string): boolean {
    const service = screenServices.get(ptyId)
    if (!service) return false
    return service.isAtPrompt()
  }

  /**
   * 获取终端光标位置
   * @param ptyId 终端实例 ID
   */
  function getCursorPosition(ptyId: string): { x: number; y: number } | null {
    const service = screenServices.get(ptyId)
    if (!service) return null
    return service.getCursorPosition()
  }

  /**
   * 检测终端屏幕中的错误信息
   * @param ptyId 终端实例 ID
   */
  function detectScreenErrors(ptyId: string, maxLines?: number): Array<{ line: number; content: string; type: string }> {
    const service = screenServices.get(ptyId)
    if (!service) return []
    return service.detectErrors(maxLines)
  }

  // ==================== 快照管理器管理 ====================

  /**
   * 注册快照管理器实例
   */
  function registerSnapshotManager(tabId: string, manager: TerminalSnapshotManager): void {
    snapshotManagers.set(tabId, manager)
  }

  /**
   * 注销快照管理器实例
   */
  function unregisterSnapshotManager(tabId: string): void {
    snapshotManagers.delete(tabId)
  }

  /**
   * 获取快照管理器实例
   */
  function getSnapshotManager(tabId: string): TerminalSnapshotManager | undefined {
    return snapshotManagers.get(tabId)
  }

  /**
   * 创建终端状态快照
   */
  function createSnapshot(tabId: string, name?: string): TerminalSnapshot | null {
    const manager = snapshotManagers.get(tabId)
    if (!manager) return null
    return manager.createSnapshot(name)
  }

  /**
   * 创建快照并与上一个比较
   */
  function snapshotAndCompare(tabId: string): { snapshot: TerminalSnapshot; diff: TerminalDiff | null } | null {
    const manager = snapshotManagers.get(tabId)
    if (!manager) return null
    return manager.snapshotAndCompare()
  }

  /**
   * 检查终端内容是否变化
   */
  function hasContentChanged(tabId: string): boolean {
    const manager = snapshotManagers.get(tabId)
    if (!manager) return true
    return manager.hasContentChanged()
  }

  /**
   * 获取自上次快照以来的新输出
   */
  function getNewOutputSinceLastSnapshot(tabId: string): string[] {
    const manager = snapshotManagers.get(tabId)
    if (!manager) return []
    return manager.getNewOutputSinceLastSnapshot()
  }

  /**
   * 更新快照管理器的外部状态
   */
  function updateSnapshotExternalState(tabId: string, state: {
    cwd?: string
    lastCommand?: string
    lastExitCode?: number
    isIdle?: boolean
  }): void {
    const manager = snapshotManagers.get(tabId)
    if (manager) {
      manager.updateExternalState(state)
    }
  }

  /**
   * 检查指定终端是否有待确认操作
   */
  function hasPendingConfirm(tabId: string): boolean {
    const tab = tabs.value.find(t => t.id === tabId)
    return !!tab?.agentState?.pendingConfirm
  }

  // Proactive 消息延迟投递：agent 忙时暂存，完成后再注入 tab
  const deferredProactiveTabs = ref(new Set<string>())

  function markDeferredProactive(tabId: string): void {
    deferredProactiveTabs.value = new Set([...deferredProactiveTabs.value, tabId])
  }

  function hasDeferredProactive(tabId: string): boolean {
    return deferredProactiveTabs.value.has(tabId)
  }

  function clearDeferredProactive(tabId: string): void {
    if (!deferredProactiveTabs.value.has(tabId)) return
    const next = new Set(deferredProactiveTabs.value)
    next.delete(tabId)
    deferredProactiveTabs.value = next
  }

  return {
    tabs,
    activeTabId,
    activeTab,
    tabCount,
    pendingFocusTabId,
    isSplitTab,
    getActivePtyId,
    getAllTabPtyIds,
    createTab,
    createAssistantTab,
    createTabWithExistingPty,
    createTabWithTask,
    pendingSchedulerTasks,
    consumePendingSchedulerTask,
    closeTab,
    reconnectSsh,
    setActiveTab,
    updateTabTitle,
    updateConnectionStatus,
    updateSystemInfo,
    appendOutput,
    clearError,
    updateSelectedText,
    getRecentOutput,
    writeToTerminal,
    resizeTerminal,
    writeToPty,
    resizePty,
    splitTerminal,
    getLastSplitError,
    closePane: closePaneInternal,
    setActivePaneInTab,
    updatePaneSize,
    reorderTabs,
    getAiMessages,
    addAiMessage,
    updateAiMessage,
    clearAiMessages,
    setAiLoading,
    setAiScrollNearBottom,
    getAiScrollNearBottom,
    setAiScrollTop,
    getAiScrollTop,
    focusTerminal,
    clearPendingFocus,
    // Agent 状态管理
    findTabIdByAgentId,
    findTabIdByPtyId,
    getAgentState,
    setAgentRunning,
    setAgentSession,
    setAgentId,
    addAgentStep,
    removeAgentStep,
    setAgentPendingConfirm,
    clearAgentState,
    setAgentFinalResult,
    restoreAgentHistory,
    getAgentContext,
    // 文档管理
    getUploadedDocs,
    setUploadedDocs,
    addUploadedDocs,
    removeUploadedDoc,
    clearUploadedDocs,
    // 屏幕服务管理
    registerScreenService,
    unregisterScreenService,
    getScreenService,
    getScreenContent,
    getScreenLastNLines,
    isTerminalAtPrompt,
    getCursorPosition,
    detectScreenErrors,
    // 快照管理器管理
    registerSnapshotManager,
    unregisterSnapshotManager,
    getSnapshotManager,
    createSnapshot,
    snapshotAndCompare,
    hasContentChanged,
    getNewOutputSinceLastSnapshot,
    updateSnapshotExternalState,
    hasPendingConfirm,
    // Proactive 消息延迟投递
    markDeferredProactive,
    hasDeferredProactive,
    clearDeferredProactive
  }
})

