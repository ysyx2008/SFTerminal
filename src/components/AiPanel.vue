<script setup lang="ts">
import { ref, computed, nextTick, inject, watch, onMounted, onUnmounted } from 'vue'
import { marked } from 'marked'
import { useConfigStore } from '../stores/config'
import { useTerminalStore } from '../stores/terminal'

const emit = defineEmits<{
  close: []
}>()

const configStore = useConfigStore()
const terminalStore = useTerminalStore()
const showSettings = inject<() => void>('showSettings')

import type { AiMessage, AgentStep } from '../stores/terminal'

const inputText = ref('')
const messagesRef = ref<HTMLDivElement | null>(null)

// Agent 模式状态
const agentMode = ref(true)
const strictMode = ref(true)       // 严格模式（默认开启）
const commandTimeout = ref(10)     // 命令超时时间（秒），默认 10 秒
const collapsedTaskIds = ref<Set<string>>(new Set())  // 已折叠的任务 ID

// 切换任务步骤折叠状态
const toggleStepsCollapse = (taskId: string) => {
  if (collapsedTaskIds.value.has(taskId)) {
    collapsedTaskIds.value.delete(taskId)
  } else {
    collapsedTaskIds.value.add(taskId)
  }
}

// 检查任务是否折叠
const isStepsCollapsed = (taskId: string) => {
  return collapsedTaskIds.value.has(taskId)
}

// 清理事件监听的函数
let cleanupStepListener: (() => void) | null = null
let cleanupConfirmListener: (() => void) | null = null
let cleanupCompleteListener: (() => void) | null = null
let cleanupErrorListener: (() => void) | null = null

// 当前终端的 AI 消息（每个终端独立）
const messages = computed(() => {
  const activeTab = terminalStore.activeTab
  return activeTab?.aiMessages || []
})

// 当前终端 ID
const currentTabId = computed(() => terminalStore.activeTabId)

// 获取当前终端信息（用于历史记录）
const getTerminalInfo = () => {
  const activeTab = terminalStore.activeTab
  if (!activeTab) return null
  return {
    terminalId: activeTab.id,
    terminalType: activeTab.type as 'local' | 'ssh',
    sshHost: activeTab.sshConfig?.host
  }
}

// 当前终端的 AI 加载状态（每个终端独立）
const isLoading = computed(() => {
  const activeTab = terminalStore.activeTab
  return activeTab?.aiLoading || false
})

// Agent 状态
const agentState = computed(() => {
  const activeTab = terminalStore.activeTab
  return activeTab?.agentState
})

const isAgentRunning = computed(() => {
  return agentState.value?.isRunning || false
})

// 监听严格模式变化，实时更新运行中的 Agent
watch(strictMode, async (newValue) => {
  const agentId = agentState.value?.agentId
  if (agentId && isAgentRunning.value) {
    await window.electronAPI.agent.updateConfig(agentId, { strictMode: newValue })
  }
})

// 监听超时设置变化
watch(commandTimeout, async (newValue) => {
  const agentId = agentState.value?.agentId
  if (agentId && isAgentRunning.value) {
    await window.electronAPI.agent.updateConfig(agentId, { commandTimeout: newValue * 1000 })
  }
})

// 按任务分组的步骤（每个任务包含：用户任务 + 步骤块 + 最终结果）
interface AgentTaskGroup {
  id: string
  userTask: string
  steps: AgentStep[]
  finalResult?: string
  isCurrentTask: boolean
}

const agentTaskGroups = computed((): AgentTaskGroup[] => {
  const allSteps = agentState.value?.steps || []
  const groups: AgentTaskGroup[] = []
  let currentGroup: AgentTaskGroup | null = null
  
  for (const step of allSteps) {
    if (step.type === 'user_task') {
      // 开始新任务
      currentGroup = {
        id: step.id,
        userTask: step.content,
        steps: [],
        isCurrentTask: false
      }
      groups.push(currentGroup)
    } else if (step.type === 'final_result') {
      // 结束当前任务
      if (currentGroup) {
        currentGroup.finalResult = step.content
        currentGroup = null
      }
    } else if (step.type !== 'confirm') {
      // 添加到当前任务的步骤
      if (currentGroup) {
        currentGroup.steps.push(step)
      }
    }
  }
  
  // 标记最后一个未完成的任务为当前任务
  if (groups.length > 0) {
    const lastGroup = groups[groups.length - 1]
    if (!lastGroup.finalResult) {
      lastGroup.isCurrentTask = true
    }
  }
  
  // 去除步骤中与 finalResult 重复的最后一个 message
  for (const group of groups) {
    if (group.finalResult && group.steps.length > 0) {
      const lastStep = group.steps[group.steps.length - 1]
      if (lastStep.type === 'message' && lastStep.content === group.finalResult) {
        group.steps = group.steps.slice(0, -1)
      }
    }
  }
  
  return groups
})

const pendingConfirm = computed(() => {
  return agentState.value?.pendingConfirm
})

const agentUserTask = computed(() => {
  return agentState.value?.userTask
})

const hasAiConfig = computed(() => configStore.hasAiConfig)

// AI 配置列表和当前选中的配置
const aiProfiles = computed(() => configStore.aiProfiles)
const activeAiProfile = computed(() => configStore.activeAiProfile)

// 切换 AI 配置
const changeAiProfile = async (profileId: string) => {
  await configStore.setActiveAiProfile(profileId)
}

// 获取当前终端的系统信息
const currentSystemInfo = computed(() => {
  const activeTab = terminalStore.activeTab
  if (activeTab?.systemInfo) {
    return activeTab.systemInfo
  }
  return null
})

// 获取当前终端选中的文本
const terminalSelectedText = computed(() => {
  return terminalStore.activeTab?.selectedText || ''
})

// 获取最近的错误
const lastError = computed(() => {
  return terminalStore.activeTab?.lastError
})

// 估算文本的 token 数量
// 中文：约 1.5 字符/token，英文：约 4 字符/token
function estimateTokens(text: string): number {
  if (!text) return 0
  
  // 统计中文字符数量
  const chineseChars = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length
  // 非中文字符数量
  const otherChars = text.length - chineseChars
  
  // 中文约 1.5 字符/token，英文约 4 字符/token
  return Math.ceil(chineseChars / 1.5 + otherChars / 4)
}

// 计算上下文使用情况
// 这个估算反映的是发送给 AI 的实际上下文大小
const contextStats = computed(() => {
  let totalTokens = 0
  let messageCount = 0
  
  if (agentMode.value) {
    // Agent 模式：计算发送给 AI 的实际上下文
    // 1. System prompt (~200 tokens) + 工具定义 (~400 tokens)
    totalTokens += 600
    
    // 2. 历史任务（作为 user/assistant 消息对发送）
    const history = agentState.value?.history || []
    for (const item of history) {
      totalTokens += estimateTokens(item.userTask) + 3  // user 消息 + 格式开销
      totalTokens += estimateTokens(item.finalResult) + 3  // assistant 消息 + 格式开销
      messageCount += 2
    }
    
    // 3. 当前用户任务
    if (agentUserTask.value) {
      totalTokens += estimateTokens(agentUserTask.value) + 3
      messageCount++
    }
    
    // 4. Agent 执行过程中的消息累积
    // 每个步骤 = AI 回复 + 工具调用 + 工具结果
    const allSteps = agentState.value?.steps || []
    for (const step of allSteps) {
      if (step.type === 'message' || step.type === 'thinking') {
        // AI 的文字回复
        totalTokens += estimateTokens(step.content) + 3
      } else if (step.type === 'tool_call' || step.type === 'tool_result') {
        // 工具调用参数 + 工具结果
        totalTokens += estimateTokens(step.content) + 10  // 工具调用有更多格式开销
        if (step.toolResult) {
          totalTokens += estimateTokens(step.toolResult) + 5
        }
      }
    }
  } else {
    // 普通对话模式
    // System prompt (~100 tokens)
    totalTokens += 100
    
    const msgs = messages.value.filter(msg => !msg.content.includes('中...'))
    messageCount = msgs.length
    
    for (const msg of msgs) {
      totalTokens += estimateTokens(msg.content)
      // 每条消息格式开销（role 标记等）约 3 tokens
      totalTokens += 3
    }
  }
  
  // 从当前 AI 配置获取上下文长度，默认 8000
  const maxTokens = activeAiProfile.value?.contextLength || 8000
  
  return {
    messageCount,
    tokenEstimate: totalTokens,
    maxTokens,
    percentage: Math.min(100, Math.round((totalTokens / maxTokens) * 100))
  }
})



// 生成系统信息的提示词
const getSystemPrompt = () => {
  const info = currentSystemInfo.value
  let systemContext = ''
  
  if (info) {
    const osNames: Record<string, string> = {
      windows: 'Windows',
      linux: 'Linux',
      macos: 'macOS',
      unknown: '未知操作系统'
    }
    const shellNames: Record<string, string> = {
      powershell: 'PowerShell',
      cmd: 'CMD (命令提示符)',
      bash: 'Bash',
      zsh: 'Zsh',
      sh: 'Shell',
      unknown: '未知 Shell'
    }
    
    systemContext = `当前用户使用的是 ${osNames[info.os]} 系统，Shell 类型是 ${shellNames[info.shell]}。`
    if (info.description) {
      systemContext += ` (${info.description})`
    }
    systemContext += ' 请根据这个环境给出准确的命令和建议。'
  } else {
    systemContext = `当前操作系统平台: ${navigator.platform}。`
  }
  
  return `你是旗鱼终端的 AI 助手，专门帮助运维人员解决命令行相关问题。${systemContext} 请用中文回答，回答要简洁实用。`
}

// 滚动到底部
const scrollToBottom = async () => {
  await nextTick()
  if (messagesRef.value) {
    messagesRef.value.scrollTop = messagesRef.value.scrollHeight
  }
}

