import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { v4 as uuidv4 } from 'uuid'

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

// Agent 相关类型
export type RiskLevel = 'safe' | 'moderate' | 'dangerous' | 'blocked'

export interface AgentStep {
  id: string
  type: 'thinking' | 'tool_call' | 'tool_result' | 'message' | 'error' | 'confirm' | 'user_task' | 'final_result'
  content: string
  toolName?: string
  toolArgs?: Record<string, unknown>
  toolResult?: string
  riskLevel?: RiskLevel
  timestamp: number
}

export interface PendingConfirmation {
  agentId: string
  toolCallId: string
  toolName: string
  toolArgs: Record<string, unknown>
  riskLevel: RiskLevel
}

// Agent 历史任务记录（完整保存执行过程）
export interface AgentHistoryItem {
  userTask: string        // 用户任务描述
  steps: AgentStep[]      // 完整的执行步骤
  finalResult: string     // Agent 完成后的回复
  timestamp: number       // 时间戳
}

export interface AgentState {
  isRunning: boolean
  agentId?: string
  userTask?: string      // 用户任务描述
  steps: AgentStep[]
  pendingConfirm?: PendingConfirmation
  finalResult?: string   // Agent 完成后的最终回复
  history: AgentHistoryItem[]  // 历史任务记录
}

export interface TerminalTab {
  id: string
  title: string
  type: 'local' | 'ssh'
  ptyId?: string
  sshConfig?: {
    host: string
    port: number
    username: string
  }
  systemInfo?: SystemInfo
  isConnected: boolean
  isLoading: boolean
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
  // Agent 状态（每个终端独立）
  agentState?: AgentState
}

export interface SplitPane {
  id: string
  type: 'terminal' | 'split'
  direction?: 'horizontal' | 'vertical'
  children?: SplitPane[]
  tabId?: string
  size?: number
}

