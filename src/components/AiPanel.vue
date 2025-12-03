<script setup lang="ts">
import { ref, computed, nextTick, inject, watch } from 'vue'
import { marked } from 'marked'
import { useConfigStore } from '../stores/config'
import { useTerminalStore } from '../stores/terminal'

const emit = defineEmits<{
  close: []
}>()

const configStore = useConfigStore()
const terminalStore = useTerminalStore()
const showSettings = inject<() => void>('showSettings')

import type { AiMessage } from '../stores/terminal'

const inputText = ref('')
const isLoading = ref(false)
const messagesRef = ref<HTMLDivElement | null>(null)
const selectedText = ref('')

// 当前终端的 AI 消息（每个终端独立）
const messages = computed(() => {
  const activeTab = terminalStore.activeTab
  return activeTab?.aiMessages || []
})

// 当前终端 ID
const currentTabId = computed(() => terminalStore.activeTabId)

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

// 检查是否有可发送的终端内容
const hasTerminalContext = computed(() => {
  return !!terminalSelectedText.value || !!lastError.value
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
  const prompt = inputText.value
  inputText.value = ''
  isLoading.value = true
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
    // 使用流式响应
    window.electronAPI.ai.chatStream(
      [
        {
          role: 'system',
          content: getSystemPrompt()
        },
        { role: 'user', content: prompt }
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
        isLoading.value = false
        scrollToBottom()
      },
      error => {
        terminalStore.updateAiMessage(tabId, messageIndex, `错误: ${error}`)
        isLoading.value = false
      }
    )
  } catch (error) {
    terminalStore.updateAiMessage(tabId, messageIndex, `错误: ${error}`)
    isLoading.value = false
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
  isLoading.value = true
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
      isLoading.value = false
      scrollToBottom()
    },
    error => {
      terminalStore.updateAiMessage(tabId, messageIndex, `错误: ${error}`)
      isLoading.value = false
    }
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
  isLoading.value = true
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
      isLoading.value = false
      scrollToBottom()
    },
    error => {
      terminalStore.updateAiMessage(tabId, messageIndex, `错误: ${error}`)
      isLoading.value = false
    }
  )
}

// 清空对话
const clearMessages = () => {
  if (currentTabId.value) {
    terminalStore.clearAiMessages(currentTabId.value)
  }
}

// 停止生成
const stopGeneration = async () => {
  await window.electronAPI.ai.abort()
  isLoading.value = false
}

// 诊断错误
const diagnoseError = async () => {
  const error = lastError.value
  if (!error || isLoading.value || !currentTabId.value) return

  const tabId = currentTabId.value
  
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
  isLoading.value = true
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
      isLoading.value = false
      scrollToBottom()
    },
    err => {
      terminalStore.updateAiMessage(tabId, messageIndex, `错误: ${err}`)
      isLoading.value = false
    }
  )
}