// 发送消息
const sendMessage = async () => {
  if (!inputText.value.trim() || isLoading.value || !currentTabId.value) return

  const tabId = currentTabId.value
  const userMessage: AiMessage = {
    id: Date.now().toString(),
    role: 'user',
    content: inputText.value,
    timestamp: new Date()
  }

  terminalStore.addAiMessage(tabId, userMessage)
  inputText.value = ''
  terminalStore.setAiLoading(tabId, true)
  await scrollToBottom()

  // 创建 AI 响应占位
  const assistantMessage: AiMessage = {
    id: (Date.now() + 1).toString(),
    role: 'assistant',
    content: '思考中...',
    timestamp: new Date()
  }
  const messageIndex = terminalStore.addAiMessage(tabId, assistantMessage)
  await scrollToBottom()

  try {
    let firstChunk = true
    
    // 构建包含历史对话的消息列表
    const currentMessages = terminalStore.getAiMessages(tabId)
    // 过滤掉占位消息（内容包含"中..."的），并转换格式
    const historyMessages = currentMessages
      .filter(msg => !msg.content.includes('中...'))
      .map(msg => ({
        role: msg.role as 'user' | 'assistant',
        content: msg.content
      }))
    
    // 使用流式响应，传入 tabId 作为 requestId 支持多终端同时请求
    window.electronAPI.ai.chatStream(
      [
        {
          role: 'system',
          content: getSystemPrompt()
        },
        ...historyMessages
      ],
      chunk => {
        const currentContent = terminalStore.getAiMessages(tabId)[messageIndex]?.content || ''
        if (firstChunk) {
          terminalStore.updateAiMessage(tabId, messageIndex, chunk)
          firstChunk = false
        } else {
          terminalStore.updateAiMessage(tabId, messageIndex, currentContent + chunk)
        }
        scrollToBottom()
      },
      () => {
        terminalStore.setAiLoading(tabId, false)
        scrollToBottom()
        
        // 保存聊天记录
        const terminalInfo = getTerminalInfo()
        if (terminalInfo) {
          const finalContent = terminalStore.getAiMessages(tabId)[messageIndex]?.content || ''
          window.electronAPI.history.saveChatRecords([
            {
              id: userMessage.id,
              timestamp: userMessage.timestamp.getTime(),
              ...terminalInfo,
              role: 'user',
              content: userMessage.content
            },
            {
              id: assistantMessage.id,
              timestamp: Date.now(),
              ...terminalInfo,
              role: 'assistant',
              content: finalContent
            }
          ])
        }
      },
      error => {
        terminalStore.updateAiMessage(tabId, messageIndex, `错误: ${error}`)
        terminalStore.setAiLoading(tabId, false)
      },
      undefined,  // profileId
      tabId       // requestId - 使用 tabId 区分不同终端的请求
    )
  } catch (error) {
    terminalStore.updateAiMessage(tabId, messageIndex, `错误: ${error}`)
    terminalStore.setAiLoading(tabId, false)
  }
}

// 解释命令
const explainCommand = async (command: string) => {
  if (isLoading.value || !currentTabId.value) return

  const tabId = currentTabId.value
  const userMessage: AiMessage = {
    id: Date.now().toString(),
    role: 'user',
    content: `请解释这个命令：\`${command}\``,
    timestamp: new Date()
  }
  terminalStore.addAiMessage(tabId, userMessage)
  terminalStore.setAiLoading(tabId, true)
  await scrollToBottom()

  const assistantMessage: AiMessage = {
    id: (Date.now() + 1).toString(),
    role: 'assistant',
    content: '分析中...',
    timestamp: new Date()
  }
  const messageIndex = terminalStore.addAiMessage(tabId, assistantMessage)
  await scrollToBottom()

  let firstChunk = true
  const info = currentSystemInfo.value
  const osContext = info ? `当前用户使用的是 ${info.os === 'windows' ? 'Windows' : info.os === 'macos' ? 'macOS' : 'Linux'} 系统，Shell 类型是 ${info.shell}。` : ''
  
  window.electronAPI.ai.chatStream(
    [
      {
        role: 'system',
        content: `你是一个专业的系统管理员助手。${osContext}用户会给你一个命令，请用中文简洁地解释这个命令的作用、参数含义，以及可能的注意事项。`
      },
      { role: 'user', content: `请解释这个命令：\n\`\`\`\n${command}\n\`\`\`` }
    ],
    chunk => {
      const currentContent = terminalStore.getAiMessages(tabId)[messageIndex]?.content || ''
      if (firstChunk) {
        terminalStore.updateAiMessage(tabId, messageIndex, chunk)
        firstChunk = false
      } else {
        terminalStore.updateAiMessage(tabId, messageIndex, currentContent + chunk)
      }
      scrollToBottom()
    },
    () => {
      terminalStore.setAiLoading(tabId, false)
      scrollToBottom()
    },
    error => {
      terminalStore.updateAiMessage(tabId, messageIndex, `错误: ${error}`)
      terminalStore.setAiLoading(tabId, false)
    },
    undefined,
    tabId
  )
}

// 生成命令
const generateCommand = async (description: string) => {
  if (isLoading.value || !currentTabId.value) return

  const tabId = currentTabId.value
  const userMessage: AiMessage = {
    id: Date.now().toString(),
    role: 'user',
    content: description,
    timestamp: new Date()
  }
  terminalStore.addAiMessage(tabId, userMessage)
  terminalStore.setAiLoading(tabId, true)
  await scrollToBottom()

  const assistantMessage: AiMessage = {
    id: (Date.now() + 1).toString(),
    role: 'assistant',
    content: '生成中...',
    timestamp: new Date()
  }
  const messageIndex = terminalStore.addAiMessage(tabId, assistantMessage)
  await scrollToBottom()

  let firstChunk = true
  const info = currentSystemInfo.value
  let systemContext = ''
  if (info) {
    const osNames: Record<string, string> = { windows: 'Windows', linux: 'Linux', macos: 'macOS', unknown: '未知' }
    const shellNames: Record<string, string> = { powershell: 'PowerShell', cmd: 'CMD', bash: 'Bash', zsh: 'Zsh', sh: 'Shell', unknown: '未知' }
    systemContext = `当前操作系统是 ${osNames[info.os]}，Shell 类型是 ${shellNames[info.shell]}。请生成适合该环境的命令。`
  } else {
    systemContext = `当前操作系统平台: ${navigator.platform}。`
  }
  
  window.electronAPI.ai.chatStream(
    [
      {
        role: 'system',
        content: `你是一个专业的命令行助手。${systemContext} 用户会用自然语言描述他想做的事情，请生成对应的命令并简要解释。`
      },
      { role: 'user', content: description }
    ],
    chunk => {
      const currentContent = terminalStore.getAiMessages(tabId)[messageIndex]?.content || ''
      if (firstChunk) {
        terminalStore.updateAiMessage(tabId, messageIndex, chunk)
        firstChunk = false
      } else {
        terminalStore.updateAiMessage(tabId, messageIndex, currentContent + chunk)
      }
      scrollToBottom()
    },
    () => {
      terminalStore.setAiLoading(tabId, false)
      scrollToBottom()
    },
    error => {
      terminalStore.updateAiMessage(tabId, messageIndex, `错误: ${error}`)
      terminalStore.setAiLoading(tabId, false)
    },
    undefined,
    tabId
  )
}

// 清空对话（包括 Agent 状态和历史）
const clearMessages = () => {
  if (currentTabId.value) {
    terminalStore.clearAiMessages(currentTabId.value)
    terminalStore.clearAgentState(currentTabId.value, false)  // 不保留历史
  }
}

// 停止生成
const stopGeneration = async () => {
  if (currentTabId.value) {
    // 传入 tabId 只中止当前终端的请求，不影响其他终端
    await window.electronAPI.ai.abort(currentTabId.value)
    terminalStore.setAiLoading(currentTabId.value, false)
  }
}

// 诊断错误
const diagnoseError = async () => {
  const error = lastError.value
  if (!error || isLoading.value || !currentTabId.value) return

  const tabId = currentTabId.value
  
  // 切换到对话模式
  agentMode.value = false
  
  // 清除错误提示
  if (terminalStore.activeTab) {
    terminalStore.clearError(terminalStore.activeTab.id)
  }

  const userMessage: AiMessage = {
    id: Date.now().toString(),
    role: 'user',
    content: `请帮我分析这个错误：\n\`\`\`\n${error.content}\n\`\`\``,
    timestamp: new Date()
  }
  terminalStore.addAiMessage(tabId, userMessage)
  terminalStore.setAiLoading(tabId, true)
  await scrollToBottom()

  const assistantMessage: AiMessage = {
    id: (Date.now() + 1).toString(),
    role: 'assistant',
    content: '诊断中...',
    timestamp: new Date()
  }
  const messageIndex = terminalStore.addAiMessage(tabId, assistantMessage)
  await scrollToBottom()

  const info = currentSystemInfo.value
  const osContext = info ? `当前用户使用的是 ${info.os === 'windows' ? 'Windows' : info.os === 'macos' ? 'macOS' : 'Linux'} 系统，Shell 类型是 ${info.shell}。` : ''

  let firstChunk = true
  window.electronAPI.ai.chatStream(
    [
      {
        role: 'system',
        content: `你是一个专业的运维工程师助手。${osContext}用户会给你一个错误信息，请用中文分析错误原因，并提供可能的解决方案。`
      },
      { role: 'user', content: `请分析这个错误并提供解决方案：\n\`\`\`\n${error.content}\n\`\`\`` }
    ],
    chunk => {
      const currentContent = terminalStore.getAiMessages(tabId)[messageIndex]?.content || ''
      if (firstChunk) {
        terminalStore.updateAiMessage(tabId, messageIndex, chunk)
        firstChunk = false
      } else {
        terminalStore.updateAiMessage(tabId, messageIndex, currentContent + chunk)
      }
      scrollToBottom()
    },
    () => {
      terminalStore.setAiLoading(tabId, false)
      scrollToBottom()
    },
    err => {
      terminalStore.updateAiMessage(tabId, messageIndex, `错误: ${err}`)
      terminalStore.setAiLoading(tabId, false)
    },
    undefined,
    tabId
  )
}

