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

// 暴露给渲染进程的 API
const electronAPI = {
  // PTY 操作
  pty: {
    create: (options: PtyOptions) => ipcRenderer.invoke('pty:create', options),
    write: (id: string, data: string) => ipcRenderer.invoke('pty:write', id, data),
    resize: (id: string, cols: number, rows: number) =>
      ipcRenderer.invoke('pty:resize', id, cols, rows),
    dispose: (id: string) => ipcRenderer.invoke('pty:dispose', id),
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
      profileId?: string
    ) => {
      ipcRenderer.invoke('ai:chatStream', messages, profileId).then((streamId: string) => {
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
    abort: () => ipcRenderer.invoke('ai:abort')
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

