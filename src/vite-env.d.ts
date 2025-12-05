/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<object, object, unknown>
  export default component
}

// Agent 相关类型
type RiskLevel = 'safe' | 'moderate' | 'dangerous' | 'blocked'

interface AgentStep {
  id: string
  type: 'thinking' | 'tool_call' | 'tool_result' | 'message' | 'error' | 'confirm' | 'user_task' | 'final_result'
  content: string
  toolName?: string
  toolArgs?: Record<string, unknown>
  toolResult?: string
  riskLevel?: RiskLevel
  timestamp: number
}

interface PendingConfirmation {
  agentId: string
  toolCallId: string
  toolName: string
  toolArgs: Record<string, unknown>
  riskLevel: RiskLevel
}

interface HostProfile {
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
}

// Electron API 类型
interface Window {
  electronAPI: {
    pty: {
      create: (options?: {
        cols?: number
        rows?: number
        cwd?: string
        shell?: string
        env?: Record<string, string>
      }) => Promise<string>
      write: (id: string, data: string) => Promise<void>
      resize: (id: string, cols: number, rows: number) => Promise<void>
      dispose: (id: string) => Promise<void>
      executeInTerminal: (id: string, command: string, timeout?: number) => Promise<{
        success: boolean
        output?: string
        exitCode?: number
        error?: string
      }>
      onData: (id: string, callback: (data: string) => void) => () => void
    }
    ssh: {
      connect: (config: {
        host: string
        port: number
        username: string
        password?: string
        privateKey?: string
        passphrase?: string
        cols?: number
        rows?: number
      }) => Promise<string>
      write: (id: string, data: string) => Promise<void>
      resize: (id: string, cols: number, rows: number) => Promise<void>
      disconnect: (id: string) => Promise<void>
      onData: (id: string, callback: (data: string) => void) => () => void
    }
    ai: {
      chat: (
        messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
        profileId?: string
      ) => Promise<string>
      chatStream: (
        messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
        onChunk: (chunk: string) => void,
        onDone: () => void,
        onError: (error: string) => void,
        profileId?: string,
        requestId?: string
      ) => void
      abort: (requestId?: string) => Promise<void>
    }
    config: {
      get: (key: string) => Promise<unknown>
      set: (key: string, value: unknown) => Promise<void>
      getAll: () => Promise<Record<string, unknown>>
      getAiProfiles: () => Promise<
        Array<{
          id: string
          name: string
          apiUrl: string
          apiKey: string
          model: string
          proxy?: string
        }>
      >
      setAiProfiles: (
        profiles: Array<{
          id: string
          name: string
          apiUrl: string
          apiKey: string
          model: string
          proxy?: string
        }>
      ) => Promise<void>
      getActiveAiProfile: () => Promise<string>
      setActiveAiProfile: (profileId: string) => Promise<void>
      getSshSessions: () => Promise<
        Array<{
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
        }>
      >
      setSshSessions: (
        sessions: Array<{
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
        }>
      ) => Promise<void>
      getTheme: () => Promise<string>
      setTheme: (theme: string) => Promise<void>
    }
    xshell: {
      selectFiles: () => Promise<{ canceled: boolean; filePaths: string[] }>
      selectDirectory: () => Promise<{ canceled: boolean; dirPath: string }>
      importFiles: (filePaths: string[]) => Promise<{
        success: boolean
        sessions: Array<{
          name: string
          host: string
          port: number
          username: string
          password?: string
          privateKeyPath?: string
          group?: string
        }>
        errors: string[]
      }>
      importDirectory: (dirPath: string) => Promise<{
        success: boolean
        sessions: Array<{
          name: string
          host: string
          port: number
          username: string
          password?: string
          privateKeyPath?: string
          group?: string
        }>
        errors: string[]
      }>
    }
    // Agent 操作
    agent: {
      run: (
        ptyId: string,
        message: string,
        context: {
          ptyId: string
          terminalOutput: string[]
          systemInfo: { os: string; shell: string }
          hostId?: string
          historyMessages?: { role: string; content: string }[]
        },
        config?: {
          enabled?: boolean
          maxSteps?: number
          commandTimeout?: number
          autoExecuteSafe?: boolean
          autoExecuteModerate?: boolean
          strictMode?: boolean
        },
        profileId?: string
      ) => Promise<{ success: boolean; result?: string; error?: string }>
      abort: (agentId: string) => Promise<boolean>
      confirm: (
        agentId: string,
        toolCallId: string,
        approved: boolean,
        modifiedArgs?: Record<string, unknown>
      ) => Promise<boolean>
      getStatus: (agentId: string) => Promise<unknown>
      cleanup: (agentId: string) => Promise<void>
      updateConfig: (agentId: string, config: { strictMode?: boolean; commandTimeout?: number }) => Promise<boolean>
      onStep: (callback: (data: { agentId: string; step: AgentStep }) => void) => () => void
      onNeedConfirm: (callback: (data: PendingConfirmation) => void) => () => void
      onComplete: (callback: (data: { agentId: string; result: string }) => void) => () => void
      onError: (callback: (data: { agentId: string; error: string }) => void) => () => void
    }
    // 历史记录操作
    history: {
      saveChatRecord: (record: {
        id: string
        timestamp: number
        terminalId: string
        terminalType: 'local' | 'ssh'
        sshHost?: string
        role: 'user' | 'assistant'
        content: string
      }) => Promise<void>
      saveChatRecords: (records: Array<{
        id: string
        timestamp: number
        terminalId: string
        terminalType: 'local' | 'ssh'
        sshHost?: string
        role: 'user' | 'assistant'
        content: string
      }>) => Promise<void>
      getChatRecords: (startDate?: string, endDate?: string) => Promise<Array<{
        id: string
        timestamp: number
        terminalId: string
        terminalType: 'local' | 'ssh'
        sshHost?: string
        role: 'user' | 'assistant'
        content: string
      }>>
      saveAgentRecord: (record: {
        id: string
        timestamp: number
        terminalId: string
        terminalType: 'local' | 'ssh'
        sshHost?: string
        userTask: string
        steps: AgentStep[]
        finalResult?: string
        status: 'completed' | 'failed' | 'aborted'
        duration: number
      }) => Promise<void>
      getAgentRecords: (startDate?: string, endDate?: string) => Promise<Array<{
        id: string
        timestamp: number
        terminalId: string
        terminalType: 'local' | 'ssh'
        sshHost?: string
        userTask: string
        steps: AgentStep[]
        finalResult: string
        status: 'completed' | 'failed' | 'aborted'
        duration: number
      }>>
      getStorageStats: () => Promise<{
        chatFiles: number
        agentFiles: number
        totalSize: number
        oldestRecord?: string
        newestRecord?: string
      }>
      getDataPath: () => Promise<string>
      openDataFolder: () => Promise<void>
      exportToFolder: (options: {
        includeSshPasswords: boolean
        includeApiKeys: boolean
      }) => Promise<{ success: boolean; canceled?: boolean; files?: string[]; path?: string; error?: string }>
      exportData: () => Promise<{
        version: string
        exportTime: number
        config: Record<string, unknown>
        history: {
          chat: Array<unknown>
          agent: Array<unknown>
        }
      }>
      importFromFolder: () => Promise<{ success: boolean; canceled?: boolean; imported?: string[]; error?: string }>
      importData: (data: {
        version: string
        exportTime: number
        config: Record<string, unknown>
        history: {
          chat: Array<unknown>
          agent: Array<unknown>
        }
        hostProfiles?: unknown[]
      }) => Promise<{ success: boolean; imported?: { chat: number; agent: number; config: boolean }; error?: string }>
      cleanup: (days: number) => Promise<{ success: boolean; chatDeleted?: number; agentDeleted?: number; error?: string }>
    }
    // 主机档案操作
    hostProfile: {
      get: (hostId: string) => Promise<HostProfile | null>
      getAll: () => Promise<HostProfile[]>
      update: (hostId: string, updates: Partial<HostProfile>) => Promise<HostProfile>
      addNote: (hostId: string, note: string) => Promise<void>
      delete: (hostId: string) => Promise<void>
      getProbeCommands: (os: string) => Promise<string[]>
      parseProbeOutput: (output: string, hostId?: string) => Promise<{
        hostname?: string
        username?: string
        os?: string
        osVersion?: string
        shell?: string
        packageManager?: string
        installedTools?: string[]
        homeDir?: string
        currentDir?: string
      }>
      generateHostId: (type: 'local' | 'ssh', sshHost?: string, sshUser?: string) => Promise<string>
      needsProbe: (hostId: string) => Promise<boolean>
      probeLocal: () => Promise<HostProfile>
      probeSsh: (sshId: string, hostId: string) => Promise<HostProfile | null>
      generateContext: (hostId: string) => Promise<string>
    }
  }
}