// 分析选中的终端内容
const analyzeSelection = async () => {
  const selection = terminalSelectedText.value
  if (!selection || isLoading.value || !currentTabId.value) return

  // 切换到对话模式
  agentMode.value = false

  const tabId = currentTabId.value
  const userMessage: AiMessage = {
    id: Date.now().toString(),
    role: 'user',
    content: `请帮我分析这段终端输出：\n\`\`\`\n${selection}\n\`\`\``,
    timestamp: new Date()
  }
  terminalStore.addAiMessage(tabId, userMessage)
  terminalStore.setAiLoading(tabId, true)
  await scrollToBottom()

  const assistantMessage: AiMessage = {
    id: (Date.now() + 1).toString(),
    role: 'assistant',
    content: '分析中...',
    timestamp: new Date()
  }
  const messageIndex = terminalStore.addAiMessage(tabId, assistantMessage)
  await scrollToBottom()

  const info = currentSystemInfo.value
  const osContext = info ? `当前用户使用的是 ${info.os === 'windows' ? 'Windows' : info.os === 'macos' ? 'macOS' : 'Linux'} 系统，Shell 类型是 ${info.shell}。` : ''

  let firstChunk = true
  window.electronAPI.ai.chatStream(
    [
      {
        role: 'system',
        content: `你是一个专业的运维工程师助手。${osContext}用户会给你一段终端输出，请用中文分析这段内容，解释其含义，如果有错误请提供解决方案。`
      },
      { role: 'user', content: `请分析这段终端输出：\n\`\`\`\n${selection}\n\`\`\`` }
    ],
    chunk => {
      const currentContent = terminalStore.getAiMessages(tabId)[messageIndex]?.content || ''
      if (firstChunk) {
        terminalStore.updateAiMessage(tabId, messageIndex, chunk)
        firstChunk = false
      } else {
        terminalStore.updateAiMessage(tabId, messageIndex, currentContent + chunk)
      }
      scrollToBottom()
    },
    () => {
      terminalStore.setAiLoading(tabId, false)
      scrollToBottom()
    },
    err => {
      terminalStore.updateAiMessage(tabId, messageIndex, `错误: ${err}`)
      terminalStore.setAiLoading(tabId, false)
    },
    undefined,
    tabId
  )
}

// 分析从右键菜单发来的终端内容
const analyzeTerminalContent = async (text: string) => {
  if (!text || isLoading.value || !currentTabId.value) return

  const tabId = currentTabId.value
  const userMessage: AiMessage = {
    id: Date.now().toString(),
    role: 'user',
    content: `请帮我分析这段终端内容：\n\`\`\`\n${text}\n\`\`\``,
    timestamp: new Date()
  }
  terminalStore.addAiMessage(tabId, userMessage)
  terminalStore.setAiLoading(tabId, true)
  await scrollToBottom()

  const assistantMessage: AiMessage = {
    id: (Date.now() + 1).toString(),
    role: 'assistant',
    content: '分析中...',
    timestamp: new Date()
  }
  const messageIndex = terminalStore.addAiMessage(tabId, assistantMessage)
  await scrollToBottom()

  const info = currentSystemInfo.value
  const osContext = info ? `当前用户使用的是 ${info.os === 'windows' ? 'Windows' : info.os === 'macos' ? 'macOS' : 'Linux'} 系统，Shell 类型是 ${info.shell}。` : ''

  let firstChunk = true
  window.electronAPI.ai.chatStream(
    [
      {
        role: 'system',
        content: `你是一个专业的运维工程师助手。${osContext}用户会给你一段终端内容，请用中文分析这段内容，解释其含义，如果有错误请提供解决方案。`
      },
      { role: 'user', content: `请分析这段终端内容：\n\`\`\`\n${text}\n\`\`\`` }
    ],
    chunk => {
      const currentContent = terminalStore.getAiMessages(tabId)[messageIndex]?.content || ''
      if (firstChunk) {
        terminalStore.updateAiMessage(tabId, messageIndex, chunk)
        firstChunk = false
      } else {
        terminalStore.updateAiMessage(tabId, messageIndex, currentContent + chunk)
      }
      scrollToBottom()
    },
    () => {
      terminalStore.setAiLoading(tabId, false)
      scrollToBottom()
    },
    err => {
      terminalStore.updateAiMessage(tabId, messageIndex, `错误: ${err}`)
      terminalStore.setAiLoading(tabId, false)
    },
    undefined,
    tabId
  )
}

// 监听右键菜单发送到 AI 的文本
watch(() => terminalStore.pendingAiText, (text) => {
  if (text) {
    analyzeTerminalContent(text)
    terminalStore.clearPendingAiText()
  }
}, { immediate: true })

// 复制消息
const copyMessage = async (content: string) => {
  try {
    await navigator.clipboard.writeText(content)
    // 可以添加一个提示
  } catch (error) {
    console.error('复制失败:', error)
  }
}

// 配置 marked 渲染器
const renderer = new marked.Renderer()

// 自定义代码块渲染（添加复制按钮）
// 使用 data 属性标记，通过事件委托处理点击，解决流式输出时按钮不可用的问题
// 兼容 marked 不同版本的 API
renderer.code = (codeOrToken: string | { text: string; lang?: string }, language?: string) => {
  // 兼容新旧版本 marked API
  let code: string
  let lang: string
  
  if (typeof codeOrToken === 'object' && codeOrToken !== null) {
    // 新版本 marked，参数是 token 对象
    code = codeOrToken.text || ''
    lang = codeOrToken.lang || 'text'
  } else {
    // 旧版本 marked，参数是分散的
    code = codeOrToken as string
    lang = language || 'text'
  }
  
  // 转义 HTML 特殊字符用于显示
  const escapedCode = code
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
  
  // 始终渲染按钮，通过事件委托在点击时获取代码内容
  const copyBtn = `<button class="code-copy-btn" data-action="copy" title="复制代码"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>`
  
  const sendBtn = `<button class="code-send-btn" data-action="send" title="发送到终端"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 10 4 15 9 20"/><path d="M20 4v7a4 4 0 0 1-4 4H4"/></svg></button>`
  
  return `<div class="code-block"><div class="code-header"><span>${lang}</span><div class="code-actions">${sendBtn}${copyBtn}</div></div><pre><code>${escapedCode}</code></pre></div>`
}

// 自定义行内代码渲染
renderer.codespan = (code: string) => {
  return `<code class="inline-code">${code}</code>`
}

// 配置 marked
marked.setOptions({
  renderer,
  breaks: true,  // 支持换行
  gfm: true      // 支持 GitHub 风格 Markdown
})

// 渲染 Markdown 格式
const renderMarkdown = (text: string): string => {
  if (!text) return ''
  
  try {
    return marked.parse(text) as string
  } catch (e) {
    // 如果解析失败，返回转义后的纯文本
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\n/g, '<br>')
  }
}

// 从代码块中提取代码内容（反转义 HTML）
const getCodeFromBlock = (button: HTMLElement): string => {
  const codeBlock = button.closest('.code-block')
  const codeElement = codeBlock?.querySelector('pre code')
  if (!codeElement) return ''
  
  // 获取文本内容（自动反转义 HTML 实体）
  return codeElement.textContent || ''
}

// 事件委托处理代码块按钮点击
const handleCodeBlockClick = async (event: MouseEvent) => {
  const target = event.target as HTMLElement
  
  // 调试：显示点击的元素
  console.log('点击元素:', target.tagName, target.className)
  
  // 查找带有 data-action 属性的按钮（可能点击的是 SVG 或其子元素）
  const button = target.closest('.code-copy-btn, .code-send-btn') as HTMLElement
  if (!button) {
    console.log('未找到按钮元素')
    return
  }
  
  console.log('找到按钮:', button.className, 'data-action:', button.dataset.action)
  
  const action = button.dataset.action
  const code = getCodeFromBlock(button)
  
  console.log('Code block action:', action, 'Code length:', code.length)
  
  if (!code) {
    console.warn('未能获取代码内容')
    return
  }
  
  if (action === 'copy') {
    try {
      await navigator.clipboard.writeText(code)
      console.log('代码已复制')
    } catch (error) {
      console.error('复制代码失败:', error)
    }
  } else if (action === 'send') {
    try {
      const activeTab = terminalStore.activeTab
      console.log('Active tab:', activeTab?.id, 'ptyId:', activeTab?.ptyId)
      if (activeTab?.ptyId) {
        // 发送代码到终端（不自动添加回车，让用户确认后再执行）
        await terminalStore.writeToTerminal(activeTab.id, code)
        // 自动让终端获得焦点，方便用户按回车执行
        terminalStore.focusTerminal(activeTab.id)
        console.log('代码已发送到终端')
      } else {
        console.warn('没有活动的终端')
      }
    } catch (error) {
      console.error('发送到终端失败:', error)
    }
  }
}

// 事件监听通过模板 @click 绑定到 messagesRef

// 快捷操作
const quickActions = [
  { label: '解释命令', icon: '💡', action: () => explainCommand(terminalSelectedText.value || 'ls -la') },
  { label: '查找文件', icon: '🔍', action: () => generateCommand('查找当前目录下所有的日志文件') },
  { label: '查看进程', icon: '📊', action: () => generateCommand('查看占用内存最多的前10个进程') },
  { label: '磁盘空间', icon: '💾', action: () => generateCommand('查看磁盘空间使用情况') }
]

// ==================== Agent 模式功能 ====================

// 保存 Agent 记录到历史
const saveAgentRecord = (
  _tabId: string,
  userTask: string,
  startTime: number,
  status: 'completed' | 'failed' | 'aborted',
  finalResult?: string
) => {
  const terminalInfo = getTerminalInfo()
  if (!terminalInfo) return
  
  const steps = agentState.value?.steps || []
  // 过滤掉 user_task 和 final_result 类型，只保留执行步骤
  const executionSteps = steps
    .filter(s => s.type !== 'user_task' && s.type !== 'final_result')
    .map(s => ({
      id: s.id,
      type: s.type,
      content: s.content,
      toolName: s.toolName,
      toolArgs: s.toolArgs ? JSON.parse(JSON.stringify(s.toolArgs)) : undefined,
      toolResult: s.toolResult,
      riskLevel: s.riskLevel,
      timestamp: s.timestamp
    }))
  
  // 使用 JSON.parse(JSON.stringify()) 确保移除所有 Vue Proxy，避免 IPC 序列化错误
  const record = JSON.parse(JSON.stringify({
    id: `agent_${startTime}`,
    timestamp: startTime,
    ...terminalInfo,
    userTask,
    steps: executionSteps,
    finalResult,
    duration: Date.now() - startTime,
    status
  }))
  
  window.electronAPI.history.saveAgentRecord(record).catch(err => {
    console.error('保存 Agent 历史记录失败:', err)
  })
}

// ==================== 主机档案 ====================

// 主机档案类型
interface HostProfile {
  hostId: string
  hostname: string
  username: string
  os: string
  osVersion: string
  shell: string
  packageManager?: string
  installedTools: string[]
  notes: string[]
  lastProbed: number
  lastUpdated: number
}

// 当前主机档案
const currentHostProfile = ref<HostProfile | null>(null)
const isLoadingProfile = ref(false)
const isProbing = ref(false)

