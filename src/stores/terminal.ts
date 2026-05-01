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
}

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

export const useTerminalStore = defineStore('terminal', () => {
  // 状态
  const tabs = ref<TerminalTab[]>([])
  const activeTabId = ref<string>('')
  const splitLayout = ref<SplitPane | null>(null)
  
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
   * 向终端写入数据
   */
  async function writeToTerminal(tabId: string, data: string): Promise<void> {
    const tab = tabs.value.find(t => t.id === tabId)
    if (!tab?.ptyId) return

    if (tab.type === 'local') {
      await window.electronAPI.pty.write(tab.ptyId, data)
    } else {
      await window.electronAPI.ssh.write(tab.ptyId, data)
    }
  }

  /**
   * 调整终端大小
   */
  async function resizeTerminal(tabId: string, cols: number, rows: number): Promise<void> {
    const tab = tabs.value.find(t => t.id === tabId)
    if (!tab?.ptyId) return

    if (tab.type === 'local') {
      await window.electronAPI.pty.resize(tab.ptyId, cols, rows)
    } else {
      await window.electronAPI.ssh.resize(tab.ptyId, cols, rows)
    }
  }

  /**
   * 创建分屏
   * 将当前激活的终端分割为两个窗格
   */
  async function splitTerminal(direction: 'horizontal' | 'vertical'): Promise<string | null> {
    const currentTab = activeTab.value
    if (!currentTab) {
      log.warn('No active tab to split')
      return null
    }

    // 如果当前 tab 还没有分屏布局，创建初始布局
    if (!currentTab.splitLayout) {
      // 创建新的终端实例
      const newPtyId = await createNewTerminalInstance(currentTab)
      if (!newPtyId) return null

      // 创建分屏布局：原终端 + 新终端
      const originalPane: SplitPane = {
        id: uuidv4(),
        type: 'terminal',
        ptyId: currentTab.ptyId,
        terminalType: currentTab.type,
        sshConfig: currentTab.sshConfig,
        sshSessionId: currentTab.sshSessionId,
        label: getPositionLabel(direction, 0),
        isActive: false,
        size: 50
      }

      const newPane: SplitPane = {
        id: uuidv4(),
        type: 'terminal',
        ptyId: newPtyId,
        terminalType: currentTab.type,
        sshConfig: currentTab.sshConfig,
        sshSessionId: currentTab.sshSessionId,
        label: getPositionLabel(direction, 1),
        isActive: true,
        size: 50
      }

      currentTab.splitLayout = {
        id: uuidv4(),
        type: 'split',
        direction,
        children: [originalPane, newPane]
      }

      // 重要：清空 tab.ptyId，进入分屏模式
      currentTab.ptyId = undefined

      log.debug('Created initial split layout:', direction)
      return newPane.id
    } else {
      // 已有分屏布局，在当前激活的窗格上分割
      const activePane = findActivePaneInLayout(currentTab.splitLayout)
      if (!activePane) {
        log.warn('No active pane found in split layout')
        return null
      }

      // 创建新的终端实例
      const newPtyId = await createNewTerminalInstance(currentTab)
      if (!newPtyId) return null

      // 将当前窗格替换为一个分割容器
      const newPane: SplitPane = {
        id: uuidv4(),
        type: 'terminal',
        ptyId: newPtyId,
        terminalType: currentTab.type,
        sshConfig: currentTab.sshConfig,
        sshSessionId: currentTab.sshSessionId,
        label: 'New',
        isActive: true,
        size: 50
      }

      // 将原窗格标记为非激活
      activePane.isActive = false
      activePane.size = 50

      // 创建新的分割容器
      const splitContainer: SplitPane = {
        id: uuidv4(),
        type: 'split',
        direction,
        children: [
          { ...activePane },
          newPane
        ]
      }

      // 替换原窗格
      replacePaneInLayout(currentTab.splitLayout, activePane.id, splitContainer)

      // 更新所有窗格的标签
      updatePaneLabels(currentTab.splitLayout)

      log.debug('Split active pane:', direction)
      return newPane.id
    }
  }

  /**
   * 创建新的终端实例（用于分屏）
   */
  async function createNewTerminalInstance(tab: TerminalTab): Promise<string | null> {
    try {
      if (tab.type === 'local') {
        const configStore = useConfigStore()
        const localEncoding = configStore.terminalSettings.localEncoding || 'auto'

        const ptyId = await window.electronAPI.pty.create({
          cols: 80,
          rows: 24,
          encoding: localEncoding
        })
        return ptyId
      } else if (tab.type === 'ssh' && tab.sshSessionId) {
        // 从 configStore 获取完整的 SSH 配置
        const configStore = useConfigStore()
        const session = configStore.sshSessions.find(s => s.id === tab.sshSessionId)
        if (!session) {
          log.error('SSH session not found:', tab.sshSessionId)
          return null
        }

        const jumpHost = configStore.getEffectiveJumpHost(session)

        const sshId = await window.electronAPI.ssh.connect({
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
        return sshId
      }
      return null
    } catch (error) {
      log.error('Failed to create terminal instance:', error)
      return null
    }
  }

  /**
   * 获取窗格位置标签
   */
  function getPositionLabel(direction: 'horizontal' | 'vertical', index: number): string {
    if (direction === 'horizontal') {
      return index === 0 ? '左侧' : '右侧'
    } else {
      return index === 0 ? '上方' : '下方'
    }
  }

  /**
   * 在布局中查找激活的窗格
   */
  function findActivePaneInLayout(layout: SplitPane): SplitPane | null {
    if (layout.type === 'terminal') {
      return layout.isActive ? layout : null
    }

    if (layout.children) {
      for (const child of layout.children) {
        const found = findActivePaneInLayout(child)
        if (found) return found
      }
    }

    return null
  }

  /**
   * 在布局中替换窗格
   */
  function replacePaneInLayout(layout: SplitPane, paneId: string, newPane: SplitPane): boolean {
    if (layout.children) {
      for (let i = 0; i < layout.children.length; i++) {
        if (layout.children[i].id === paneId) {
          layout.children[i] = newPane
          return true
        }
        if (replacePaneInLayout(layout.children[i], paneId, newPane)) {
          return true
        }
      }
    }
    return false
  }

  /**
   * 更新所有窗格的标签
   */
  function updatePaneLabels(layout: SplitPane, path: string = ''): void {
    if (layout.type === 'terminal') {
      layout.label = path || '主窗格'
      return
    }

    if (layout.children) {
      layout.children.forEach((child, index) => {
        const position = layout.direction === 'horizontal'
          ? (index === 0 ? '左' : '右')
          : (index === 0 ? '上' : '下')
        const newPath = path ? `${path}-${position}` : position
        updatePaneLabels(child, newPath)
      })
    }
  }

  /**
   * 关闭分屏窗格
   * 如果只剩一个窗格，则清除分屏布局
   */
  async function closePane(tabId: string, paneId: string): Promise<void> {
    const tab = tabs.value.find(t => t.id === tabId)
    if (!tab?.splitLayout) return

    const pane = findPaneById(tab.splitLayout, paneId)
    if (!pane) return

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
    if (allPanes.length <= 2) {
      // 只剩两个窗格，关闭一个后恢复到单终端模式
      const remainingPane = allPanes.find(p => p.id !== paneId)
      if (remainingPane) {
        // 重要：恢复 tab.ptyId，退出分屏模式
        tab.ptyId = remainingPane.ptyId
        tab.splitLayout = null
        log.debug('Restored to single terminal mode, ptyId:', tab.ptyId)
      }
    } else {
      // 多个窗格，移除指定窗格并重新组织布局
      removePaneFromLayout(tab.splitLayout, paneId)
      updatePaneLabels(tab.splitLayout)

      // 如果关闭的是激活窗格，激活第一个窗格
      if (pane.isActive) {
        const firstPane = getAllTerminalPanes(tab.splitLayout)[0]
        if (firstPane) {
          setActivePaneInTab(tabId, firstPane.id)
        }
      }
    }
  }

  /**
   * 设置激活的窗格
   */
  function setActivePaneInTab(tabId: string, paneId: string): void {
    const tab = tabs.value.find(t => t.id === tabId)
    if (!tab?.splitLayout) return

    // 取消所有窗格的激活状态
    const allPanes = getAllTerminalPanes(tab.splitLayout)
    allPanes.forEach(p => p.isActive = false)

    // 激活指定窗格
    const targetPane = findPaneById(tab.splitLayout, paneId)
    if (targetPane) {
      targetPane.isActive = true
    }
  }

  /**
   * 根据 ID 查找窗格
   */
  function findPaneById(layout: SplitPane, paneId: string): SplitPane | null {
    if (layout.id === paneId) {
      return layout
    }

    if (layout.children) {
      for (const child of layout.children) {
        const found = findPaneById(child, paneId)
        if (found) return found
      }
    }

    return null
  }

  /**
   * 从布局中移除窗格
   */
  function removePaneFromLayout(layout: SplitPane, paneId: string): boolean {
    if (!layout.children) return false

    // 查找包含目标窗格的父节点
    for (let i = 0; i < layout.children.length; i++) {
      if (layout.children[i].id === paneId) {
        // 找到了，移除这个子节点
        layout.children.splice(i, 1)

        // 如果父节点只剩一个子节点，将其提升
        if (layout.children.length === 1) {
          const remainingChild = layout.children[0]
          Object.assign(layout, remainingChild)
        }

        return true
      }

      // 递归查找
      if (removePaneFromLayout(layout.children[i], paneId)) {
        return true
      }
    }

    return false
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
   */
  function findTabIdByPtyId(ptyId: string): string | undefined {
    const tab = tabs.value.find(t => t.ptyId === ptyId)
    return tab?.id
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
   */
  function getAgentContext(tabId: string) {
    const tab = tabs.value.find(t => t.id === tabId)
    if (!tab) return null

    // 检查是否有分屏布局
    if (tab.splitLayout) {
      // 多屏模式：收集所有终端窗格的信息
      const panes = getAllTerminalPanes(tab.splitLayout)
      const activePaneId = findActivePaneInLayout(tab.splitLayout)?.id

      const panesContext = panes.map(pane => {
        // 为每个窗格获取屏幕服务（通过 ptyId 查找对应的 screenService）
        // 注意：screenServices 是按 tabId 存储的，但分屏后每个窗格有独立的 ptyId
        // 我们需要一个新的映射机制，暂时先用 ptyId 作为 key
        const screenService = screenServices.get(pane.ptyId || '')
        let terminalOutput: string[] = []

        if (screenService) {
          terminalOutput = screenService.getLastNLines(50)
        }

        return {
          paneId: pane.id,
          ptyId: pane.ptyId || '',
          label: pane.label || 'Unknown',
          isActive: pane.id === activePaneId,
          terminalOutput,
          terminalType: pane.terminalType || tab.type
        }
      })

      return JSON.parse(JSON.stringify({
        mode: 'split',
        activePaneId,
        panes: panesContext,
        systemInfo: {
          os: tab.systemInfo?.os || 'unknown',
          shell: tab.systemInfo?.shell || 'unknown'
        }
      }))
    } else {
      // 单屏模式：保持原有逻辑
      const screenService = screenServices.get(tab.ptyId || '')
      let terminalOutput: string[]

      if (screenService) {
        terminalOutput = screenService.getLastNLines(50)
      } else {
        terminalOutput = (tab.outputBuffer || [])
          .slice(-50)
          .map(line => stripAnsi(line))
      }

      return JSON.parse(JSON.stringify({
        mode: 'single',
        ptyId: tab.ptyId || '',
        terminalOutput,
        systemInfo: {
          os: tab.systemInfo?.os || 'unknown',
          shell: tab.systemInfo?.shell || 'unknown'
        },
        terminalType: tab.type
      }))
    }
  }

  /**
   * 获取布局中的所有终端窗格
   */
  function getAllTerminalPanes(layout: SplitPane): SplitPane[] {
    if (layout.type === 'terminal') {
      return [layout]
    }

    const panes: SplitPane[] = []
    if (layout.children) {
      for (const child of layout.children) {
        panes.push(...getAllTerminalPanes(child))
      }
    }

    return panes
  }

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
    splitLayout,
    pendingFocusTabId,
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
    splitTerminal,
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

