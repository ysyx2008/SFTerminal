<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed, toRaw } from 'vue'
import { useI18n } from 'vue-i18n'
import { Plus, Pencil, Trash2, X } from 'lucide-vue-next'
import { showConfirm, showAlert } from '../../composables/useConfirm'
import { v4 as uuidv4 } from 'uuid'

const { t } = useI18n()

// 类型定义
interface McpServerConfig {
  id: string
  name: string
  enabled: boolean
  transport: 'stdio' | 'sse' | 'http'
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  url?: string
  headers?: Record<string, string>
  whenToUse?: string
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

interface McpTool {
  serverId: string
  serverName: string
  name: string
  description: string
}

interface McpResource {
  serverId: string
  serverName: string
  uri: string
  name: string
  description?: string
}

interface McpPrompt {
  serverId: string
  serverName: string
  name: string
  description?: string
}

// ESC 关闭子弹窗
const showForm = ref(false)
const showDetails = ref(false)
const showImport = ref(false)
  const handleKeydown = (e: KeyboardEvent) => {
  if (e.key === 'Escape') {
    if (showWhenToUseConfirm.value) {
      e.stopImmediatePropagation()
      cancelWhenToUse()
    } else if (showDetails.value) {
      e.stopImmediatePropagation()
      showDetails.value = false
    } else if (showImport.value) {
      e.stopImmediatePropagation()
      showImport.value = false
    } else if (showForm.value) {
      e.stopImmediatePropagation()
      showForm.value = false
    }
  }
}

onMounted(() => {
  document.addEventListener('keydown', handleKeydown, true)
})

onUnmounted(() => {
  document.removeEventListener('keydown', handleKeydown, true)
})

// 状态
const servers = ref<McpServerConfig[]>([])
const serverStatuses = ref<McpServerStatus[]>([])
const editingServer = ref<McpServerConfig | null>(null)
const testResult = ref<{ success: boolean; message: string } | null>(null)
const testing = ref(false)
const connecting = ref<string | null>(null)

// 详情弹窗
const selectedServer = ref<McpServerConfig | null>(null)
const serverTools = ref<McpTool[]>([])
const serverResources = ref<McpResource[]>([])
const serverPrompts = ref<McpPrompt[]>([])

// 表单数据
const formData = ref<Partial<McpServerConfig>>({
  name: '',
  enabled: true,
  transport: 'stdio',
  command: '',
  args: [],
  env: {},
  cwd: '',
  url: '',
  headers: {},
  whenToUse: ''
})

/** whenToUse 确认弹窗（不可跳过留空） */
const showWhenToUseConfirm = ref(false)
const whenToUseDraft = ref('')
const whenToUseGenerating = ref(false)
const whenToUseError = ref('')
let whenToUseConfirmResolve: ((value: string | null) => void) | null = null

// 用于编辑 args / env / headers 的辅助字段
const argsText = ref('')
const envText = ref('')
const headersText = ref('')

// 从 JSON 一键导入（showImport 在顶部已声明）
const importText = ref('')
const importResult = ref<{ success: boolean; message: string } | null>(null)

// JSON placeholder 不走 i18n：里面的 `{` / `}` 会被 vue-i18n 当作命名占位符语法解析失败。
// 示例本身是格式化的 JSON，跟语言无关，硬编码即可。
const IMPORT_JSON_PLACEHOLDER = `{
  "mcpServers": {
    "qcc-company": {
      "url": "https://agent.qcc.com/mcp/company/stream",
      "headers": {
        "Authorization": "Bearer YOUR_TOKEN_HERE"
      }
    }
  }
}`

// 模板类型
interface McpTemplate {
  name: string
  transport: 'stdio' | 'sse' | 'http'
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
}

// 获取预设模板
const getTemplates = (): McpTemplate[] => [
  {
    name: t('mcpSettings.templates.filesystem'),
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '/path/to/allowed/dir']
  },
  {
    name: t('mcpSettings.templates.github'),
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    env: { GITHUB_PERSONAL_ACCESS_TOKEN: t('mcpSettings.placeholders.githubToken') }
  },
  {
    name: t('mcpSettings.templates.postgres'),
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-postgres', 'postgresql://localhost/mydb']
  },
  {
    name: t('mcpSettings.templates.sqlite'),
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sqlite', '/path/to/database.db']
  },
  {
    name: t('mcpSettings.templates.httpBearer'),
    transport: 'http',
    url: 'https://example.com/mcp/stream',
    headers: { Authorization: t('mcpSettings.placeholders.bearerToken') }
  }
]

const templates = computed(() => getTemplates())

// 计算属性
const isUnhealthy = (server: McpServerConfig) => {
  if (!server.enabled) return false
  const st = getServerStatus(server.id)
  return !!st && !st.connected && !!st.error
}

const isConnecting = (server: McpServerConfig) =>
  server.enabled && !getServerStatus(server.id)?.connected && !isUnhealthy(server)

const failedCount = computed(() => servers.value.filter(isUnhealthy).length)
const connectingCount = computed(() => servers.value.filter(isConnecting).length)

// 加载服务器配置
const loadServers = async () => {
  servers.value = await window.electronAPI.mcp.getServers()
  await refreshStatuses()
}

// 刷新连接状态
const refreshStatuses = async () => {
  serverStatuses.value = await window.electronAPI.mcp.getServerStatuses()
}