// 获取当前终端的主机 ID
const getHostId = async (): Promise<string> => {
  const activeTab = terminalStore.activeTab
  if (!activeTab) return 'local'
  
  if (activeTab.type === 'ssh' && activeTab.sshConfig) {
    return await window.electronAPI.hostProfile.generateHostId(
      'ssh',
      activeTab.sshConfig.host,
      activeTab.sshConfig.username
    )
  }
  return 'local'
}

// 加载当前主机档案
const loadHostProfile = async () => {
  isLoadingProfile.value = true
  try {
    const hostId = await getHostId()
    currentHostProfile.value = await window.electronAPI.hostProfile.get(hostId)
  } catch (e) {
    console.error('[HostProfile] 加载失败:', e)
  } finally {
    isLoadingProfile.value = false
  }
}

// 手动刷新主机档案
const refreshHostProfile = async () => {
  if (isProbing.value) return
  
  isProbing.value = true
  try {
    const hostId = await getHostId()
    
    if (hostId === 'local') {
      // 本地主机：使用后台静默探测
      currentHostProfile.value = await window.electronAPI.hostProfile.probeLocal()
    } else {
      // SSH 主机：暂时只从缓存加载（TODO: 实现 SSH 后台探测）
      currentHostProfile.value = await window.electronAPI.hostProfile.get(hostId)
    }
    
    console.log('[HostProfile] 刷新完成:', currentHostProfile.value)
  } catch (e) {
    console.error('[HostProfile] 刷新失败:', e)
  } finally {
    isProbing.value = false
  }
}

// 总结 Agent 任务中的关键发现
const summarizeAgentFindings = async (hostId: string) => {
  const history = agentState.value?.history || []
  const currentSteps = agentState.value?.steps || []
  
  // 收集最近的 Agent 交互内容
  const recentInteractions: string[] = []
  
  // 添加历史任务
  for (const item of history.slice(-3)) {  // 最近 3 个历史任务
    recentInteractions.push(`任务: ${item.userTask}\n结果: ${item.finalResult}`)
  }
  
  // 添加当前任务步骤
  const currentTaskSteps = currentSteps.filter(s => 
    s.type === 'tool_result' || s.type === 'message'
  ).slice(-10)  // 最近 10 个步骤
  
  for (const step of currentTaskSteps) {
    if (step.toolResult) {
      recentInteractions.push(`命令输出: ${step.toolResult.substring(0, 500)}`)
    } else if (step.content && step.type === 'message') {
      recentInteractions.push(`AI 分析: ${step.content.substring(0, 300)}`)
    }
  }
  
  if (recentInteractions.length === 0) return
  
  // 获取当前已有的记忆
  const existingProfile = await window.electronAPI.hostProfile.get(hostId)
  const existingNotes = existingProfile?.notes || []
  
  // 让 AI 更新记忆（新增、更新、删除）
  try {
    const prompt = `你是主机信息管理助手。请精简更新主机的记忆信息。

## 当前已有记忆
${existingNotes.length > 0 ? existingNotes.map((n: string) => `- ${n}`).join('\n') : '（空）'}

## 最新交互记录
${recentInteractions.join('\n\n')}

## 任务
输出更新后的记忆列表。**最多保留 5 条**最重要的信息。

### 只记录这些（必须是用户可能再次需要的关键路径）：
- 用户项目或应用的配置文件路径
- 用户项目或应用的日志目录
- 用户自定义的脚本或数据目录

### 不要记录：
- 系统默认路径（如 /etc/nginx/、/var/log/ 等常见路径）
- 动态信息（端口、进程、状态、使用率）
- 临时目录或缓存

### 输出格式
最多 10 条，每条一行：
- 项目配置在 /home/user/myapp/config/
- 应用日志在 /data/logs/myapp/

如果没有值得记住的信息，只输出：无`

    const response = await window.electronAPI.ai.chat([
      { role: 'user', content: prompt }
    ])
    
    if (response && response.trim()) {
      if (response.trim() === '无' || response.includes('没有') && response.includes('信息')) {
        // 清空所有记忆
        if (existingNotes.length > 0) {
          await window.electronAPI.hostProfile.update(hostId, { notes: [] })
          console.log('[HostProfile] 清空了所有记忆')
        }
      } else {
        // 解析新的记忆列表
        // 过滤动态信息和系统默认路径
        const dynamicPatterns = [
          /端口/i, /port/i, /监听/i, /listen/i,
          /进程/i, /process/i, /pid/i,
          /运行中/i, /running/i, /stopped/i, /状态/i,
          /使用率/i, /占用/i, /usage/i,
          /\d+%/, /\d+mb/i, /\d+gb/i,
          /连接/i, /connection/i,
          /登录/i, /login/i
        ]
        // 系统默认路径不需要记录
        const commonPaths = [
          /^\/etc\/nginx\/?$/i,
          /^\/var\/log\/?$/i,
          /^\/usr\/local\/?$/i,
          /^\/home\/?$/i,
          /^\/root\/?$/i
        ]
        
        const newNotes = response.split('\n')
          .map(l => l.replace(/^[-•✅❌]\s*/, '').trim())
          .filter(l => {
            if (!l || l.length < 10 || l.length > 80) return false
            if (l.includes('输出') || l.includes('格式') || l.includes('最多')) return false
            if (dynamicPatterns.some(p => p.test(l))) return false
            if (!l.includes('/') && !l.includes('\\')) return false
            // 提取路径部分检查是否是常见默认路径
            const pathMatch = l.match(/[\/\\][\w\/\\\-\.]+/)
            if (pathMatch && commonPaths.some(p => p.test(pathMatch[0]))) return false
            return true
          })
          .slice(0, 5)  // 最多保留 5 条
        
        // 替换整个记忆列表
        await window.electronAPI.hostProfile.update(hostId, { notes: newNotes })
        console.log('[HostProfile] 更新记忆:', newNotes)
      }
    }
  } catch (e) {
    console.warn('[HostProfile] AI 总结失败:', e)
  }
}

// 自动探测主机信息（首次加载时）
const autoProbeHostProfile = async (): Promise<void> => {
  try {
    const hostId = await getHostId()
    
    // 检查是否需要探测
    const needsProbe = await window.electronAPI.hostProfile.needsProbe(hostId)
    if (!needsProbe) return
    
    if (hostId === 'local') {
      // 本地主机：后台静默探测
      const profile = await window.electronAPI.hostProfile.probeLocal()
      currentHostProfile.value = profile
      console.log('[HostProfile] 自动探测完成:', profile)
    } else {
      // SSH 主机：通过 SSH 连接探测
      const activeTab = terminalStore.activeTab
      if (activeTab?.type === 'ssh' && activeTab.ptyId) {
        const profile = await window.electronAPI.hostProfile.probeSsh(activeTab.ptyId, hostId)
        if (profile) {
          currentHostProfile.value = profile
          console.log('[HostProfile] SSH 自动探测完成:', profile)
        }
      }
    }
  } catch (e) {
    console.error('[HostProfile] 自动探测失败:', e)
  }
}

// 运行 Agent
const runAgent = async () => {
  if (!inputText.value.trim() || isAgentRunning.value || !currentTabId.value) return

  const tabId = currentTabId.value
  const message = inputText.value
  const startTime = Date.now()  // 记录开始时间
  inputText.value = ''

  // 获取 Agent 上下文
  const context = terminalStore.getAgentContext(tabId)
  if (!context || !context.ptyId) {
    console.error('无法获取终端上下文')
    return
  }

  // 获取主机 ID
  const hostId = await getHostId()

  // 首次运行时自动探测主机信息（后台执行，不阻塞）
  autoProbeHostProfile().catch(e => {
    console.warn('[Agent] 主机探测失败:', e)
  })

  // 准备新任务（保留之前的步骤）
  terminalStore.clearAgentState(tabId, true)
  
  // 从 Agent 历史中构建上下文消息
  const currentHistory = agentState.value?.history || []
  const historyMessages: { role: 'user' | 'assistant'; content: string }[] = []
  for (const item of currentHistory) {
    historyMessages.push({ role: 'user', content: item.userTask })
    historyMessages.push({ role: 'assistant', content: item.finalResult })
  }

  // 添加用户任务到步骤中（作为对话流的一部分）
  terminalStore.addAgentStep(tabId, {
    id: `user_task_${Date.now()}`,
    type: 'user_task',
    content: message,
    timestamp: Date.now()
  })
  await scrollToBottom()

  // 设置 Agent 状态：正在运行 + 用户任务
  terminalStore.setAgentRunning(tabId, true, undefined, message)

  try {
    // 调用 Agent API，传递配置
    const result = await window.electronAPI.agent.run(
      context.ptyId,
      message,
      {
        ...context,
        hostId,  // 主机档案 ID
        historyMessages  // 添加历史对话
      } as { ptyId: string; terminalOutput: string[]; systemInfo: { os: string; shell: string }; hostId?: string; historyMessages?: { role: string; content: string }[] },
      { strictMode: strictMode.value, commandTimeout: commandTimeout.value * 1000 }  // 传递配置（超时时间转为毫秒）
    )

    // 标记 Agent 已完成
    terminalStore.setAgentRunning(tabId, false)

    // 添加最终结果到步骤中
    let finalContent = ''
    if (!result.success) {
      finalContent = `❌ Agent 执行失败: ${result.error}`
    } else if (result.result) {
      finalContent = result.result
    }
    
    if (finalContent) {
      terminalStore.addAgentStep(tabId, {
        id: `final_result_${Date.now()}`,
        type: 'final_result',
        content: finalContent,
        timestamp: Date.now()
      })
      terminalStore.setAgentFinalResult(tabId, finalContent)
    }
    
    // 保存 Agent 记录
    saveAgentRecord(tabId, message, startTime, result.success ? 'completed' : 'failed', finalContent)
    
    // Agent 完成后自动总结关键信息并更新记忆（后台执行）
    summarizeAgentFindings(hostId).catch(e => {
      console.warn('[Agent] 总结记忆失败:', e)
    })
  } catch (error) {
    console.error('Agent 运行失败:', error)
    terminalStore.setAgentRunning(tabId, false)
    const errorContent = `❌ Agent 运行出错: ${error instanceof Error ? error.message : '未知错误'}`
    terminalStore.addAgentStep(tabId, {
      id: `final_result_${Date.now()}`,
      type: 'final_result',
      content: errorContent,
      timestamp: Date.now()
    })
    terminalStore.setAgentFinalResult(tabId, errorContent)
    
    // 保存失败的 Agent 记录
    saveAgentRecord(tabId, message, startTime, 'failed', errorContent)
  }

  await scrollToBottom()
}

