import { contextBridge, ipcRenderer } from 'electron'

// 类型定义
export interface PtyOptions {
  cols?: number
  rows?: number
  cwd?: string
  shell?: string
  env?: Record<string, string>
}

export interface SshConfig {
  host: string
  port: number
  username: string
  password?: string
  privateKey?: string
  passphrase?: string
  cols?: number
  rows?: number
}

export interface AiMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface AiProfile {
  id: string
  name: string
  apiUrl: string
  apiKey: string
  model: string
  proxy?: string
}

export interface SshSession {
  id: string
  name: string
  host: string
  port: number
  username: string
  authType: 'password' | 'privateKey'
  password?: string
  privateKeyPath?: string
  passphrase?: string
  group?: string
}

export interface XshellSession {
  name: string
  host: string
  port: number
  username: string
  password?: string
  privateKeyPath?: string
  group?: string
}

export interface ImportResult {
  success: boolean
  sessions: XshellSession[]
  errors: string[]
}

// Agent 相关类型
export type RiskLevel = 'safe' | 'moderate' | 'dangerous' | 'blocked'

export interface AgentStep {
  id: string
  type: 'thinking' | 'tool_call' | 'tool_result' | 'message' | 'error' | 'confirm'
  content: string
  toolName?: string
  toolArgs?: Record<string, unknown>
  toolResult?: string
  riskLevel?: RiskLevel
  timestamp: number
}

export interface AgentContext {
  ptyId: string
  terminalOutput: string[]
  systemInfo: {
    os: string
    shell: string
  }
  historyMessages?: { role: string; content: string }[]
}

export interface AgentConfig {
  enabled?: boolean
  maxSteps?: number
  commandTimeout?: number
  autoExecuteSafe?: boolean
  autoExecuteModerate?: boolean
  strictMode?: boolean           // 严格模式：所有命令都需确认，在终端执行
}

export interface PendingConfirmation {
  agentId: string
  toolCallId: string
  toolName: string
  toolArgs: Record<string, unknown>
  riskLevel: RiskLevel
}