// 获取服务器状态
const getServerStatus = (serverId: string): McpServerStatus | undefined => {
  return serverStatuses.value.find(s => s.id === serverId)
}

// 重置表单
const resetForm = () => {
  formData.value = {
    name: '',
    enabled: true,
    transport: 'stdio',
    command: '',
    args: [],
    env: {},
    cwd: '',
    url: '',
    headers: {},
    whenToUse: ''
  }
  argsText.value = ''
  envText.value = ''
  headersText.value = ''
  editingServer.value = null
  testResult.value = null
}

// 打开新建表单
const openNewServer = () => {
  resetForm()
  showForm.value = true
}

// 打开编辑表单
const openEditServer = (server: McpServerConfig) => {
  editingServer.value = server
  formData.value = { ...server }
  argsText.value = (server.args || []).join('\n')
  envText.value = Object.entries(server.env || {})
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')
  headersText.value = Object.entries(server.headers || {})
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n')
  testResult.value = null
  showForm.value = true
}

// 应用模板
const applyTemplate = (template: McpTemplate) => {
  formData.value.name = template.name
  formData.value.transport = template.transport
  formData.value.command = template.command || ''
  formData.value.args = template.args ? [...template.args] : []
  formData.value.env = template.env ? { ...template.env } : {}
  formData.value.url = template.url || ''
  formData.value.headers = template.headers ? { ...template.headers } : {}
  argsText.value = (template.args || []).join('\n')
  envText.value = template.env
    ? Object.entries(template.env).map(([k, v]) => `${k}=${v}`).join('\n')
    : ''
  headersText.value = template.headers
    ? Object.entries(template.headers).map(([k, v]) => `${k}: ${v}`).join('\n')
    : ''
}

// 解析 args 文本
const parseArgs = () => {
  formData.value.args = argsText.value
    .split('\n')
    .map(s => s.trim())
    .filter(s => s.length > 0)
}

// 解析 env 文本
const parseEnv = () => {
  const env: Record<string, string> = {}
  envText.value.split('\n').forEach(line => {
    const trimmed = line.trim()
    if (trimmed && trimmed.includes('=')) {
      const [key, ...valueParts] = trimmed.split('=')
      env[key.trim()] = valueParts.join('=').trim()
    }
  })
  formData.value.env = env
}

// 解析 headers 文本（每行 Key: Value，兼容 Key=Value）
const parseHeaders = () => {
  const headers: Record<string, string> = {}
  headersText.value.split('\n').forEach(line => {
    const trimmed = line.trim()
    if (!trimmed) return
    // 优先按冒号分隔（HTTP 头标准格式），兼容等号分隔
    const sepIdx = trimmed.indexOf(':')
    const eqIdx = trimmed.indexOf('=')
    const splitAt = sepIdx > 0 && (eqIdx < 0 || sepIdx < eqIdx) ? sepIdx : eqIdx
    if (splitAt > 0) {
      const key = trimmed.substring(0, splitAt).trim()
      const value = trimmed.substring(splitAt + 1).trim()
      if (key) headers[key] = value
    }
  })
  formData.value.headers = headers
}

// 测试连接
const testConnection = async () => {
  if (!formData.value.name) {
    testResult.value = { success: false, message: t('mcpSettings.pleaseInputServerName') }
    return
  }

  parseArgs()
  parseEnv()
  parseHeaders()

  // 使用 toRaw 转换响应式对象，避免 IPC 克隆错误
  const testConfig: McpServerConfig = {
    id: editingServer.value?.id || `test_${Date.now()}`,
    name: formData.value.name,
    enabled: true,
    transport: formData.value.transport || 'stdio',
    command: formData.value.command,
    args: toRaw(formData.value.args) || [],
    env: toRaw(formData.value.env) || {},
    cwd: formData.value.cwd,
    url: formData.value.url,
    headers: toRaw(formData.value.headers) || {}
  }

  testing.value = true
  testResult.value = null

  try {
    const result = await window.electronAPI.mcp.testConnection(testConfig)
    if (result.success) {
      testResult.value = {
        success: true,
        message: t('mcpSettings.connectionSuccess', { tools: result.toolCount, resources: result.resourceCount, prompts: result.promptCount })
      }
    } else {
      testResult.value = { success: false, message: result.error || t('mcpSettings.connectionFailed') }
    }
  } catch (error) {
    testResult.value = {
      success: false,
      message: error instanceof Error ? error.message : t('mcpSettings.testFailed')
    }
  } finally {
    testing.value = false
  }
}

// 保存服务器
const buildServerFromForm = (): McpServerConfig => {
  parseArgs()
  parseEnv()
  parseHeaders()
  const rawArgs = toRaw(formData.value.args) || []
  const rawEnv = toRaw(formData.value.env) || {}
  const rawHeaders = toRaw(formData.value.headers) || {}
  return {
    id: editingServer.value?.id || uuidv4(),
    name: formData.value.name!,
    enabled: formData.value.enabled ?? true,
    transport: formData.value.transport || 'stdio',
    command: formData.value.command,
    args: rawArgs,
    env: Object.keys(rawEnv).length > 0 ? rawEnv : undefined,
    cwd: formData.value.cwd || undefined,
    url: formData.value.url,
    headers: Object.keys(rawHeaders).length > 0 ? rawHeaders : undefined,
    whenToUse: (formData.value.whenToUse || '').trim() || undefined
  }
}