// 中止 Agent
const abortAgent = async () => {
  const agentId = agentState.value?.agentId
  if (!agentId) return

  try {
    await window.electronAPI.agent.abort(agentId)
  } catch (error) {
    console.error('中止 Agent 失败:', error)
  }
}

// 确认工具调用
const confirmToolCall = async (approved: boolean) => {
  const confirm = pendingConfirm.value
  if (!confirm) return

  try {
    await window.electronAPI.agent.confirm(
      confirm.agentId,
      confirm.toolCallId,
      approved
    )
    // 清除待确认状态
    if (currentTabId.value) {
      terminalStore.setAgentPendingConfirm(currentTabId.value, undefined)
    }
  } catch (error) {
    console.error('确认工具调用失败:', error)
  }
}

// 获取步骤类型的图标
const getStepIcon = (type: AgentStep['type']): string => {
  switch (type) {
    case 'thinking': return '🤔'
    case 'tool_call': return '🔧'
    case 'tool_result': return '📋'
    case 'message': return '💬'
    case 'error': return '❌'
    case 'confirm': return '⚠️'
    case 'user_task': return '👤'
    case 'final_result': return '✅'
    default: return '•'
  }
}

// 获取风险等级的颜色类
const getRiskClass = (riskLevel?: string): string => {
  switch (riskLevel) {
    case 'safe': return 'risk-safe'
    case 'moderate': return 'risk-moderate'
    case 'dangerous': return 'risk-dangerous'
    case 'blocked': return 'risk-blocked'
    default: return ''
  }
}

// 设置 Agent 事件监听
const setupAgentListeners = () => {
  // 监听步骤更新
  cleanupStepListener = window.electronAPI.agent.onStep((data) => {
    if (currentTabId.value) {
      terminalStore.addAgentStep(currentTabId.value, data.step)
      terminalStore.setAgentRunning(currentTabId.value, true, data.agentId)
      scrollToBottom()
    }
  })

  // 监听需要确认
  cleanupConfirmListener = window.electronAPI.agent.onNeedConfirm((data) => {
    if (currentTabId.value) {
      terminalStore.setAgentPendingConfirm(currentTabId.value, data)
      scrollToBottom()
    }
  })

  // 监听完成
  cleanupCompleteListener = window.electronAPI.agent.onComplete((_data) => {
    if (currentTabId.value) {
      terminalStore.setAgentRunning(currentTabId.value, false)
    }
  })

  // 监听错误
  cleanupErrorListener = window.electronAPI.agent.onError((data) => {
    if (currentTabId.value) {
      terminalStore.setAgentRunning(currentTabId.value, false)
      terminalStore.addAgentStep(currentTabId.value, {
        id: `error_${Date.now()}`,
        type: 'error',
        content: data.error,
        timestamp: Date.now()
      })
    }
  })
}

// 清理 Agent 事件监听
const cleanupAgentListeners = () => {
  if (cleanupStepListener) {
    cleanupStepListener()
    cleanupStepListener = null
  }
  if (cleanupConfirmListener) {
    cleanupConfirmListener()
    cleanupConfirmListener = null
  }
  if (cleanupCompleteListener) {
    cleanupCompleteListener()
    cleanupCompleteListener = null
  }
  if (cleanupErrorListener) {
    cleanupErrorListener()
    cleanupErrorListener = null
  }
}

// 发送消息（根据模式选择普通对话或 Agent）
const handleSend = () => {
  if (agentMode.value) {
    runAgent()
  } else {
    sendMessage()
  }
}

// 生命周期
onMounted(() => {
  setupAgentListeners()
  // 加载主机档案
  loadHostProfile()
})

onUnmounted(() => {
  cleanupAgentListeners()
})

// 监听终端切换，重新加载主机档案
watch(() => terminalStore.activeTabId, () => {
  loadHostProfile()
})
</script>