export const useTerminalStore = defineStore('terminal', () => {
  // 状态
  const tabs = ref<TerminalTab[]>([])
  const activeTabId = ref<string>('')
  const splitLayout = ref<SplitPane | null>(null)
  // 待发送到 AI 分析的文本
  const pendingAiText = ref<string>('')
  // 终端计数器（用于生成唯一标题）
  const localTerminalCounter = ref(0)
  const sshTerminalCounters = ref<Record<string, number>>({})
  // 需要获得焦点的终端 ID（用于从 AI 助手发送代码后自动聚焦）
  const pendingFocusTabId = ref<string>('')

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
        content: output.trim().slice(0, 500), // 限制长度
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
   * 发送文本到 AI 分析
   */
  function sendToAi(text: string): void {
    pendingAiText.value = text
  }

  /**
   * 清除待发送的 AI 文本
   */
  function clearPendingAiText(): void {
    pendingAiText.value = ''
  }

  /**
   * 获取终端最近的输出
   */
  function getRecentOutput(tabId: string, lines: number = 20): string {
    const tab = tabs.value.find(t => t.id === tabId)
    if (!tab?.outputBuffer) return ''
    return tab.outputBuffer.slice(-lines).join('\n')
  }

  /**
   * 创建新标签页
   */
  async function createTab(
    type: 'local' | 'ssh',
    sshConfig?: { host: string; port: number; username: string; password?: string; privateKey?: string },
    shell?: string  // 本地终端可指定 shell (cmd/powershell/bash 等)
  ): Promise<string> {
    const id = uuidv4()
    
    // 生成唯一标题
    let title: string
    if (type === 'local') {
      localTerminalCounter.value++
      const shellName = shell ? (shell.includes('powershell') ? 'PowerShell' : shell.includes('cmd') ? 'CMD' : shell.split(/[/\\]/).pop()) : ''
      title = shellName ? `${shellName} ${localTerminalCounter.value}` : `本地终端 ${localTerminalCounter.value}`
    } else if (sshConfig) {
      const sshKey = `${sshConfig.username}@${sshConfig.host}`
      sshTerminalCounters.value[sshKey] = (sshTerminalCounters.value[sshKey] || 0) + 1
      const count = sshTerminalCounters.value[sshKey]
      title = count > 1 ? `${sshKey} (${count})` : sshKey
    } else {
      title = 'SSH 终端'
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
    }

    tabs.value.push(tab)
    activeTabId.value = id

    // 获取响应式 tab 对象的引用
    const reactiveTab = tabs.value.find(t => t.id === id)!

    // 初始化终端连接
    try {
      if (type === 'local') {
        const ptyId = await window.electronAPI.pty.create({
          cols: 80,
          rows: 24,
          shell: shell
        })
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
          privateKey: sshConfig.privateKey,
          cols: 80,
          rows: 24
        })
        reactiveTab.ptyId = sshId
        reactiveTab.isConnected = true
        // SSH 连接默认假设是 Linux/Unix 系统
        reactiveTab.systemInfo = {
          os: 'linux',
          shell: 'bash',
          description: `SSH 连接: ${sshConfig.username}@${sshConfig.host}`
        }
      }
    } catch (error) {
      console.error('Failed to create terminal:', error)
      reactiveTab.isConnected = false
    } finally {
      reactiveTab.isLoading = false
    }

    return id
  }

  /**
   * 关闭标签页
   */
  async function closeTab(tabId: string): Promise<void> {
    const tab = tabs.value.find(t => t.id === tabId)
    if (!tab) return

    // 清理终端连接
    if (tab.ptyId) {
      if (tab.type === 'local') {
        await window.electronAPI.pty.dispose(tab.ptyId)
      } else {
        await window.electronAPI.ssh.disconnect(tab.ptyId)
      }
    }

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
   */
  function splitTerminal(direction: 'horizontal' | 'vertical'): void {
    // TODO: 实现分屏逻辑
    console.log('Split terminal:', direction)
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
    const tabIndex = tabs.value.findIndex(t => t.id === tabId)
    if (tabIndex === -1) return

    const tab = tabs.value[tabIndex]

    if (!tab.agentState) {
      tab.agentState = {
        isRunning: false,
        steps: [],
        history: []
      }
    }
    
    // 创建新的 agentState 对象以确保响应式更新
    const newAgentState = {
      ...tab.agentState,
      isRunning,
      ...(agentId !== undefined && { agentId }),
      ...(userTask !== undefined && { userTask }),
      ...(!isRunning && { pendingConfirm: undefined })
    }
    
    // 直接替换整个 tab 对象以确保响应式
    tabs.value[tabIndex] = {
      ...tab,
      agentState: newAgentState
    }
    
    // 触发 ref 更新
    tabs.value = tabs.value.slice()
  }

  /**
   * 添加或更新 Agent 执行步骤
   * 如果步骤 id 已存在，则更新；否则添加新步骤
   */
  function addAgentStep(tabId: string, step: AgentStep): void {
    const tab = tabs.value.find(t => t.id === tabId)
    if (!tab) return

    if (!tab.agentState) {
      tab.agentState = {
        isRunning: false,
        steps: [],
        history: []
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
   * 清空 Agent 当前任务状态（保留历史）
   */
  function clearAgentState(tabId: string, preserveHistory: boolean = true): void {
    const tab = tabs.value.find(t => t.id === tabId)
    if (tab) {
      const existingHistory = preserveHistory ? (tab.agentState?.history || []) : []
      const existingSteps = preserveHistory ? (tab.agentState?.steps || []) : []
      
      // 如果有已完成的任务，保存摘要到历史（用于 AI 上下文）
      if (preserveHistory && tab.agentState?.userTask && tab.agentState?.finalResult) {
        existingHistory.push({
          userTask: tab.agentState.userTask,
          steps: [],  // 历史中不需要保存步骤，UI 中已经保留了
          finalResult: tab.agentState.finalResult,
          timestamp: Date.now()
        })
        // 只保留最近 10 条历史摘要（用于 AI 上下文）
        while (existingHistory.length > 10) {
          existingHistory.shift()
        }
      }
      
      tab.agentState = {
        isRunning: false,
        steps: existingSteps,  // 保留之前的步骤，不清空
        history: existingHistory
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
   * 获取 Agent 上下文（用于发送给后端）
   * 返回纯 JavaScript 对象，确保可以通过 IPC 序列化
   */
  function getAgentContext(tabId: string) {
    const tab = tabs.value.find(t => t.id === tabId)
    if (!tab) return null

    // 使用 JSON.parse(JSON.stringify()) 确保返回纯对象，移除 Proxy
    return JSON.parse(JSON.stringify({
      ptyId: tab.ptyId || '',
      terminalOutput: (tab.outputBuffer || []).slice(-50), // 只取最近50行
      systemInfo: {
        os: tab.systemInfo?.os || 'unknown',
        shell: tab.systemInfo?.shell || 'unknown'
      }
    }))
  }

  return {
    tabs,
    activeTabId,
    activeTab,
    tabCount,
    splitLayout,
    pendingAiText,
    pendingFocusTabId,
    createTab,
    closeTab,
    setActiveTab,
    updateTabTitle,
    updateSystemInfo,
    appendOutput,
    clearError,
    updateSelectedText,
    sendToAi,
    clearPendingAiText,
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
    focusTerminal,
    clearPendingFocus,
    // Agent 状态管理
    getAgentState,
    setAgentRunning,
    addAgentStep,
    setAgentPendingConfirm,
    clearAgentState,
    setAgentFinalResult,
    getAgentContext
  }
})