/** 弹出确认框；返回确认后的文案，取消返回 null */
const promptWhenToUseConfirm = async (
  draft: string,
  errorMsg = ''
): Promise<string | null> => {
  whenToUseDraft.value = draft
  whenToUseError.value = errorMsg
  showWhenToUseConfirm.value = true
  return new Promise((resolve) => {
    whenToUseConfirmResolve = resolve
  })
}

const acceptWhenToUse = () => {
  const text = whenToUseDraft.value.trim().slice(0, 200)
  if (!text) {
    whenToUseError.value = t('mcpSettings.whenToUseRequired')
    return
  }
  showWhenToUseConfirm.value = false
  whenToUseConfirmResolve?.(text)
  whenToUseConfirmResolve = null
}

const cancelWhenToUse = () => {
  showWhenToUseConfirm.value = false
  whenToUseConfirmResolve?.(null)
  whenToUseConfirmResolve = null
}

const generateWhenToUseDraft = async (
  server: McpServerConfig
): Promise<{ draft: string; error?: string; toolsOk: boolean }> => {
  whenToUseGenerating.value = true
  try {
    let tools: Array<{ name: string; title?: string; description?: string }> = []
    const statuses = await window.electronAPI.mcp.getServerStatuses()
    const alreadyConnected = statuses.some(s => s.id === server.id && s.connected)
    if (alreadyConnected) {
      // 已连接时勿走 testConnection（会 disconnect）
      const all = await window.electronAPI.mcp.getAllTools()
      tools = all
        .filter(t => t.serverId === server.id)
        .map(t => ({
          name: t.name,
          description: (t.description || '').slice(0, 120)
        }))
    } else {
      const test = await window.electronAPI.mcp.testConnection(JSON.parse(JSON.stringify(server)))
      if (!test.success) {
        return { draft: '', toolsOk: false, error: test.error || t('mcpSettings.connectionFailed') }
      }
      tools = test.tools || []
    }
    const suggested = await window.electronAPI.mcp.suggestWhenToUse({
      name: server.name,
      tools
    })
    if (suggested.success && suggested.whenToUse) {
      return { draft: suggested.whenToUse, toolsOk: true }
    }
    return {
      draft: '',
      toolsOk: true,
      error: suggested.error || t('mcpSettings.whenToUseGenerateFailed')
    }
  } catch (e) {
    return {
      draft: '',
      toolsOk: false,
      error: e instanceof Error ? e.message : t('mcpSettings.whenToUseGenerateFailed')
    }
  } finally {
    whenToUseGenerating.value = false
  }
}

/** 表单内「自动生成」：写入 textarea，不弹确认、不落盘 */
const fillWhenToUseFromAi = async () => {
  if (!formData.value.name?.trim()) {
    testResult.value = { success: false, message: t('mcpSettings.pleaseInputServerName') }
    return
  }
  const server = buildServerFromForm()
  const { draft, error, toolsOk } = await generateWhenToUseDraft(server)
  if (draft) {
    formData.value.whenToUse = draft
    testResult.value = {
      success: true,
      message: t('mcpSettings.whenToUseGenerated')
    }
    return
  }
  testResult.value = {
    success: false,
    message: error || (toolsOk ? t('mcpSettings.whenToUseGenerateFailed') : t('mcpSettings.connectionFailed'))
  }
}

const persistServer = async (server: McpServerConfig) => {
  const plain = JSON.parse(JSON.stringify(server))
  if (editingServer.value) {
    await window.electronAPI.mcp.updateServer(plain)
  } else {
    await window.electronAPI.mcp.addServer(plain)
  }
  if (server.enabled) {
    try {
      await window.electronAPI.mcp.connect(plain)
    } catch {
      /* 连接失败不回滚配置；列表会显示原因和重试 */
    }
  }
  await loadServers()
}

const saveServer = async () => {
  if (!formData.value.name) return

  const server = buildServerFromForm()
  const needsWhenToUse = server.enabled && !(server.whenToUse || '').trim()

  if (needsWhenToUse) {
    const { draft, error, toolsOk } = await generateWhenToUseDraft(server)
    if (!toolsOk && !draft) {
      testResult.value = { success: false, message: error || t('mcpSettings.connectionFailed') }
      return
    }
    const confirmed = await promptWhenToUseConfirm(draft || formData.value.whenToUse || '', error || '')
    if (!confirmed) {
      return
    }
    server.whenToUse = confirmed
    formData.value.whenToUse = confirmed
  } else if (server.enabled && (server.whenToUse || '').trim()) {
    if (!editingServer.value) {
      const confirmed = await promptWhenToUseConfirm(server.whenToUse!)
      if (!confirmed) return
      server.whenToUse = confirmed
    }
  }

  await persistServer(server)
  showForm.value = false
  resetForm()
}

// 删除服务器
const deleteServer = async (server: McpServerConfig) => {
  const confirmed = await showConfirm({
    type: 'danger',
    title: t('common.delete'),
    message: t('mcpSettings.confirmDelete', { name: server.name }),
    confirmText: t('common.delete'),
  })
  if (confirmed) {
    await window.electronAPI.mcp.deleteServer(server.id)
    await loadServers()
  }
}