// 分析选中的终端内容
const analyzeSelection = async () => {
  const selection = terminalSelectedText.value
  if (!selection || isLoading.value || !currentTabId.value) return

  const tabId = currentTabId.value
  const userMessage: AiMessage = {
    id: Date.now().toString(),
    role: 'user',
    content: `请帮我分析这段终端输出：\n\`\`\`\n${selection}\n\`\`\``,
    timestamp: new Date()
  }
  terminalStore.addAiMessage(tabId, userMessage)
  isLoading.value = true
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
      isLoading.value = false
      scrollToBottom()
    },
    err => {
      terminalStore.updateAiMessage(tabId, messageIndex, `错误: ${err}`)
      isLoading.value = false
    }
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
  isLoading.value = true
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
      isLoading.value = false
      scrollToBottom()
    },
    err => {
      terminalStore.updateAiMessage(tabId, messageIndex, `错误: ${err}`)
      isLoading.value = false
    }
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
renderer.code = (code: string, language?: string) => {
  const lang = language || 'text'
  let encodedCode = ''
  try {
    encodedCode = btoa(unescape(encodeURIComponent(code)))
  } catch (e) {
    encodedCode = ''
  }
  
  const copyBtn = encodedCode 
    ? `<button class="code-copy-btn" onclick="copyCode('${encodedCode}')" title="复制代码"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>`
    : ''
  
  const sendBtn = encodedCode
    ? `<button class="code-send-btn" onclick="sendCodeToTerminal('${encodedCode}')" title="发送到终端"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 10 4 15 9 20"/><path d="M20 4v7a4 4 0 0 1-4 4H4"/></svg></button>`
    : ''
  
  return `<div class="code-block"><div class="code-header"><span>${lang}</span><div class="code-actions">${sendBtn}${copyBtn}</div></div><pre><code>${code}</code></pre></div>`
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

// 暴露到window对象供HTML中的onclick使用
;(window as any).copyCode = async (encodedCode: string) => {
  try {
    const code = decodeURIComponent(escape(atob(encodedCode)))
    await navigator.clipboard.writeText(code)
  } catch (error) {
    console.error('复制代码失败:', error)
  }
}

// 发送代码到终端
;(window as any).sendCodeToTerminal = async (encodedCode: string) => {
  try {
    const code = decodeURIComponent(escape(atob(encodedCode)))
    const activeTab = terminalStore.activeTab
    if (activeTab?.ptyId) {
      // 发送代码到终端（不自动添加回车，让用户确认后再执行）
      await terminalStore.writeToTerminal(activeTab.id, code)
    }
  } catch (error) {
    console.error('发送到终端失败:', error)
  }
}

// 快捷操作
const quickActions = [
  { label: '解释命令', icon: '💡', action: () => explainCommand(selectedText.value || 'ls -la') },
  { label: '查找文件', icon: '🔍', action: () => generateCommand('查找当前目录下所有的日志文件') },
  { label: '查看进程', icon: '📊', action: () => generateCommand('查看占用内存最多的前10个进程') },
  { label: '磁盘空间', icon: '💾', action: () => generateCommand('查看磁盘空间使用情况') }
]
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
      <!-- 系统环境信息 -->
      <div v-if="currentSystemInfo" class="system-info-bar">
        <span class="system-icon">💻</span>
        <span class="system-text">
          {{ currentSystemInfo.os === 'windows' ? 'Windows' : currentSystemInfo.os === 'macos' ? 'macOS' : 'Linux' }}
          · {{ currentSystemInfo.shell === 'powershell' ? 'PowerShell' : currentSystemInfo.shell === 'cmd' ? 'CMD' : currentSystemInfo.shell === 'bash' ? 'Bash' : currentSystemInfo.shell === 'zsh' ? 'Zsh' : currentSystemInfo.shell }}
        </span>
      </div>

      <!-- 错误诊断提示 -->
      <div v-if="lastError" class="error-alert">
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

      <!-- 终端选中内容提示 -->
      <div v-if="terminalSelectedText && !lastError" class="selection-alert">
        <div class="selection-alert-icon">📋</div>
        <div class="selection-alert-content">
          <div class="selection-alert-title">已选中终端内容</div>
          <div class="selection-alert-text">{{ terminalSelectedText.slice(0, 60) }}{{ terminalSelectedText.length > 60 ? '...' : '' }}</div>
        </div>
        <button class="selection-alert-btn" @click="analyzeSelection" :disabled="isLoading">
          AI 分析
        </button>
      </div>

      <!-- 快捷操作 -->
      <div class="quick-actions">
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
      <div ref="messagesRef" class="ai-messages">
        <div v-if="messages.length === 0" class="ai-welcome">
          <p>你好！我是旗鱼终端的 AI 助手。</p>
          <p>我可以帮你：</p>
          <ul>
            <li>解释命令的作用</li>
            <li>诊断错误并提供解决方案</li>
            <li>根据描述生成命令</li>
          </ul>
        </div>
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
      </div>

      <!-- 输入区域 -->
      <div class="ai-input">
        <textarea
          v-model="inputText"
          placeholder="输入问题或描述你想要的命令..."
          rows="2"
          @keydown.enter.exact.prevent="sendMessage"
        ></textarea>
        <!-- 停止按钮 -->
        <button
          v-if="isLoading"
          class="btn btn-danger stop-btn"
          @click="stopGeneration"
          title="停止生成"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <rect x="6" y="6" width="12" height="12" rx="2"/>
          </svg>
        </button>
        <!-- 发送按钮 -->
        <button
          v-else
          class="btn btn-primary send-btn"
          :disabled="!inputText.trim()"
          @click="sendMessage"
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
  gap: 6px;
  padding: 8px 12px;
  background: var(--bg-tertiary);
  border-bottom: 1px solid var(--border-color);
  font-size: 11px;
  color: var(--text-muted);
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
  background: rgba(244, 63, 94, 0.1);
  border-bottom: 1px solid rgba(244, 63, 94, 0.2);
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
  background: rgba(59, 130, 246, 0.1);
  border-bottom: 1px solid rgba(59, 130, 246, 0.2);
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

.ai-welcome {
  padding: 16px;
  color: var(--text-muted);
  font-size: 13px;
  line-height: 1.6;
}

.ai-welcome ul {
  margin-top: 8px;
  padding-left: 20px;
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
</style>

