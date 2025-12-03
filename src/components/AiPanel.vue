<script setup lang="ts">
import { ref, computed, nextTick, inject } from 'vue'
import { useConfigStore } from '../stores/config'
import { useTerminalStore } from '../stores/terminal'

const emit = defineEmits<{
  close: []
}>()

const configStore = useConfigStore()
const terminalStore = useTerminalStore()
const showSettings = inject<() => void>('showSettings')

interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: Date
}

const messages = ref<ChatMessage[]>([])
const inputText = ref('')
const isLoading = ref(false)
const messagesRef = ref<HTMLDivElement | null>(null)
const selectedText = ref('')

const hasAiConfig = computed(() => configStore.hasAiConfig)

// 滚动到底部
const scrollToBottom = async () => {
  await nextTick()
  if (messagesRef.value) {
    messagesRef.value.scrollTop = messagesRef.value.scrollHeight
  }
}

// 发送消息
const sendMessage = async () => {
  if (!inputText.value.trim() || isLoading.value) return

  const userMessage: ChatMessage = {
    id: Date.now().toString(),
    role: 'user',
    content: inputText.value,
    timestamp: new Date()
  }

  messages.value.push(userMessage)
  const prompt = inputText.value
  inputText.value = ''
  isLoading.value = true
  await scrollToBottom()

  // 创建 AI 响应占位
  const assistantMessage: ChatMessage = {
    id: (Date.now() + 1).toString(),
    role: 'assistant',
    content: '思考中...',
    timestamp: new Date()
  }
  messages.value.push(assistantMessage)
  const messageIndex = messages.value.length - 1
  await scrollToBottom()

  try {
    let firstChunk = true
    // 使用流式响应
    window.electronAPI.ai.chatStream(
      [
        {
          role: 'system',
          content:
            '你是旗鱼终端的 AI 助手，专门帮助运维人员解决命令行相关问题。请用中文回答，回答要简洁实用。'
        },
        { role: 'user', content: prompt }
      ],
      chunk => {
        if (firstChunk) {
          messages.value[messageIndex].content = chunk
          firstChunk = false
        } else {
          messages.value[messageIndex].content += chunk
        }
        scrollToBottom()
      },
      () => {
        isLoading.value = false
        scrollToBottom()
      },
      error => {
        messages.value[messageIndex].content = `错误: ${error}`
        isLoading.value = false
      }
    )
  } catch (error) {
    messages.value[messageIndex].content = `错误: ${error}`
    isLoading.value = false
  }
}

// 解释命令
const explainCommand = async (command: string) => {
  if (isLoading.value) return

  const userMessage: ChatMessage = {
    id: Date.now().toString(),
    role: 'user',
    content: `请解释这个命令：\`${command}\``
  ,
    timestamp: new Date()
  }
  messages.value.push(userMessage)
  isLoading.value = true
  await scrollToBottom()

  const assistantMessage: ChatMessage = {
    id: (Date.now() + 1).toString(),
    role: 'assistant',
    content: '分析中...',
    timestamp: new Date()
  }
  messages.value.push(assistantMessage)
  const messageIndex = messages.value.length - 1
  await scrollToBottom()

  let firstChunk = true
  window.electronAPI.ai.chatStream(
    [
      {
        role: 'system',
        content:
          '你是一个专业的 Linux/Unix 系统管理员助手。用户会给你一个命令，请用中文简洁地解释这个命令的作用、参数含义，以及可能的注意事项。'
      },
      { role: 'user', content: `请解释这个命令：\n\`\`\`\n${command}\n\`\`\`` }
    ],
    chunk => {
      if (firstChunk) {
        messages.value[messageIndex].content = chunk
        firstChunk = false
      } else {
        messages.value[messageIndex].content += chunk
      }
      scrollToBottom()
    },
    () => {
      isLoading.value = false
      scrollToBottom()
    },
    error => {
      messages.value[messageIndex].content = `错误: ${error}`
      isLoading.value = false
    }
  )
}