// 切换启用状态
const toggleEnabled = async (server: McpServerConfig) => {
  const nextEnabled = !server.enabled
  if (nextEnabled && !(server.whenToUse || '').trim()) {
    const { draft, error, toolsOk } = await generateWhenToUseDraft(server)
    if (!toolsOk && !draft) {
      await showAlert(t('common.error'), error || t('mcpSettings.connectionFailed'))
      return
    }
    const confirmed = await promptWhenToUseConfirm(draft, error || '')
    if (!confirmed) return
    const updated = JSON.parse(JSON.stringify({
      ...server,
      enabled: true,
      whenToUse: confirmed
    }))
    await window.electronAPI.mcp.updateServer(updated)
    try {
      await window.electronAPI.mcp.connect(updated)
    } catch { /* ignore */ }
    await loadServers()
    return
  }

  const updated = JSON.parse(JSON.stringify({ ...server, enabled: nextEnabled }))
  await window.electronAPI.mcp.updateServer(updated)

  if (!updated.enabled) {
    await window.electronAPI.mcp.disconnect(server.id)
  } else {
    try {
      await window.electronAPI.mcp.connect(updated)
    } catch { /* ignore */ }
  }

  await loadServers()
}

// 连接服务器
const retryConnect = async (server: McpServerConfig) => {
  connecting.value = server.id
  try {
    const plainServer = JSON.parse(JSON.stringify(server))
    const result = await window.electronAPI.mcp.connect(plainServer)
    if (!result.success) {
      /* 失败原因由 getServerStatuses.error 展示 */
    }
  } catch (error) {
    console.error('MCP retry failed:', error)
  } finally {
    connecting.value = null
    await refreshStatuses()
  }
}

// 查看服务器详情
const viewServerDetails = async (server: McpServerConfig) => {
  selectedServer.value = server
  
  // 获取工具/资源/提示
  const allTools = await window.electronAPI.mcp.getAllTools()
  const allResources = await window.electronAPI.mcp.getAllResources()
  const allPrompts = await window.electronAPI.mcp.getAllPrompts()
  
  serverTools.value = allTools.filter(t => t.serverId === server.id)
  serverResources.value = allResources.filter(r => r.serverId === server.id)
  serverPrompts.value = allPrompts.filter(p => p.serverId === server.id)
  
  showDetails.value = true
}

// 打开 JSON 导入弹窗
const openImport = () => {
  importText.value = ''
  importResult.value = null
  showImport.value = true
}

/**
 * 从 JSON 文本批量导入 MCP 服务器（兼容 Claude Desktop / Cursor 配置格式）
 * 接受 { mcpServers: {...} } 或直接的 {...} 映射
 */
const importFromJson = async () => {
  importResult.value = null
  let parsed: unknown
  try {
    parsed = JSON.parse(importText.value)
  } catch (err) {
    importResult.value = {
      success: false,
      message: t('mcpSettings.importJsonInvalid', { error: err instanceof Error ? err.message : 'parse error' })
    }
    return
  }

  // 同时兼容 { mcpServers: {...} } 和直接映射
  const root = parsed as { mcpServers?: Record<string, unknown> } & Record<string, unknown>
  const map = (root.mcpServers ?? root) as Record<string, unknown>
  if (!map || typeof map !== 'object') {
    importResult.value = { success: false, message: t('mcpSettings.importJsonInvalid', { error: 'no servers found' }) }
    return
  }

  const toAdd: McpServerConfig[] = []
  for (const [name, raw] of Object.entries(map)) {
    if (!raw || typeof raw !== 'object') continue
    const entry = raw as {
      command?: string
      args?: string[]
      env?: Record<string, string>
      cwd?: string
      url?: string
      headers?: Record<string, string>
      transport?: 'stdio' | 'sse' | 'http'
      type?: 'stdio' | 'sse' | 'http' | 'streamable-http' | 'streamableHttp'
    }

    // 推断传输方式：显式 transport/type 优先，否则按 url/command 推断
    let transport: 'stdio' | 'sse' | 'http'
    if (entry.transport) {
      transport = entry.transport
    } else if (entry.type === 'streamable-http' || entry.type === 'streamableHttp' || entry.type === 'http') {
      transport = 'http'
    } else if (entry.type === 'sse') {
      transport = 'sse'
    } else if (entry.type === 'stdio') {
      transport = 'stdio'
    } else if (entry.url) {
      // 没显式声明又有 url：默认按推荐的 Streamable HTTP 走
      transport = 'http'
    } else {
      transport = 'stdio'
    }

    toAdd.push({
      id: uuidv4(),
      name,
      // 无 whenToUse 时不能直接启用（须事后确认）；JSON 若带 whenToUse 则启用
      enabled: !!(entry as { whenToUse?: string }).whenToUse,
      transport,
      command: entry.command,
      args: entry.args,
      env: entry.env,
      cwd: entry.cwd,
      url: entry.url,
      headers: entry.headers,
      whenToUse: (entry as { whenToUse?: string }).whenToUse
    })
  }

  if (toAdd.length === 0) {
    importResult.value = { success: false, message: t('mcpSettings.importJsonInvalid', { error: 'empty mcpServers' }) }
    return
  }

  for (const server of toAdd) {
    await window.electronAPI.mcp.addServer(JSON.parse(JSON.stringify(server)))
  }
  await loadServers()
  importResult.value = { success: true, message: t('mcpSettings.importJsonSuccess', { count: toAdd.length }) }
  // 短暂展示成功后自动关闭
  setTimeout(() => { showImport.value = false }, 1200)
}