// 暴露给渲染进程的 API
const electronAPI = {
  // PTY 操作
  pty: {
    create: (options: PtyOptions) => ipcRenderer.invoke('pty:create', options),
    write: (id: string, data: string) => ipcRenderer.invoke('pty:write', id, data),
    resize: (id: string, cols: number, rows: number) =>
      ipcRenderer.invoke('pty:resize', id, cols, rows),
    dispose: (id: string) => ipcRenderer.invoke('pty:dispose', id),
    executeInTerminal: (id: string, command: string, timeout?: number) =>
      ipcRenderer.invoke('pty:executeInTerminal', id, command, timeout) as Promise<{
        success: boolean
        output?: string
        exitCode?: number
        error?: string
      }>,
    onData: (id: string, callback: (data: string) => void) => {
      ipcRenderer.send('pty:subscribe', id)
      const handler = (_event: Electron.IpcRendererEvent, data: string) => callback(data)
      ipcRenderer.on(`pty:data:${id}`, handler)
      return () => {
        ipcRenderer.removeListener(`pty:data:${id}`, handler)
      }
    }
  },

  // SSH 操作
  ssh: {
    connect: (config: SshConfig) => ipcRenderer.invoke('ssh:connect', config),
    write: (id: string, data: string) => ipcRenderer.invoke('ssh:write', id, data),
    resize: (id: string, cols: number, rows: number) =>
      ipcRenderer.invoke('ssh:resize', id, cols, rows),
    disconnect: (id: string) => ipcRenderer.invoke('ssh:disconnect', id),
    onData: (id: string, callback: (data: string) => void) => {
      ipcRenderer.send('ssh:subscribe', id)
      const handler = (_event: Electron.IpcRendererEvent, data: string) => callback(data)
      ipcRenderer.on(`ssh:data:${id}`, handler)
      return () => {
        ipcRenderer.removeListener(`ssh:data:${id}`, handler)
      }
    }
  },

  // AI 操作
  ai: {
    chat: (messages: AiMessage[], profileId?: string) =>
      ipcRenderer.invoke('ai:chat', messages, profileId),
    chatStream: (
      messages: AiMessage[],
      onChunk: (chunk: string) => void,
      onDone: () => void,
      onError: (error: string) => void,
      profileId?: string,
      requestId?: string  // 支持传入请求 ID，用于支持多个终端同时请求
    ) => {
      ipcRenderer.invoke('ai:chatStream', messages, profileId, requestId).then((streamId: string) => {
        const handler = (
          _event: Electron.IpcRendererEvent,
          data: { chunk?: string; done?: boolean; error?: string }
        ) => {
          if (data.chunk) {
            onChunk(data.chunk)
          }
          if (data.done) {
            onDone()
            ipcRenderer.removeListener(`ai:stream:${streamId}`, handler)
          }
          if (data.error) {
            onError(data.error)
            ipcRenderer.removeListener(`ai:stream:${streamId}`, handler)
          }
        }
        ipcRenderer.on(`ai:stream:${streamId}`, handler)
      })
    },
    abort: (requestId?: string) => ipcRenderer.invoke('ai:abort', requestId)
  },

  // 配置操作
  config: {
    get: (key: string) => ipcRenderer.invoke('config:get', key),
    set: (key: string, value: unknown) => ipcRenderer.invoke('config:set', key, value),
    getAll: () => ipcRenderer.invoke('config:getAll'),

    // AI 配置
    getAiProfiles: () => ipcRenderer.invoke('config:getAiProfiles'),
    setAiProfiles: (profiles: AiProfile[]) =>
      ipcRenderer.invoke('config:setAiProfiles', profiles),
    getActiveAiProfile: () => ipcRenderer.invoke('config:getActiveAiProfile'),
    setActiveAiProfile: (profileId: string) =>
      ipcRenderer.invoke('config:setActiveAiProfile', profileId),

    // SSH 会话
    getSshSessions: () => ipcRenderer.invoke('config:getSshSessions'),
    setSshSessions: (sessions: SshSession[]) =>
      ipcRenderer.invoke('config:setSshSessions', sessions),

    // 主题
    getTheme: () => ipcRenderer.invoke('config:getTheme'),
    setTheme: (theme: string) => ipcRenderer.invoke('config:setTheme', theme)
  },

  // Xshell 导入操作
  xshell: {
    selectFiles: () => ipcRenderer.invoke('xshell:selectFiles') as Promise<{ canceled: boolean; filePaths: string[] }>,
    selectDirectory: () => ipcRenderer.invoke('xshell:selectDirectory') as Promise<{ canceled: boolean; dirPath: string }>,
    importFiles: (filePaths: string[]) => ipcRenderer.invoke('xshell:importFiles', filePaths) as Promise<ImportResult>,
    importDirectory: (dirPath: string) => ipcRenderer.invoke('xshell:importDirectory', dirPath) as Promise<ImportResult>
  },

  // Agent 操作
  agent: {
    // 运行 Agent
    run: (
      ptyId: string,
      message: string,
      context: AgentContext,
      config?: AgentConfig,
      profileId?: string
    ) => ipcRenderer.invoke('agent:run', { ptyId, message, context, config, profileId }) as Promise<{ success: boolean; result?: string; error?: string }>,

    // 中止 Agent
    abort: (agentId: string) => ipcRenderer.invoke('agent:abort', agentId) as Promise<boolean>,

    // 确认工具调用
    confirm: (
      agentId: string,
      toolCallId: string,
      approved: boolean,
      modifiedArgs?: Record<string, unknown>
    ) => ipcRenderer.invoke('agent:confirm', { agentId, toolCallId, approved, modifiedArgs }) as Promise<boolean>,

    // 获取 Agent 状态
    getStatus: (agentId: string) => ipcRenderer.invoke('agent:getStatus', agentId),

    // 清理 Agent 运行记录
    cleanup: (agentId: string) => ipcRenderer.invoke('agent:cleanup', agentId),

    // 更新 Agent 配置（如严格模式）
    updateConfig: (agentId: string, config: { strictMode?: boolean; commandTimeout?: number }) =>
      ipcRenderer.invoke('agent:updateConfig', agentId, config) as Promise<boolean>,

    // 监听 Agent 步骤更新
    onStep: (callback: (data: { agentId: string; step: AgentStep }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { agentId: string; step: AgentStep }) => callback(data)
      ipcRenderer.on('agent:step', handler)
      return () => {
        ipcRenderer.removeListener('agent:step', handler)
      }
    },

    // 监听需要确认的工具调用
    onNeedConfirm: (callback: (data: PendingConfirmation) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: PendingConfirmation) => callback(data)
      ipcRenderer.on('agent:needConfirm', handler)
      return () => {
        ipcRenderer.removeListener('agent:needConfirm', handler)
      }
    },

    // 监听 Agent 完成
    onComplete: (callback: (data: { agentId: string; result: string }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { agentId: string; result: string }) => callback(data)
      ipcRenderer.on('agent:complete', handler)
      return () => {
        ipcRenderer.removeListener('agent:complete', handler)
      }
    },

    // 监听 Agent 错误
    onError: (callback: (data: { agentId: string; error: string }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { agentId: string; error: string }) => callback(data)
      ipcRenderer.on('agent:error', handler)
      return () => {
        ipcRenderer.removeListener('agent:error', handler)
      }
    }
  },

  // 历史记录操作
  history: {
    // 保存聊天记录
    saveChatRecord: (record: {
      id: string
      timestamp: number
      terminalId: string
      terminalType: 'local' | 'ssh'
      sshHost?: string
      role: 'user' | 'assistant'
      content: string
    }) => ipcRenderer.invoke('history:saveChatRecord', record),

    // 批量保存聊天记录
    saveChatRecords: (records: Array<{
      id: string
      timestamp: number
      terminalId: string
      terminalType: 'local' | 'ssh'
      sshHost?: string
      role: 'user' | 'assistant'
      content: string
    }>) => ipcRenderer.invoke('history:saveChatRecords', records),

    // 获取聊天记录
    getChatRecords: (startDate?: string, endDate?: string) => 
      ipcRenderer.invoke('history:getChatRecords', startDate, endDate),

    // 保存 Agent 记录
    saveAgentRecord: (record: {
      id: string
      timestamp: number
      terminalId: string
      terminalType: 'local' | 'ssh'
      sshHost?: string
      userTask: string
      steps: Array<{
        id: string
        type: string
        content: string
        toolName?: string
        toolArgs?: Record<string, unknown>
        toolResult?: string
        riskLevel?: string
        timestamp: number
      }>
      finalResult?: string
      duration: number
      status: 'completed' | 'failed' | 'aborted'
    }) => ipcRenderer.invoke('history:saveAgentRecord', record),

    // 获取 Agent 记录
    getAgentRecords: (startDate?: string, endDate?: string) => 
      ipcRenderer.invoke('history:getAgentRecords', startDate, endDate),

    // 获取数据目录路径
    getDataPath: () => ipcRenderer.invoke('history:getDataPath') as Promise<string>,

    // 获取存储统计
    getStorageStats: () => ipcRenderer.invoke('history:getStorageStats') as Promise<{
      chatFiles: number
      agentFiles: number
      totalSize: number
      oldestRecord?: string
      newestRecord?: string
    }>,

    // 导出数据
    exportData: () => ipcRenderer.invoke('history:exportData'),

    // 导入数据
    importData: (data: object) => ipcRenderer.invoke('history:importData', data) as Promise<{
      success: boolean
      error?: string
      configIncluded?: boolean
    }>,

    // 清理旧记录
    cleanup: (daysToKeep: number) => ipcRenderer.invoke('history:cleanup', daysToKeep) as Promise<{
      chatDeleted: number
      agentDeleted: number
    }>,

    // 导出到文件夹
    exportToFolder: (options?: { includeSshPasswords?: boolean; includeApiKeys?: boolean }) => 
      ipcRenderer.invoke('history:exportToFolder', options) as Promise<{
        success: boolean
        canceled?: boolean
        files?: string[]
        error?: string
      }>,

    // 从文件夹导入
    importFromFolder: () => ipcRenderer.invoke('history:importFromFolder') as Promise<{
      success: boolean
      canceled?: boolean
      imported?: string[]
      error?: string
    }>,

    // 在文件管理器中打开数据目录
    openDataFolder: () => ipcRenderer.invoke('history:openDataFolder')
  },

  // 主机档案操作
  hostProfile: {
    // 获取主机档案
    get: (hostId: string) => ipcRenderer.invoke('hostProfile:get', hostId) as Promise<{
      hostId: string
      hostname: string
      username: string
      os: string
      osVersion: string
      shell: string
      packageManager?: string
      installedTools: string[]
      homeDir?: string
      currentDir?: string
      notes: string[]
      lastProbed: number
      lastUpdated: number
    } | null>,

    // 获取所有主机档案
    getAll: () => ipcRenderer.invoke('hostProfile:getAll'),

    // 更新主机档案
    update: (hostId: string, updates: object) => ipcRenderer.invoke('hostProfile:update', hostId, updates),

    // 添加笔记
    addNote: (hostId: string, note: string) => ipcRenderer.invoke('hostProfile:addNote', hostId, note),

    // 删除主机档案
    delete: (hostId: string) => ipcRenderer.invoke('hostProfile:delete', hostId),

    // 获取探测命令
    getProbeCommands: (os: string) => ipcRenderer.invoke('hostProfile:getProbeCommands', os) as Promise<string[]>,

    // 解析探测结果
    parseProbeOutput: (output: string, hostId?: string) => ipcRenderer.invoke('hostProfile:parseProbeOutput', output, hostId),

    // 生成主机 ID
    generateHostId: (type: 'local' | 'ssh', sshHost?: string, sshUser?: string) => 
      ipcRenderer.invoke('hostProfile:generateHostId', type, sshHost, sshUser) as Promise<string>,

    // 检查是否需要探测
    needsProbe: (hostId: string) => ipcRenderer.invoke('hostProfile:needsProbe', hostId) as Promise<boolean>,

    // 后台探测本地主机（不在终端显示）
    probeLocal: () => ipcRenderer.invoke('hostProfile:probeLocal') as Promise<{
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
    }>,

    // 生成主机上下文
    generateContext: (hostId: string) => ipcRenderer.invoke('hostProfile:generateContext', hostId) as Promise<string>,
    
    // SSH 主机探测
    probeSsh: (sshId: string, hostId: string) => ipcRenderer.invoke('hostProfile:probeSsh', sshId, hostId) as Promise<{
      hostId: string
      hostname: string
      username: string
      os: string
      osVersion: string
      shell: string
      packageManager?: string
      installedTools: string[]
      homeDir?: string
      currentDir?: string
      notes: string[]
      lastProbed: number
      lastUpdated: number
    } | null>
  }
}

// 暴露到 window.electronAPI
contextBridge.exposeInMainWorld('electronAPI', electronAPI)

// 类型声明
declare global {
  interface Window {
    electronAPI: typeof electronAPI
  }
}