<template>
  <div class="ai-panel">
    <div class="ai-header">
      <h3>AI 助手</h3>
      <div class="ai-header-actions">
        <!-- 模型选择 -->
        <select 
          v-if="aiProfiles.length > 0"
          class="model-select"
          :value="activeAiProfile?.id || ''"
          @change="changeAiProfile(($event.target as HTMLSelectElement).value)"
        >
          <option v-for="profile in aiProfiles" :key="profile.id" :value="profile.id">
            {{ profile.name }} ({{ profile.model }})
          </option>
        </select>
        <button class="btn-icon" @click="clearMessages" data-tooltip="清空对话">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="3 6 5 6 21 6"/>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
          </svg>
        </button>
        <button class="btn-icon" @click="emit('close')">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"/>
            <line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>
    </div>

    <!-- 未配置 AI 提示 -->
    <div v-if="!hasAiConfig" class="ai-no-config">
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <circle cx="12" cy="12" r="10"/>
        <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/>
        <line x1="12" y1="17" x2="12.01" y2="17"/>
      </svg>
      <p>尚未配置 AI 模型</p>
      <button class="btn btn-primary btn-sm" @click="showSettings?.()">
        前往设置
      </button>
    </div>

    <template v-else>
      <!-- 模式切换 -->
      <div class="mode-switcher">
        <button 
          class="mode-btn" 
          :class="{ active: agentMode }"
          @click="agentMode = true"
        >
          🤖 Agent
        </button>
        <button 
          class="mode-btn" 
          :class="{ active: !agentMode }"
          @click="agentMode = false"
        >
          💬 对话
        </button>
      </div>

      <!-- 系统环境信息 + Agent 设置 -->
      <div class="system-info-bar">
        <div v-if="currentSystemInfo" class="system-info-left">
        <span class="system-icon">💻</span>
        <span class="system-text">
          {{ currentSystemInfo.os === 'windows' ? 'Windows' : currentSystemInfo.os === 'macos' ? 'macOS' : 'Linux' }}
          · {{ currentSystemInfo.shell === 'powershell' ? 'PowerShell' : currentSystemInfo.shell === 'cmd' ? 'CMD' : currentSystemInfo.shell === 'bash' ? 'Bash' : currentSystemInfo.shell === 'zsh' ? 'Zsh' : currentSystemInfo.shell }}
        </span>
        </div>
        <!-- Agent 模式设置 -->
        <div v-if="agentMode" class="agent-settings">
          <!-- 超时设置 -->
          <div class="timeout-setting" title="命令执行超时时间">
            <span class="timeout-label">超时</span>
            <select v-model.number="commandTimeout" class="timeout-select">
              <option :value="5">5s</option>
              <option :value="10">10s</option>
              <option :value="30">30s</option>
              <option :value="60">60s</option>
              <option :value="120">2m</option>
              <option :value="300">5m</option>
            </select>
          </div>
          <!-- 严格模式开关 -->
          <div class="strict-mode-toggle" @click.stop="strictMode = !strictMode" :title="strictMode ? '严格模式：每个命令都需确认' : '宽松模式：仅危险命令需确认'">
            <span class="toggle-label">{{ strictMode ? '严格' : '宽松' }}</span>
            <span class="toggle-switch" :class="{ active: strictMode }">
              <span class="toggle-dot"></span>
            </span>
          </div>
        </div>
      </div>

      <!-- 错误诊断提示（Agent 执行时隐藏） -->
      <div v-if="lastError && !isAgentRunning" class="error-alert">
        <div class="error-alert-icon">⚠️</div>
        <div class="error-alert-content">
          <div class="error-alert-title">检测到错误</div>
          <div class="error-alert-text">{{ lastError.content.slice(0, 80) }}{{ lastError.content.length > 80 ? '...' : '' }}</div>
        </div>
        <button class="error-alert-btn" @click="diagnoseError" :disabled="isLoading">
          AI 诊断
        </button>
        <button class="error-alert-close" @click="terminalStore.clearError(terminalStore.activeTab?.id || '')">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"/>
            <line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>

      <!-- 终端选中内容提示（Agent 执行时隐藏） -->
      <div v-if="terminalSelectedText && !lastError && !isAgentRunning" class="selection-alert">
        <div class="selection-alert-icon">📋</div>
        <div class="selection-alert-content">
          <div class="selection-alert-title">已选中终端内容</div>
          <div class="selection-alert-text">{{ terminalSelectedText.slice(0, 60) }}{{ terminalSelectedText.length > 60 ? '...' : '' }}</div>
        </div>
        <button class="selection-alert-btn" @click="analyzeSelection" :disabled="isLoading">
          AI 分析
        </button>
      </div>

      <!-- 快捷操作（仅对话模式且无对话内容时显示） -->
      <div v-if="!agentMode && messages.length === 0" class="quick-actions">
        <button
          v-for="action in quickActions"
          :key="action.label"
          class="quick-action-btn"
          @click="action.action"
        >
          <span class="action-icon">{{ action.icon }}</span>
          <span>{{ action.label }}</span>
        </button>
      </div>

      <!-- 消息列表 -->
      <div ref="messagesRef" class="ai-messages" @click="handleCodeBlockClick">
        <div v-if="messages.length === 0 && !agentMode" class="ai-welcome">
          <p>👋 你好！我是旗鱼终端的 AI 助手。</p>
          <p class="welcome-section-title">💬 直接对话</p>
          <p class="welcome-desc">在下方输入框输入任何问题，我会尽力帮你解答。</p>
          
          <p class="welcome-section-title">🚀 快捷功能</p>
          <ul>
            <li><strong>解释命令</strong> - 选中终端内容后点击按钮解释，或直接点击查看示例</li>
            <li><strong>错误诊断</strong> - 终端出错时自动提示，点击「AI 诊断」</li>
            <li><strong>生成命令</strong> - 用自然语言描述需求，如「查找大于100M的文件」</li>
            <li><strong>分析输出</strong> - 选中终端内容后，自动显示「AI 分析」按钮</li>
          </ul>

          <p class="welcome-section-title">✨ 使用技巧</p>
          <ul>
            <li>终端右键菜单可「发送到 AI 分析」</li>
            <li>AI 回复中的代码块可一键发送到终端</li>
            <li>每个终端标签页有独立的对话记录</li>
            <li>我会根据你的系统环境生成合适的命令</li>
          </ul>
        </div>
        <div v-if="agentMode && !agentUserTask" class="ai-welcome">
          <p>🤖 Agent 模式已启用</p>
          
          <!-- 主机档案信息 -->
          <div class="host-profile-section">
            <p class="welcome-section-title">
              🖥️ 主机信息
              <button 
                class="refresh-profile-btn" 
                @click="refreshHostProfile" 
                :disabled="isProbing"
                :title="isProbing ? '探测中...' : '刷新主机信息'"
              >
                <span :class="{ spinning: isProbing }">🔄</span>
              </button>
            </p>
            <div v-if="currentHostProfile" class="host-profile-info">
              <div class="profile-row">
                <span class="profile-label">主机:</span>
                <span class="profile-value">{{ currentHostProfile.hostname || '未知' }}</span>
                <span v-if="currentHostProfile.username" class="profile-value-secondary">@ {{ currentHostProfile.username }}</span>
              </div>
              <div v-if="currentHostProfile.osVersion || currentHostProfile.os" class="profile-row">
                <span class="profile-label">系统:</span>
                <span class="profile-value">{{ currentHostProfile.osVersion || currentHostProfile.os }}</span>
              </div>
              <div v-if="currentHostProfile.shell" class="profile-row">
                <span class="profile-label">Shell:</span>
                <span class="profile-value">{{ currentHostProfile.shell }}</span>
                <span v-if="currentHostProfile.packageManager" class="profile-value-secondary">| {{ currentHostProfile.packageManager }}</span>
              </div>
              <div v-if="currentHostProfile.installedTools?.length" class="profile-row">
                <span class="profile-label">工具:</span>
                <span class="profile-value tools-list">{{ currentHostProfile.installedTools.join(', ') }}</span>
              </div>
              <div v-if="currentHostProfile.notes?.length" class="profile-notes">
                <span class="profile-label">📝 已知信息:</span>
                <ul>
                  <li v-for="(note, idx) in currentHostProfile.notes.slice(-5)" :key="idx">{{ note }}</li>
                </ul>
              </div>
            </div>
            <div v-else-if="isLoadingProfile" class="host-profile-loading">
              加载中...
            </div>
            <div v-else class="host-profile-empty">
              <span>尚未探测，点击刷新按钮探测主机信息</span>
            </div>
          </div>

          <p class="welcome-section-title">💡 什么是 Agent 模式？</p>
          <p class="welcome-desc">Agent 可以自主执行命令来完成你的任务，你可以看到完整的执行过程。</p>
          
          <p class="welcome-section-title">🎯 使用示例</p>
          <ul>
            <li>「查看服务器磁盘空间，如果超过80%就清理日志」</li>
            <li>「检查 nginx 服务状态，如果没运行就启动它」</li>
            <li>「找出占用内存最多的进程并显示详情」</li>
            <li>「在当前目录创建一个 backup 文件夹并备份所有配置文件」</li>
          </ul>

          <p class="welcome-section-title">{{ strictMode ? '🔒 严格模式' : '🔓 宽松模式' }} <span class="strict-badge" :class="{ relaxed: !strictMode }">{{ strictMode ? '已开启' : '已开启' }}</span></p>
          <ul>
            <li v-if="strictMode"><strong>每个命令都需要你确认</strong>后才会执行</li>
            <li v-if="strictMode">适合敏感环境，完全掌控每一步操作</li>
            <li v-if="!strictMode"><strong>安全命令自动执行</strong>，只有危险命令需要确认</li>
            <li v-if="!strictMode">适合日常使用，提高效率的同时保障安全</li>
            <li>所有命令都在终端执行，你可以看到完整输入输出</li>
          </ul>

          <p class="welcome-section-title">⚠️ 注意事项</p>
          <ul>
            <li>危险命令（如删除、修改系统文件）始终需要确认</li>
            <li>你可以随时点击「停止」中止 Agent 执行</li>
            <li><strong>不适合</strong>长时间运行的命令（如大型编译、数据迁移）</li>
            <li><strong>不适合</strong>循环/交互式命令（如 <code>watch</code>、<code>top</code>、<code>tail -f</code>、<code>vim</code>）</li>
          </ul>
        </div>
        <!-- 普通对话模式的消息 -->
        <template v-if="!agentMode">
        <div
          v-for="msg in messages"
          :key="msg.id"
          class="message"
          :class="msg.role"
        >
          <div class="message-wrapper">
            <div class="message-content">
              <div v-if="msg.role === 'assistant'" v-html="renderMarkdown(msg.content)" class="markdown-content"></div>
              <span v-else>{{ msg.content }}</span>
            </div>
            <button
              v-if="msg.role === 'assistant' && msg.content && !msg.content.includes('中...')"
              class="copy-btn"
              @click="copyMessage(msg.content)"
              title="复制"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
              </svg>
            </button>
            </div>
          </div>
        </template>

        <!-- Agent 任务列表（每个任务：用户任务 + 步骤块 + 最终结果） -->
        <template v-if="agentMode && agentTaskGroups.length > 0">
          <template v-for="group in agentTaskGroups" :key="group.id">
            <!-- 用户任务 -->
            <div class="message user">
              <div class="message-wrapper">
                <div class="message-content">
                  <span>{{ group.userTask }}</span>
                </div>
              </div>
            </div>
            
            <!-- 执行步骤（折叠块） -->
            <div v-if="group.steps.length > 0" class="message assistant">
              <div class="message-wrapper agent-steps-wrapper">
                <div class="message-content agent-steps-content">
                  <div class="agent-steps-header-inline" @click="toggleStepsCollapse(group.id)">
                    <span>🤖 {{ group.isCurrentTask && isAgentRunning ? 'Agent 执行中' : 'Agent 执行记录' }}</span>
                    <span v-if="group.isCurrentTask && isAgentRunning" class="agent-running-dot"></span>
                    <span class="steps-count">{{ group.steps.length }} 步</span>
                    <span class="collapse-icon" :class="{ collapsed: isStepsCollapsed(group.id) }">▼</span>
                  </div>
                  <div v-show="!isStepsCollapsed(group.id)" class="agent-steps-body">
                    <div 
                      v-for="step in group.steps" 
                      :key="step.id" 
                      class="agent-step-inline"
                      :class="[step.type, getRiskClass(step.riskLevel), { 'step-rejected': step.content.includes('拒绝') }]"
                    >
                      <span class="step-icon">{{ getStepIcon(step.type) }}</span>
                      <div class="step-content">
                        <div class="step-text" :class="{ 'step-analysis': step.type === 'message' }">
                          {{ step.content }}
                        </div>
                        <div v-if="step.toolResult && step.toolResult !== '已拒绝'" class="step-result">
                          <pre>{{ step.toolResult }}</pre>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
            
            <!-- 最终结果 -->
            <div v-if="group.finalResult" class="message assistant">
              <div class="message-wrapper">
                <div class="message-content">
                  <div class="markdown-content" v-html="renderMarkdown(group.finalResult)"></div>
                </div>
              </div>
            </div>
          </template>
        </template>

        <!-- Agent 确认对话框（融入对话流） -->
        <div v-if="pendingConfirm" class="message assistant">
          <div class="message-wrapper">
            <div class="message-content agent-confirm-inline">
              <div class="confirm-header-inline">
                <span class="confirm-icon">⚠️</span>
                <span class="confirm-title">需要确认</span>
                <span class="confirm-risk-badge" :class="getRiskClass(pendingConfirm.riskLevel)">
                  {{ pendingConfirm.riskLevel === 'dangerous' ? '高风险' : '中风险' }}
                </span>
              </div>
              <div class="confirm-detail">
                <div class="confirm-tool-name">{{ pendingConfirm.toolName }}</div>
                <pre class="confirm-args-inline">{{ JSON.stringify(pendingConfirm.toolArgs, null, 2) }}</pre>
              </div>
              <div class="confirm-actions-inline">
                <button class="btn btn-sm btn-outline-danger" @click="confirmToolCall(false)">
                  拒绝
                </button>
                <button class="btn btn-sm btn-primary" @click="confirmToolCall(true)">
                  允许执行
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- 上下文使用情况 -->
      <div v-if="messages.length > 0 || (agentMode && agentUserTask)" class="context-stats">
        <div class="context-info">
          <span class="context-label">上下文</span>
          <span class="context-value">~{{ contextStats.tokenEstimate.toLocaleString() }} / {{ (contextStats.maxTokens / 1000).toFixed(0) }}K</span>
        </div>
        <div class="context-bar" :title="`${contextStats.percentage}% 已使用`">
          <div 
            class="context-bar-fill" 
            :style="{ width: contextStats.percentage + '%' }"
            :class="{ 
              'warning': contextStats.percentage > 60, 
              'danger': contextStats.percentage > 85 
            }"
          ></div>
        </div>
      </div>

      <!-- 输入区域 -->
      <div class="ai-input">
        <textarea
          v-model="inputText"
          :placeholder="agentMode ? '描述你想让 Agent 完成的任务...' : '输入问题或描述你想要的命令...'"
          rows="2"
          @keydown.enter.exact.prevent="handleSend"
        ></textarea>
        <!-- 停止按钮 (普通对话模式) -->
        <button
          v-if="isLoading && !agentMode"
          class="btn btn-danger stop-btn"
          @click="stopGeneration"
          title="停止生成"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <rect x="6" y="6" width="12" height="12" rx="2"/>
          </svg>
        </button>
        <!-- 停止按钮 (Agent 模式) -->
        <button
          v-else-if="isAgentRunning"
          class="btn btn-danger stop-btn"
          @click="abortAgent"
          title="停止 Agent"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <rect x="6" y="6" width="12" height="12" rx="2"/>
          </svg>
        </button>
        <!-- 发送按钮 -->
        <button
          v-else
          class="btn send-btn"
          :class="agentMode ? 'btn-success' : 'btn-primary'"
          :disabled="!inputText.trim()"
          @click="handleSend"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="22" y1="2" x2="11" y2="13"/>
            <polygon points="22 2 15 22 11 13 2 9 22 2"/>
          </svg>
        </button>
      </div>
    </template>
  </div>
</template>

<style scoped>
.ai-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.ai-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border-color);
}

.ai-header h3 {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}

.ai-header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.model-select {
  padding: 4px 8px;
  font-size: 11px;
  color: var(--text-secondary);
  background: var(--bg-tertiary);
  border: 1px solid var(--border-color);
  border-radius: 4px;
  cursor: pointer;
  max-width: 160px;
  outline: none;
}

.model-select:hover {
  border-color: var(--accent-primary);
}

.model-select:focus {
  border-color: var(--accent-primary);
  box-shadow: 0 0 0 2px rgba(0, 150, 255, 0.2);
}

.ai-no-config {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 16px;
  padding: 20px;
  color: var(--text-muted);
  text-align: center;
}

.system-info-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  background: var(--bg-tertiary);
  border-bottom: 1px solid var(--border-color);
  font-size: 11px;
  color: var(--text-muted);
}