// 事件监听清理函数
let unsubConnected: (() => void) | null = null
let unsubDisconnected: (() => void) | null = null
let unsubError: (() => void) | null = null

onMounted(async () => {
  await loadServers()
  
  // 订阅 MCP 事件
  unsubConnected = window.electronAPI.mcp.onConnected(async () => {
    await refreshStatuses()
  })
  
  unsubDisconnected = window.electronAPI.mcp.onDisconnected(async () => {
    await refreshStatuses()
  })
  
  unsubError = window.electronAPI.mcp.onError(async (data) => {
    console.error('MCP Error:', data)
    await refreshStatuses()
  })
})

onUnmounted(() => {
  unsubConnected?.()
  unsubDisconnected?.()
  unsubError?.()
})
</script>

<template>
  <div class="mcp-settings">
    <div class="settings-section">
      <div class="section-header">
        <div class="header-left">
          <h4>{{ t('mcpSettings.title') }}</h4>
          <span class="connection-badge health-failed" v-if="failedCount > 0">
            {{ t('mcpSettings.healthFailed', { count: failedCount }) }}
          </span>
          <span class="connection-badge health-connecting" v-else-if="connectingCount > 0">
            {{ t('mcpSettings.healthConnecting') }}
          </span>
        </div>
        <div class="header-actions">
          <button class="btn btn-sm" @click="openImport" :title="t('mcpSettings.importJsonHint')">
            {{ t('mcpSettings.importJson') }}
          </button>
          <button class="btn btn-primary btn-sm" @click="openNewServer">
            <Plus :size="14" />
            {{ t('mcpSettings.addServer') }}
          </button>
        </div>
      </div>
      <p class="section-desc">
        {{ t('mcpSettings.description') }}
      </p>

      <!-- 服务器列表 -->
      <div class="server-list">
        <div
          v-for="server in servers"
          :key="server.id"
          class="server-item"
          :class="{ disabled: !server.enabled }"
        >
          <div class="server-toggle">
            <input
              type="checkbox"
              :checked="server.enabled"
              @change="toggleEnabled(server)"
              :title="t('mcpSettings.toggleEnable')"
            />
          </div>
          <div class="server-info" @click="server.enabled && viewServerDetails(server)">
            <div class="server-name">
              {{ server.name }}
            </div>
            <div class="server-detail">
              {{ server.transport === 'stdio' ? server.command : server.url }}
              <template v-if="getServerStatus(server.id)?.connected">
                · {{ t('mcpSettings.toolsCount', { count: getServerStatus(server.id)?.toolCount }) }}
              </template>
            </div>
            <div
              v-if="isUnhealthy(server)"
              class="server-health-error"
              :title="getServerStatus(server.id)?.error || t('mcpSettings.connectionFailed')"
            >
              {{ getServerStatus(server.id)?.error || t('mcpSettings.connectionFailed') }}
            </div>
            <div v-else-if="isConnecting(server)" class="server-connecting">
              {{ t('mcpSettings.connecting') }}
            </div>
            <div v-if="server.whenToUse" class="server-when-to-use" :title="server.whenToUse">
              {{ server.whenToUse }}
            </div>
            <div v-else-if="server.enabled" class="server-when-to-use missing">
              {{ t('mcpSettings.whenToUseMissing') }}
            </div>
          </div>
          <div class="server-actions">
            <button
              v-if="isUnhealthy(server)"
              class="btn btn-sm"
              @click="retryConnect(server)"
              :disabled="connecting === server.id"
            >
              <span v-if="connecting === server.id" class="spinner"></span>
              <span v-else>{{ t('mcpSettings.retry') }}</span>
            </button>
            <button class="btn-icon btn-sm" @click="openEditServer(server)" :title="t('common.edit')">
              <Pencil :size="14" />
            </button>
            <button class="btn-icon btn-sm" @click="deleteServer(server)" :title="t('common.delete')">
              <Trash2 :size="14" />
            </button>
          </div>
        </div>
        <div v-if="servers.length === 0" class="empty-servers">
          <p>{{ t('mcpSettings.noServers') }}</p>
          <p class="tip">{{ t('mcpSettings.addServer') }}</p>
        </div>
      </div>
    </div>

    <!-- 添加/编辑表单弹窗 -->
    <div v-if="showForm" class="details-modal" @click.self="showForm = false">
      <div class="details-content server-form-modal">
        <div class="form-header">
          <h4>{{ editingServer ? t('mcpSettings.editServer') : t('mcpSettings.addServer') }}</h4>
          <button class="btn-icon" @click="showForm = false" :title="t('common.close')">
            <X :size="16" />
          </button>
        </div>

      <!-- 快速模板 -->
      <div class="templates" v-if="!editingServer">
        <span class="template-label">{{ t('mcpSettings.quickFill') }}</span>
        <button
          v-for="template in templates"
          :key="template.name"
          class="template-btn"
          @click="applyTemplate(template)"
        >
          {{ template.name }}
        </button>
      </div>

      <div class="form-body">
        <div class="form-group">
          <label class="form-label">{{ t('mcpSettings.serverName') }} *</label>
          <input v-model="formData.name" type="text" class="input" :placeholder="t('mcpSettings.serverNamePlaceholder2')" />
        </div>

        <div class="form-group">
          <label class="form-label">{{ t('mcpSettings.transport') }}</label>
          <div class="transport-select">
            <label class="radio-item">
              <input type="radio" v-model="formData.transport" value="stdio" />
              <span>{{ t('mcpSettings.transportStdioLabel') }}</span>
            </label>
            <label class="radio-item">
              <input type="radio" v-model="formData.transport" value="http" />
              <span>{{ t('mcpSettings.transportHttpLabel') }}</span>
            </label>
            <label class="radio-item">
              <input type="radio" v-model="formData.transport" value="sse" />
              <span>{{ t('mcpSettings.transportSseLabel') }} <em class="deprecated-tag">{{ t('mcpSettings.deprecated') }}</em></span>
            </label>
          </div>
        </div>

        <template v-if="formData.transport === 'stdio'">
          <div class="form-group">
            <label class="form-label">{{ t('mcpSettings.command') }} *</label>
            <input v-model="formData.command" type="text" class="input" :placeholder="t('mcpSettings.commandPlaceholder2')" />
          </div>
          <div class="form-group">
            <label class="form-label">{{ t('mcpSettings.argsPerLine') }}</label>
            <textarea v-model="argsText" class="input textarea" placeholder="-y&#10;@modelcontextprotocol/server-filesystem&#10;/path/to/dir" rows="3"></textarea>
          </div>
          <div class="form-group">
            <label class="form-label">{{ t('mcpSettings.envPerLine') }}</label>
            <textarea v-model="envText" class="input textarea" placeholder="GITHUB_PERSONAL_ACCESS_TOKEN=ghp_xxxx&#10;API_KEY=sk-xxxx" rows="2"></textarea>
            <span class="form-hint">{{ t('mcpSettings.envHint') }}</span>
          </div>
          <div class="form-group">
            <label class="form-label">{{ t('mcpSettings.workingDir') }}</label>
            <input v-model="formData.cwd" type="text" class="input" :placeholder="t('mcpSettings.workingDirPlaceholder')" />
          </div>
        </template>

        <template v-else>
          <div class="form-group">
            <label class="form-label">
              {{ formData.transport === 'http' ? t('mcpSettings.httpUrl') : t('mcpSettings.sseUrl') }} *
            </label>
            <input
              v-model="formData.url"
              type="text"
              class="input"
              :placeholder="formData.transport === 'http' ? t('mcpSettings.httpUrlPlaceholder') : t('mcpSettings.urlPlaceholder')"
            />
          </div>
          <div class="form-group">
            <label class="form-label">{{ t('mcpSettings.headersPerLine') }}</label>
            <textarea
              v-model="headersText"
              class="input textarea"
              :placeholder="t('mcpSettings.headersPlaceholder')"
              rows="2"
            ></textarea>
            <span class="form-hint">{{ t('mcpSettings.headersHint') }}</span>
          </div>
        </template>

        <div class="form-group">
          <div class="form-label-row">
            <label class="form-label">{{ t('mcpSettings.whenToUse') }}</label>
            <button
              type="button"
              class="btn btn-sm"
              :disabled="whenToUseGenerating || testing || !formData.name"
              @click="fillWhenToUseFromAi"
            >
              {{ whenToUseGenerating ? t('mcpSettings.whenToUseGenerating') : t('mcpSettings.whenToUseGenerate') }}
            </button>
          </div>
          <textarea
            v-model="formData.whenToUse"
            class="input textarea"
            :placeholder="t('mcpSettings.whenToUsePlaceholder')"
            rows="2"
            maxlength="200"
          ></textarea>
          <span class="form-hint">{{ t('mcpSettings.whenToUseHint') }}</span>
        </div>

        <!-- 测试结果 -->
        <div v-if="testResult" class="test-result" :class="{ success: testResult.success, error: !testResult.success }">
          {{ testResult.message }}
        </div>
      </div>

      <div class="form-footer">
        <button class="btn" @click="testConnection" :disabled="testing || whenToUseGenerating">
          {{ testing ? t('mcpSettings.testing') : t('mcpSettings.testConnection') }}
        </button>
        <div class="form-footer-right">
          <button class="btn" @click="showForm = false">{{ t('common.cancel') }}</button>
          <button class="btn btn-primary" @click="saveServer" :disabled="whenToUseGenerating">
            {{ whenToUseGenerating ? t('mcpSettings.whenToUseGenerating') : t('common.save') }}
          </button>
        </div>
      </div>
      </div>
    </div>

    <!-- whenToUse 确认（不可跳过留空） -->
    <div v-if="showWhenToUseConfirm" class="details-modal" @click.self="cancelWhenToUse">
      <div class="details-content when-to-use-modal">
        <div class="details-header">
          <h4>{{ t('mcpSettings.whenToUseConfirmTitle') }}</h4>
        </div>
        <div class="details-body">
          <p class="form-hint">{{ t('mcpSettings.whenToUseConfirmHint') }}</p>
          <textarea
            v-model="whenToUseDraft"
            class="input textarea"
            rows="4"
            maxlength="200"
            :placeholder="t('mcpSettings.whenToUsePlaceholder')"
          ></textarea>
          <p v-if="whenToUseError" class="test-result error">{{ whenToUseError }}</p>
        </div>
        <div class="form-footer">
          <button class="btn" @click="cancelWhenToUse">{{ t('common.cancel') }}</button>
          <button class="btn btn-primary" @click="acceptWhenToUse">{{ t('mcpSettings.whenToUseAccept') }}</button>
        </div>
      </div>
    </div>

    <!-- 服务器详情弹窗 -->
    <div v-if="showDetails && selectedServer" key="mcp-details-modal" class="details-modal" @click.self="showDetails = false">
      <div class="details-content">
        <div class="details-header">
          <h4>{{ selectedServer.name }}</h4>
          <button class="btn-icon" @click="showDetails = false">
            <X :size="16" />
          </button>
        </div>
        <div class="details-body">
          <!-- 工具列表 -->
          <div class="details-section">
            <h5>{{ t('mcpSettings.tools') }} ({{ serverTools.length }})</h5>
            <div v-if="serverTools.length > 0" class="details-list">
              <div v-for="tool in serverTools" :key="tool.name" class="details-item">
                <div class="item-name">{{ tool.name }}</div>
                <div class="item-desc">{{ tool.description }}</div>
              </div>
            </div>
            <div v-else class="empty-list">{{ t('mcpSettings.noToolsAvailable') }}</div>
          </div>

          <!-- 资源列表 -->
          <div class="details-section">
            <h5>{{ t('mcpSettings.resources') }} ({{ serverResources.length }})</h5>
            <div v-if="serverResources.length > 0" class="details-list">
              <div v-for="resource in serverResources" :key="resource.uri" class="details-item">
                <div class="item-name">{{ resource.name }}</div>
                <div class="item-desc">{{ resource.uri }}</div>
              </div>
            </div>
            <div v-else class="empty-list">{{ t('mcpSettings.noResources') }}</div>
          </div>

          <!-- 提示模板列表 -->
          <div class="details-section">
            <h5>{{ t('mcpSettings.prompts') }} ({{ serverPrompts.length }})</h5>
            <div v-if="serverPrompts.length > 0" class="details-list">
              <div v-for="prompt in serverPrompts" :key="prompt.name" class="details-item">
                <div class="item-name">{{ prompt.name }}</div>
                <div class="item-desc">{{ prompt.description }}</div>
              </div>
            </div>
            <div v-else class="empty-list">{{ t('mcpSettings.noPrompts') }}</div>
          </div>
        </div>
      </div>
    </div>

    <!-- JSON 一键导入弹窗 -->
    <div v-if="showImport" key="mcp-import-modal" class="details-modal" @click.self="showImport = false">
      <div class="details-content import-modal">
        <div class="details-header">
          <h4>{{ t('mcpSettings.importJsonDialogTitle') }}</h4>
          <button class="btn-icon" @click="showImport = false">
            <X :size="16" />
          </button>
        </div>
        <div class="details-body">
          <p class="import-hint">{{ t('mcpSettings.importJsonHint') }}</p>
          <textarea
            v-model="importText"
            class="input textarea import-textarea"
            :placeholder="IMPORT_JSON_PLACEHOLDER"
            rows="14"
            spellcheck="false"
          ></textarea>
          <div v-if="importResult" class="test-result" :class="{ success: importResult.success, error: !importResult.success }">
            {{ importResult.message }}
          </div>
        </div>
        <div class="form-footer">
          <span class="form-hint">{{ t('mcpSettings.importJsonCompat') }}</span>
          <div class="form-footer-right">
            <button class="btn" @click="showImport = false">{{ t('common.cancel') }}</button>
            <button class="btn btn-primary" @click="importFromJson" :disabled="!importText.trim()">
              {{ t('mcpSettings.importJsonAction') }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.mcp-settings {
  display: flex;
  flex-direction: column;
  gap: 20px;
}


.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 28px;
  margin-bottom: 8px;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 12px;
}