// 生成命令
const generateCommand = async (description: string) => {
  if (isLoading.value) return

  const userMessage: ChatMessage = {
    id: Date.now().toString(),
    role: 'user',
    content: description,
    timestamp: new Date()
  }
  messages.value.push(userMessage)
  isLoading.value = true
  await scrollToBottom()

  const assistantMessage: ChatMessage = {
    id: (Date.now() + 1).toString(),
    role: 'assistant',
    content: '生成中...',
    timestamp: new Date()
  }
  messages.value.push(assistantMessage)
  const messageIndex = messages.value.length - 1
  await scrollToBottom()

  let firstChunk = true
  window.electronAPI.ai.chatStream(
    [
      {
        role: 'system',
        content: `你是一个专业的命令行助手。用户会用自然语言描述他想做的事情，请生成对应的命令并简要解释。当前操作系统是 ${navigator.platform}。`
      },
      { role: 'user', content: description }
    ],
    chunk => {
      if (firstChunk) {
        messages.value[messageIndex].content = chunk
        firstChunk = false
      } else {
        messages.value[messageIndex].content += chunk
      }
      scrollToBottom()
    },
    () => {
      isLoading.value = false
      scrollToBottom()
    },
    error => {
      messages.value[messageIndex].content = `错误: ${error}`
      isLoading.value = false
    }
  )
}

// 清空对话
const clearMessages = () => {
  messages.value = []
}

// 复制消息
const copyMessage = async (content: string) => {
  try {
    await navigator.clipboard.writeText(content)
    // 可以添加一个提示
  } catch (error) {
    console.error('复制失败:', error)
  }
}

// 渲染 Markdown 格式
const renderMarkdown = (text: string): string => {
  if (!text) return ''
  
  // 转义 HTML 特殊字符
  const escapeHtml = (str: string) => {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;')
  }
  
  // 先提取代码块，用占位符替换
  const codeBlocks: string[] = []
  let result = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (match, lang, code) => {
    const language = lang || 'text'
    const trimmedCode = code.trim()
    // 对代码内容做base64编码避免onclick中的特殊字符问题
    let encodedCode = ''
    try {
      encodedCode = btoa(unescape(encodeURIComponent(trimmedCode)))
    } catch (e) {
      encodedCode = ''
    }
    const placeholder = `__CODE_BLOCK_${codeBlocks.length}__`
    codeBlocks.push(`<div class="code-block"><div class="code-header"><span>${escapeHtml(language)}</span>${encodedCode ? `<button class="code-copy-btn" onclick="copyCode('${encodedCode}')" title="复制代码"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>` : ''}</div><pre><code>${escapeHtml(trimmedCode)}</code></pre></div>`)
    return placeholder
  })
  
  // 转义剩余文本的 HTML
  result = escapeHtml(result)
  
  // 处理行内代码 `code`
  result = result.replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>')
  
  // 处理换行（只对非代码块内容）
  result = result.replace(/\n/g, '<br>')
  
  // 还原代码块
  codeBlocks.forEach((block, index) => {
    result = result.replace(`__CODE_BLOCK_${index}__`, block)
  })
  
  return result
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
        <button
          class="btn btn-primary send-btn"
          :disabled="!inputText.trim() || isLoading"
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
  gap: 4px;
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
.code-block {
  margin: 8px 0;
  border-radius: 6px;
  overflow: hidden;
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
}

.code-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 12px;
  font-size: 11px;
  font-weight: 500;
  color: var(--text-muted);
  background: var(--bg-tertiary);
  border-bottom: 1px solid var(--border-color);
  text-transform: uppercase;
  font-family: var(--font-mono);
}

.code-copy-btn {
  padding: 2px 6px;
  font-size: 11px;
  color: var(--text-muted);
  background: transparent;
  border: 1px solid transparent;
  border-radius: 3px;
  cursor: pointer;
  transition: all 0.2s ease;
  display: flex;
  align-items: center;
}

.code-copy-btn:hover {
  color: var(--accent-primary);
  background: var(--bg-hover);
  border-color: var(--accent-primary);
}

.code-block pre {
  margin: 0;
  padding: 12px;
  overflow-x: auto;
  background: var(--bg-primary);
}

.code-block code {
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-primary);
}

/* 行内代码样式 */
.inline-code {
  padding: 2px 6px;
  font-family: var(--font-mono);
  font-size: 12px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border-color);
  border-radius: 3px;
  color: var(--accent-primary);
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
</style>