.system-info-left {
  display: flex;
  align-items: center;
  gap: 6px;
}

.system-icon {
  font-size: 12px;
}

.system-text {
  font-family: var(--font-mono);
}

/* 错误诊断提示 */
.error-alert {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  background: rgba(244, 63, 94, 0.15);
  border-bottom: 1px solid rgba(244, 63, 94, 0.3);
  flex-shrink: 0;
  z-index: 10;
}

.error-alert-icon {
  font-size: 18px;
  flex-shrink: 0;
}

.error-alert-content {
  flex: 1;
  min-width: 0;
}

.error-alert-title {
  font-size: 12px;
  font-weight: 600;
  color: #f43f5e;
  margin-bottom: 2px;
}

.error-alert-text {
  font-size: 11px;
  color: var(--text-muted);
  font-family: var(--font-mono);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.error-alert-btn {
  padding: 4px 10px;
  font-size: 11px;
  font-weight: 500;
  color: #fff;
  background: #f43f5e;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.2s ease;
  flex-shrink: 0;
}

.error-alert-btn:hover:not(:disabled) {
  background: #e11d48;
}

.error-alert-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.error-alert-close {
  padding: 4px;
  color: var(--text-muted);
  background: transparent;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  opacity: 0.6;
  transition: all 0.2s ease;
  flex-shrink: 0;
}

.error-alert-close:hover {
  opacity: 1;
  background: rgba(244, 63, 94, 0.2);
}

/* 选中内容提示 */
.selection-alert {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  background: rgba(59, 130, 246, 0.15);
  border-bottom: 1px solid rgba(59, 130, 246, 0.3);
  flex-shrink: 0;
  z-index: 10;
}

.selection-alert-icon {
  font-size: 18px;
  flex-shrink: 0;
}

.selection-alert-content {
  flex: 1;
  min-width: 0;
}

.selection-alert-title {
  font-size: 12px;
  font-weight: 600;
  color: #3b82f6;
  margin-bottom: 2px;
}

.selection-alert-text {
  font-size: 11px;
  color: var(--text-muted);
  font-family: var(--font-mono);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.selection-alert-btn {
  padding: 4px 10px;
  font-size: 11px;
  font-weight: 500;
  color: #fff;
  background: #3b82f6;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.2s ease;
  flex-shrink: 0;
}

.selection-alert-btn:hover:not(:disabled) {
  background: #2563eb;
}

.selection-alert-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.quick-actions {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 8px;
  padding: 12px;
  border-bottom: 1px solid var(--border-color);
}

.quick-action-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  font-size: 12px;
  color: var(--text-secondary);
  background: var(--bg-tertiary);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.quick-action-btn:hover {
  background: var(--bg-surface);
  color: var(--text-primary);
  border-color: var(--accent-primary);
}

.action-icon {
  font-size: 14px;
}

.ai-messages {
  flex: 1;
  overflow-y: auto;
  padding: 12px;
  user-select: text;
}

/* 上下文使用情况 */
.context-stats {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 12px;
  background: var(--bg-tertiary);
  border-top: 1px solid var(--border-color);
  font-size: 11px;
}

.context-info {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--text-muted);
}

.context-label {
  color: var(--text-secondary);
  font-weight: 500;
}

.context-separator {
  opacity: 0.5;
}

.context-bar {
  width: 60px;
  height: 4px;
  background: var(--bg-surface);
  border-radius: 2px;
  overflow: hidden;
}

.context-bar-fill {
  height: 100%;
  background: var(--accent-primary);
  border-radius: 2px;
  transition: width 0.3s ease, background 0.3s ease;
}

.context-bar-fill.warning {
  background: var(--accent-warning, #f59e0b);
}

.context-bar-fill.danger {
  background: var(--accent-error, #ef4444);
}

.ai-welcome {
  padding: 16px;
  color: var(--text-secondary);
  font-size: 13px;
  line-height: 1.6;
}

.ai-welcome .welcome-section-title {
  font-weight: 600;
  color: var(--text-primary);
  margin-top: 14px;
  margin-bottom: 6px;
  display: flex;
  align-items: center;
  gap: 8px;
}

.ai-welcome .welcome-desc {
  color: var(--text-muted);
  font-size: 12px;
  margin-bottom: 4px;
}

/* 主机档案区域 */
.host-profile-section {
  background: var(--bg-tertiary);
  border-radius: 8px;
  padding: 12px;
  margin: 8px 0 16px 0;
  border: 1px solid var(--border-color);
}

.host-profile-section .welcome-section-title {
  margin-top: 0;
  margin-bottom: 10px;
}

.refresh-profile-btn {
  background: none;
  border: none;
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 14px;
  transition: all 0.2s ease;
}

.refresh-profile-btn:hover:not(:disabled) {
  background: var(--bg-surface);
}

.refresh-profile-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.refresh-profile-btn .spinning {
  display: inline-block;
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.host-profile-info {
  font-size: 12px;
}

.profile-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 0;
}

.profile-label {
  color: var(--text-secondary);
  min-width: 40px;
}

.profile-value {
  color: var(--text-primary);
}

.profile-value-secondary {
  color: var(--text-muted);
  font-size: 11px;
}

.profile-value.tools-list {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--accent-primary);
}

.profile-notes {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--border-color);
}

.profile-notes .profile-label {
  display: block;
  margin-bottom: 4px;
  font-size: 11px;
}

.profile-notes ul {
  margin: 0;
  padding-left: 16px;
}

.profile-notes li {
  color: var(--text-muted);
  font-size: 11px;
  padding: 2px 0;
}

.host-profile-loading,
.host-profile-empty {
  color: var(--text-muted);
  font-size: 12px;
  font-style: italic;
}

.ai-welcome ul {
  margin: 6px 0 8px;
  padding-left: 18px;
}

.ai-welcome li {
  margin: 4px 0;
  color: var(--text-muted);
  font-size: 12px;
}

.ai-welcome li strong {
  color: var(--accent-primary);
  font-weight: 500;
}

.strict-badge {
  display: inline-block;
  padding: 2px 6px;
  font-size: 10px;
  font-weight: 500;
  background: var(--accent-primary);
  color: #fff;
  border-radius: 4px;
  margin-left: 6px;
}

.strict-badge.relaxed {
  background: var(--accent-secondary, #10b981);
}

.message {
  margin-bottom: 12px;
}

.message.user {
  display: flex;
  justify-content: flex-end;
}

.message.assistant {
  display: flex;
  justify-content: flex-start;
}

.message-wrapper {
  position: relative;
  max-width: 85%;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.message.user .message-content {
  background: var(--accent-primary);
  color: var(--bg-primary);
  border-radius: 12px 12px 4px 12px;
  user-select: text;
  cursor: text;
}

.message.assistant .message-content {
  background: var(--bg-surface);
  color: var(--text-primary);
  border-radius: 12px 12px 12px 4px;
  user-select: text;
  cursor: text;
}

.message-content {
  padding: 10px 14px;
  font-size: 13px;
  line-height: 1.5;
  word-wrap: break-word;
  user-select: text;
  cursor: text;
}

.message-content pre {
  margin: 0;
  font-family: var(--font-mono);
  font-size: 12px;
  white-space: pre-wrap;
  user-select: text;
  cursor: text;
}

.markdown-content {
  width: 100%;
}

/* 代码块样式 */
/* 代码块样式 - 使用 :deep() 穿透 v-html */
.markdown-content :deep(.code-block) {
  margin: 12px 0;
  border-radius: 8px;
  overflow: hidden;
  background: #1a1b26;
  border: 1px solid rgba(255, 255, 255, 0.1);
  width: 100%;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
}

.markdown-content :deep(.code-header) {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 14px;
  font-size: 11px;
  font-weight: 500;
  color: #7aa2f7;
  background: #16161e;
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
  text-transform: uppercase;
  font-family: var(--font-mono);
  letter-spacing: 0.5px;
}

.markdown-content :deep(.code-actions) {
  display: flex;
  gap: 6px;
}

.markdown-content :deep(.code-copy-btn),
.markdown-content :deep(.code-send-btn) {
  padding: 4px 8px;
  font-size: 11px;
  color: #565f89;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.2s ease;
  display: flex;
  align-items: center;
}

/* 确保 SVG 不拦截点击事件 */
.markdown-content :deep(.code-copy-btn svg),
.markdown-content :deep(.code-send-btn svg) {
  pointer-events: none;
}

.markdown-content :deep(.code-copy-btn:hover) {
  color: #7aa2f7;
  background: rgba(122, 162, 247, 0.15);
  border-color: #7aa2f7;
}

.markdown-content :deep(.code-send-btn:hover) {
  color: #9ece6a;
  background: rgba(158, 206, 106, 0.15);
  border-color: #9ece6a;
}

.markdown-content :deep(.code-block pre) {
  margin: 0;
  padding: 14px 16px;
  overflow-x: auto;
  background: #1a1b26;
  white-space: pre;
}

.markdown-content :deep(.code-block code) {
  font-family: 'Fira Code', 'JetBrains Mono', 'Cascadia Code', Consolas, monospace;
  font-size: 13px;
  line-height: 1.6;
  color: #a9b1d6;
  white-space: pre;
  display: block;
}

/* 行内代码样式 */
.markdown-content :deep(.inline-code) {
  padding: 2px 6px;
  font-family: var(--font-mono);
  font-size: 12px;
  background: rgba(122, 162, 247, 0.15);
  border: 1px solid rgba(122, 162, 247, 0.3);
  border-radius: 4px;
  color: #7aa2f7;
}

/* Markdown 样式 - 使用 :deep() 穿透 v-html */
.markdown-content {
  line-height: 1.6;
}

.markdown-content :deep(p) {
  margin: 0 0 8px;
}

.markdown-content :deep(p:last-child) {
  margin-bottom: 0;
}

.markdown-content :deep(strong) {
  font-weight: 600;
  color: var(--text-primary);
}

.markdown-content :deep(em) {
  font-style: italic;
}

.markdown-content :deep(h1),
.markdown-content :deep(h2) {
  font-size: 16px;
  font-weight: 600;
  margin: 12px 0 8px;
  color: var(--text-primary);
}

.markdown-content :deep(h3) {
  font-size: 14px;
  font-weight: 600;
  margin: 10px 0 6px;
  color: var(--text-primary);
}

.markdown-content :deep(h4),
.markdown-content :deep(h5),
.markdown-content :deep(h6) {
  font-size: 13px;
  font-weight: 600;
  margin: 8px 0 4px;
  color: var(--text-primary);
}

.markdown-content :deep(ul),
.markdown-content :deep(ol) {
  margin: 8px 0;
  padding-left: 20px;
}

.markdown-content :deep(li) {
  margin: 4px 0;
}

.markdown-content :deep(ul li) {
  list-style-type: disc;
}

.markdown-content :deep(ol li) {
  list-style-type: decimal;
}

.markdown-content :deep(blockquote) {
  margin: 8px 0;
  padding: 8px 12px;
  border-left: 3px solid var(--accent-primary);
  background: var(--bg-tertiary);
  color: var(--text-secondary);
}

.markdown-content :deep(a) {
  color: var(--accent-primary);
  text-decoration: none;
}

.markdown-content :deep(a:hover) {
  text-decoration: underline;
}

.markdown-content :deep(hr) {
  border: none;
  border-top: 1px solid var(--border-color);
  margin: 12px 0;
}

.markdown-content :deep(table) {
  border-collapse: collapse;
  margin: 8px 0;
  width: 100%;
}

.markdown-content :deep(th),
.markdown-content :deep(td) {
  border: 1px solid var(--border-color);
  padding: 6px 10px;
  text-align: left;
}

.markdown-content :deep(th) {
  background: var(--bg-tertiary);
  font-weight: 600;
}

.copy-btn {
  align-self: flex-start;
  padding: 4px 8px;
  font-size: 11px;
  color: var(--text-muted);
  background: transparent;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  opacity: 0.6;
  transition: all 0.2s ease;
  display: flex;
  align-items: center;
  gap: 4px;
}

.copy-btn:hover {
  opacity: 1;
  background: var(--bg-hover);
  color: var(--accent-primary);
}

.ai-input {
  display: flex;
  gap: 8px;
  padding: 12px;
  border-top: 1px solid var(--border-color);
}

.ai-input textarea {
  flex: 1;
  padding: 10px 12px;
  font-size: 13px;
  font-family: inherit;
  color: var(--text-primary);
  background: var(--bg-tertiary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  resize: none;
  outline: none;
}

.ai-input textarea:focus {
  border-color: var(--accent-primary);
}

.send-btn {
  align-self: flex-end;
  padding: 10px 16px;
}

.stop-btn {
  align-self: flex-end;
  padding: 10px 16px;
  background: var(--accent-error, #f44336);
  border-color: var(--accent-error, #f44336);
  animation: pulse 1.5s ease-in-out infinite;
}

.stop-btn:hover {
  background: #d32f2f;
  border-color: #d32f2f;
}

@keyframes pulse {
  0%, 100% {
    opacity: 1;
  }
  50% {
    opacity: 0.7;
  }
}

/* ==================== Agent 模式样式 ==================== */

/* 模式切换 */
.mode-switcher {
  display: flex;
  padding: 8px 12px;
  gap: 8px;
  border-bottom: 1px solid var(--border-color);
}

.mode-btn {
  flex: 1;
  padding: 6px 12px;
  font-size: 12px;
  font-weight: 500;
  color: var(--text-secondary);
  background: var(--bg-tertiary);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.mode-btn:hover {
  background: var(--bg-surface);
  color: var(--text-primary);
}

.mode-btn.active {
  background: var(--accent-primary);
  color: #fff;
  border-color: var(--accent-primary);
}

/* Agent 设置区域 */
.agent-settings {
  display: flex;
  align-items: center;
  gap: 12px;
}

/* 超时设置 */
.timeout-setting {
  display: flex;
  align-items: center;
  gap: 4px;
}

.timeout-label {
  font-size: 11px;
  color: var(--text-secondary);
}

.timeout-select {
  font-size: 11px;
  padding: 2px 4px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border-color);
  border-radius: 4px;
  color: var(--text-primary);
  cursor: pointer;
  outline: none;
}

.timeout-select:hover {
  border-color: var(--accent-primary);
}

.timeout-select:focus {
  border-color: var(--accent-primary);
}

/* 严格模式开关 */
.strict-mode-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  user-select: none;
}

.toggle-label {
  font-size: 11px;
  color: var(--text-secondary);
}

.toggle-switch {
  position: relative;
  width: 32px;
  height: 18px;
  background: var(--bg-tertiary);
  border-radius: 9px;
  border: 1px solid var(--border-color);
  transition: all 0.2s;
}

.toggle-switch.active {
  background: var(--accent-primary);
  border-color: var(--accent-primary);
}

.toggle-dot {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 12px;
  height: 12px;
  background: #fff;
  border-radius: 50%;
  transition: transform 0.2s;
}

.toggle-switch.active .toggle-dot {
  transform: translateX(14px);
}

/* Agent 步骤（融入对话） */
.agent-steps-wrapper {
  max-width: 95% !important;
}

.agent-steps-content {
  padding: 12px 14px !important;
}

.agent-steps-header-inline {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--accent-primary);
  padding-bottom: 8px;
  border-bottom: 1px solid var(--border-color);
  cursor: pointer;
  user-select: none;
}

.agent-steps-header-inline:hover {
  opacity: 0.8;
}

.steps-count {
  font-size: 11px;
  font-weight: 500;
  color: var(--text-muted);
  margin-left: auto;
}

.collapse-icon {
  font-size: 10px;
  color: var(--text-muted);
  transition: transform 0.2s ease;
}

.collapse-icon.collapsed {
  transform: rotate(-90deg);
}

.agent-steps-body {
  margin-top: 10px;
}

/* Agent 最终回复 */
.agent-final-result {
  margin-top: 12px;
}

.final-result-divider {
  height: 1px;
  background: linear-gradient(to right, var(--accent-primary), transparent);
  margin-bottom: 12px;
}

.final-result-content {
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-primary);
}

.final-result-content :deep(p) {
  margin: 0 0 8px;
}

.final-result-content :deep(p:last-child) {
  margin-bottom: 0;
}

.agent-running-dot {
  width: 8px;
  height: 8px;
  background: var(--accent-primary);
  border-radius: 50%;
  animation: pulse-dot 1.5s ease-in-out infinite;
}

@keyframes pulse-dot {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.5; transform: scale(0.8); }
}

/* Agent 步骤消息（紧凑显示） */
.agent-step-message {
  margin-bottom: 4px !important;
}

.agent-step-message .message-wrapper {
  padding: 6px 0;
}

.agent-step-content-inline {
  display: flex;
  gap: 8px;
  padding: 8px 12px !important;
  font-size: 12px;
  color: var(--text-secondary);
  background: var(--bg-tertiary);
  border-radius: 8px;
}

.agent-step-inline {
  display: flex;
  gap: 8px;
  padding: 8px 0;
  font-size: 12px;
  color: var(--text-secondary);
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
}

.agent-step-inline:last-child {
  border-bottom: none;
  padding-bottom: 0;
}

.step-icon {
  flex-shrink: 0;
  font-size: 14px;
}

.step-content {
  flex: 1;
  min-width: 0;
}

.step-text {
  word-break: break-word;
  line-height: 1.5;
}

/* AI 分析文本样式 */
.step-text.step-analysis {
  color: var(--text-primary);
  background: rgba(255, 255, 255, 0.03);
  padding: 8px 10px;
  border-radius: 6px;
  margin: -4px 0;
}

.step-result {
  margin-top: 6px;
  padding: 8px 10px;
  background: rgba(0, 0, 0, 0.2);
  border-radius: 6px;
  font-family: var(--font-mono);
  font-size: 11px;
  max-height: 120px;
  overflow-y: auto;
}

.step-result pre {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-all;
  color: var(--text-muted);
}

.agent-step-inline.tool_call {
  color: var(--accent-primary);
}

.agent-step-inline.tool_call .step-text {
  color: var(--text-primary);
}

.agent-step-inline.error {
  color: var(--accent-error, #f44336);
}

.agent-step-inline.message {
  color: var(--text-primary);
}

/* 风险等级颜色 */
.risk-safe {
  border-left: 3px solid #10b981;
  padding-left: 10px;
  margin-left: -2px;
}

.risk-moderate {
  border-left: 3px solid #f59e0b;
  padding-left: 10px;
  margin-left: -2px;
}

.risk-dangerous {
  border-left: 3px solid #ef4444;
  padding-left: 10px;
  margin-left: -2px;
}

.risk-blocked {
  border-left: 3px solid #6b7280;
  padding-left: 10px;
}

/* 拒绝执行的步骤 */
.step-rejected {
  opacity: 0.6;
  border-left: 3px solid #ef4444 !important;
  padding-left: 10px;
  margin-left: -2px;
  opacity: 0.6;
}

/* Agent 确认对话框（融入对话） */
.agent-confirm-inline {
  padding: 14px !important;
  background: linear-gradient(135deg, rgba(245, 158, 11, 0.15), rgba(245, 158, 11, 0.05)) !important;
  border: 1px solid rgba(245, 158, 11, 0.3) !important;
}

.confirm-header-inline {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}

.confirm-icon {
  font-size: 18px;
}

.confirm-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}

.confirm-risk-badge {
  padding: 3px 8px;
  font-size: 10px;
  font-weight: 600;
  border-radius: 10px;
  margin-left: auto;
}

.confirm-risk-badge.risk-dangerous {
  background: rgba(239, 68, 68, 0.2);
  color: #ef4444;
}

.confirm-risk-badge.risk-moderate {
  background: rgba(245, 158, 11, 0.2);
  color: #f59e0b;
}

.confirm-detail {
  margin-bottom: 12px;
}

.confirm-tool-name {
  font-size: 12px;
  font-weight: 600;
  color: var(--accent-primary);
  margin-bottom: 6px;
}

.confirm-args-inline {
  padding: 10px;
  background: rgba(0, 0, 0, 0.2);
  border-radius: 6px;
  font-family: var(--font-mono);
  font-size: 12px;
  margin: 0;
  max-height: 100px;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-all;
  color: var(--text-primary);
}

.confirm-actions-inline {
  display: flex;
  gap: 10px;
  justify-content: flex-end;
}

.btn-outline-danger {
  background: transparent;
  border: 1px solid #ef4444;
  color: #ef4444;
}

.btn-outline-danger:hover {
  background: rgba(239, 68, 68, 0.1);
}

/* 成功按钮样式 */
.btn-success {
  background: #10b981;
  border-color: #10b981;
  color: #fff;
}

.btn-success:hover:not(:disabled) {
  background: #059669;
  border-color: #059669;
}
</style>