.section-header h4 {
  font-size: 14px;
  font-weight: 600;
}

.connection-badge {
  font-size: 11px;
  padding: 2px 8px;
  background: var(--accent-green);
  color: var(--bg-primary);
  border-radius: 10px;
}

.connection-badge.health-failed {
  background: var(--accent-red, #e74c3c);
  color: #fff;
}

.connection-badge.health-connecting {
  background: var(--bg-tertiary);
  color: var(--accent-primary);
}

.server-health-error {
  margin-top: 4px;
  font-size: 11px;
  line-height: 1.4;
  color: var(--accent-red, #e74c3c);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.server-connecting {
  margin-top: 4px;
  font-size: 11px;
  color: var(--accent-primary);
}

.header-actions {
  display: flex;
  gap: 8px;
}

.section-desc {
  font-size: 12px;
  color: var(--text-muted);
  margin-bottom: 16px;
  line-height: 1.5;
}

/* 服务器列表 */
.server-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.server-item {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 12px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  transition: all 0.2s ease;
}

.server-toggle {
  padding-top: 2px;
}

.server-actions {
  display: flex;
  gap: 4px;
  padding-top: 2px;
}

.server-item:hover {
  border-color: var(--accent-primary);
}

.server-item.disabled {
  opacity: 0.5;
}

.server-toggle input {
  width: 16px;
  height: 16px;
  cursor: pointer;
}

.server-info {
  flex: 1;
  min-width: 0;
  cursor: pointer;
}

.server-name {
  font-size: 14px;
  font-weight: 500;
  color: var(--text-primary);
  display: flex;
  align-items: center;
  gap: 8px;
}

.server-status {
  font-size: 11px;
  color: var(--accent-green);
}

.server-detail {
  font-size: 11px;
  color: var(--text-muted);
  font-family: var(--font-mono);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.server-when-to-use {
  margin-top: 4px;
  font-size: 12px;
  line-height: 1.4;
  color: var(--text-secondary);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.server-when-to-use.missing {
  color: var(--accent-warning, var(--text-muted));
  font-style: italic;
}

.empty-servers {
  padding: 30px 20px;
  text-align: center;
  color: var(--text-muted);
}

.empty-servers .tip {
  font-size: 12px;
  margin-top: 8px;
}

/* 添加/编辑弹窗：盖过 .details-content 的 70vh，主体滚动、页脚固定 */
.details-content.server-form-modal {
  width: 560px;
  max-height: 85vh;
}

.server-form-modal .form-header,
.server-form-modal .templates,
.server-form-modal .form-footer {
  flex-shrink: 0;
}

.server-form-modal .form-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}

.form-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  background: var(--bg-surface);
  border-bottom: 1px solid var(--border-color);
}

.form-header h4 {
  font-size: 16px;
  font-weight: 600;
  margin: 0;
}

.templates {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border-color);
  flex-wrap: wrap;
}

.template-label {
  font-size: 12px;
  color: var(--text-muted);
}

.template-btn {
  padding: 4px 10px;
  font-size: 12px;
  color: var(--text-primary);
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 12px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.template-btn:hover {
  background: var(--bg-hover);
}

.form-body {
  padding: 16px;
}

.form-group {
  margin-bottom: 16px;
}

.form-label {
  display: block;
  font-size: 12px;
  font-weight: 500;
  color: var(--text-primary);
  margin-bottom: 6px;
}

.form-label-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
}

.form-label-row .form-label {
  margin-bottom: 0;
}

.input {
  width: 100%;
  padding: 8px 12px;
  font-size: 13px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  color: var(--text-primary);
}

.input:focus {
  outline: none;
  border-color: var(--accent-primary);
}

.textarea {
  font-family: var(--font-mono);
  resize: vertical;
  min-height: 60px;
}

.transport-select {
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
}

.radio-item {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  cursor: pointer;
}

.radio-item input {
  cursor: pointer;
}

.test-result {
  margin-top: 12px;
  padding: 10px 12px;
  border-radius: 6px;
  font-size: 12px;
}

.test-result.success {
  background: rgba(166, 227, 161, 0.1);
  color: var(--accent-green);
  border: 1px solid var(--accent-green);
}

.test-result.error {
  background: rgba(243, 139, 168, 0.1);
  color: var(--accent-red);
  border: 1px solid var(--accent-red);
}

.form-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  border-top: 1px solid var(--border-color);
}

.form-footer-right {
  display: flex;
  gap: 8px;
}

/* 详情弹窗 */
.details-modal {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1100;
}

.details-content {
  width: 500px;
  max-width: 90vw;
  max-height: 70vh;
  background: var(--bg-secondary);
  border-radius: 12px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.details-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px;
  border-bottom: 1px solid var(--border-color);
}

.details-header h4 {
  font-size: 16px;
  font-weight: 600;
}

.details-body {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
}

.details-section {
  margin-bottom: 20px;
}

.details-section:last-child {
  margin-bottom: 0;
}

.details-section h5 {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-secondary);
  margin-bottom: 8px;
}

.details-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.details-item {
  padding: 10px 12px;
  background: var(--bg-tertiary);
  border-radius: 6px;
}

.item-name {
  font-size: 13px;
  font-weight: 500;
  font-family: var(--font-mono);
  color: var(--accent-primary);
}

.item-desc {
  font-size: 12px;
  color: var(--text-muted);
  margin-top: 4px;
}

.empty-list {
  font-size: 12px;
  color: var(--text-muted);
  padding: 12px;
  text-align: center;
  background: var(--bg-tertiary);
  border-radius: 6px;
}

/* 已弃用标签 */
.deprecated-tag {
  font-style: normal;
  font-size: 10px;
  margin-left: 4px;
  padding: 1px 6px;
  color: var(--text-muted);
  background: var(--bg-tertiary);
  border-radius: 8px;
  border: 1px solid var(--border-color);
}

/* JSON 导入弹窗 */
.import-modal {
  width: 640px;
}

.import-hint {
  font-size: 12px;
  color: var(--text-muted);
  margin-bottom: 8px;
  line-height: 1.5;
}

.import-textarea {
  font-family: var(--font-mono);
  font-size: 12px;
  min-height: 240px;
}

.form-hint {
  display: inline-block;
  font-size: 11px;
  color: var(--text-muted);
  margin-top: 4px;
}

/* 加载动画 */
.spinner {
  width: 14px;
  height: 14px;
  border: 2px solid var(--border-color);
  border-top-color: var(--accent-primary);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}
</style>
