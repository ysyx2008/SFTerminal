import { app, BrowserWindow, ipcMain, shell, Menu, dialog } from 'electron'
import path, { join } from 'path'
import { PtyService } from './services/pty.service'
import { SshService } from './services/ssh.service'
import { AiService } from './services/ai.service'
import { ConfigService } from './services/config.service'
import { XshellImportService } from './services/xshell-import.service'
import { AgentService, AgentStep, PendingConfirmation, AgentContext } from './services/agent.service'
import { HistoryService, ChatRecord, AgentRecord } from './services/history.service'
import { HostProfileService, HostProfile } from './services/host-profile.service'

// 禁用 GPU 加速可能导致的问题（可选）
// app.disableHardwareAcceleration()

// 捕获未处理的异常，防止 EPIPE 等错误导致崩溃
process.on('uncaughtException', (error) => {
  // 忽略 EPIPE 错误（管道关闭时的正常错误）
  if (error.message?.includes('EPIPE') || error.message?.includes('read EPIPE')) {
    return
  }
  console.error('Uncaught exception:', error)
})

process.on('unhandledRejection', (reason) => {
  // 忽略 EPIPE 相关的 Promise 拒绝
  if (String(reason).includes('EPIPE')) {
    return
  }
  console.error('Unhandled rejection:', reason)
})

let mainWindow: BrowserWindow | null = null

// 服务实例
const ptyService = new PtyService()
const sshService = new SshService()
const aiService = new AiService()
const configService = new ConfigService()
const xshellImportService = new XshellImportService()
const hostProfileService = new HostProfileService()
const agentService = new AgentService(aiService, ptyService, hostProfileService)
const historyService = new HistoryService()

function createWindow() {
  // 根据平台选择图标
  const iconPath = process.platform === 'darwin'
    ? join(__dirname, '../resources/icon.icns')
    : process.platform === 'win32'
      ? join(__dirname, '../resources/icon.ico')
      : join(__dirname, '../resources/icon.png')

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: '旗鱼终端',
    icon: iconPath,
    frame: true,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  // 开发环境加载本地服务器
  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
    mainWindow.webContents.openDevTools()
  } else {
    // 生产环境加载打包后的文件
    mainWindow.loadFile(join(__dirname, '../dist/index.html'))
  }

  // 在浏览器中打开外部链接
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

// 应用准备就绪
app.whenReady().then(() => {
  // 移除默认菜单栏
  Menu.setApplicationMenu(null)
  
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

// 所有窗口关闭时退出应用（Windows & Linux）
app.on('window-all-closed', () => {
  // 清理所有 PTY 和 SSH 连接
  ptyService.disposeAll()
  sshService.disposeAll()

  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// ==================== IPC 处理器 ====================

// PTY 相关
ipcMain.handle('pty:create', async (_event, options) => {
  return ptyService.create(options)
})

ipcMain.handle('pty:write', async (_event, id: string, data: string) => {
  ptyService.write(id, data)
})

ipcMain.handle('pty:resize', async (_event, id: string, cols: number, rows: number) => {
  ptyService.resize(id, cols, rows)
})

ipcMain.handle('pty:executeInTerminal', async (_event, id: string, command: string, timeout?: number) => {
  return ptyService.executeInTerminal(id, command, timeout)
})

ipcMain.handle('pty:dispose', async (_event, id: string) => {
  ptyService.dispose(id)
})

// PTY 数据输出 - 转发到渲染进程
ipcMain.on('pty:subscribe', (event, id: string) => {
  ptyService.onData(id, (data: string) => {
    try {
      if (!event.sender.isDestroyed()) {
        event.sender.send(`pty:data:${id}`, data)
      }
    } catch (e) {
      // 忽略发送错误（窗口可能已关闭）
    }
  })
})

// SSH 相关
ipcMain.handle('ssh:connect', async (_event, config) => {
  return sshService.connect(config)
})

ipcMain.handle('ssh:write', async (_event, id: string, data: string) => {
  sshService.write(id, data)
})

ipcMain.handle('ssh:resize', async (_event, id: string, cols: number, rows: number) => {
  sshService.resize(id, cols, rows)
})

ipcMain.handle('ssh:disconnect', async (_event, id: string) => {
  sshService.disconnect(id)
})

ipcMain.on('ssh:subscribe', (event, id: string) => {
  sshService.onData(id, (data: string) => {
    try {
      if (!event.sender.isDestroyed()) {
        event.sender.send(`ssh:data:${id}`, data)
      }
    } catch (e) {
      // 忽略发送错误（窗口可能已关闭）
    }
  })
})

// AI 相关
ipcMain.handle('ai:chat', async (_event, messages, profileId?: string) => {
  return aiService.chat(messages, profileId)
})

ipcMain.handle('ai:chatStream', async (event, messages, profileId?: string, requestId?: string) => {
  // 使用传入的 requestId 或生成新的 streamId
  const streamId = requestId || Date.now().toString()
  aiService.chatStream(
    messages,
    (chunk: string) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send(`ai:stream:${streamId}`, { chunk })
      }
    },
    () => {
      if (!event.sender.isDestroyed()) {
        event.sender.send(`ai:stream:${streamId}`, { done: true })
      }
    },
    (error: string) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send(`ai:stream:${streamId}`, { error })
      }
    },
    profileId,
    streamId  // 传递 requestId 给 AI 服务
  )
  return streamId
})

ipcMain.handle('ai:abort', async (_event, requestId?: string) => {
  aiService.abort(requestId)
})

// 配置相关
ipcMain.handle('config:get', async (_event, key: string) => {
  return configService.get(key)
})

ipcMain.handle('config:set', async (_event, key: string, value: unknown) => {
  configService.set(key, value)
})

ipcMain.handle('config:getAll', async () => {
  return configService.getAll()
})

// AI 配置
ipcMain.handle('config:getAiProfiles', async () => {
  return configService.getAiProfiles()
})

ipcMain.handle('config:setAiProfiles', async (_event, profiles) => {
  configService.setAiProfiles(profiles)
})

ipcMain.handle('config:getActiveAiProfile', async () => {
  return configService.getActiveAiProfile()
})

ipcMain.handle('config:setActiveAiProfile', async (_event, profileId: string) => {
  configService.setActiveAiProfile(profileId)
})

// SSH 会话配置
ipcMain.handle('config:getSshSessions', async () => {
  return configService.getSshSessions()
})

ipcMain.handle('config:setSshSessions', async (_event, sessions) => {
  configService.setSshSessions(sessions)
})

// 主题配置
ipcMain.handle('config:getTheme', async () => {
  return configService.getTheme()
})

ipcMain.handle('config:setTheme', async (_event, theme: string) => {
  configService.setTheme(theme)
})

// Xshell 导入相关
ipcMain.handle('xshell:selectFiles', async () => {
  const result = await dialog.showOpenDialog({
    title: '选择 Xshell 会话文件',
    filters: [
      { name: 'Xshell 会话文件', extensions: ['xsh'] },
      { name: '所有文件', extensions: ['*'] }
    ],
    properties: ['openFile', 'multiSelections']
  })
  
  if (result.canceled || result.filePaths.length === 0) {
    return { canceled: true, filePaths: [] }
  }
  
  return { canceled: false, filePaths: result.filePaths }
})

ipcMain.handle('xshell:selectDirectory', async () => {
  const result = await dialog.showOpenDialog({
    title: '选择 Xshell 会话目录',
    properties: ['openDirectory']
  })
  
  if (result.canceled || result.filePaths.length === 0) {
    return { canceled: true, dirPath: '' }
  }
  
  return { canceled: false, dirPath: result.filePaths[0] }
})

ipcMain.handle('xshell:importFiles', async (_event, filePaths: string[]) => {
  return xshellImportService.importFiles(filePaths)
})

ipcMain.handle('xshell:importDirectory', async (_event, dirPath: string) => {
  return xshellImportService.importFromDirectory(dirPath)
})

// ==================== Agent 相关 ====================

// 运行 Agent
ipcMain.handle('agent:run', async (event, { ptyId, message, context, config, profileId }: {
  ptyId: string
  message: string
  context: AgentContext
  config?: object
  profileId?: string
}) => {
  // 设置事件回调，将 Agent 事件转发到渲染进程
  // 使用 JSON.parse(JSON.stringify()) 确保对象可序列化
  agentService.setCallbacks({
    onStep: (agentId: string, step: AgentStep) => {
      if (!event.sender.isDestroyed()) {
        // 序列化 step 对象，确保可以通过 IPC 传递
        const serializedStep = JSON.parse(JSON.stringify(step))
        event.sender.send('agent:step', { agentId, step: serializedStep })
      }
    },
    onNeedConfirm: (confirmation: PendingConfirmation) => {
      if (!event.sender.isDestroyed()) {
        // 只发送可序列化的字段，不包含 resolve 函数
        event.sender.send('agent:needConfirm', {
          agentId: confirmation.agentId,
          toolCallId: confirmation.toolCallId,
          toolName: confirmation.toolName,
          toolArgs: JSON.parse(JSON.stringify(confirmation.toolArgs)),
          riskLevel: confirmation.riskLevel
        })
      }
    },
    onComplete: (agentId: string, result: string) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send('agent:complete', { agentId, result })
      }
    },
    onError: (agentId: string, error: string) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send('agent:error', { agentId, error })
      }
    }
  })

  try {
    const result = await agentService.run(ptyId, message, context, config, profileId)
    return { success: true, result }
  } catch (error) {
    return { 
      success: false, 
      error: error instanceof Error ? error.message : '未知错误' 
    }
  }
})

// 中止 Agent
ipcMain.handle('agent:abort', async (_event, agentId: string) => {
  return agentService.abort(agentId)
})

// 确认工具调用
ipcMain.handle('agent:confirm', async (_event, { agentId, toolCallId, approved, modifiedArgs }: {
  agentId: string
  toolCallId: string
  approved: boolean
  modifiedArgs?: Record<string, unknown>
}) => {
  return agentService.confirmToolCall(agentId, toolCallId, approved, modifiedArgs)
})

// 获取 Agent 状态
ipcMain.handle('agent:getStatus', async (_event, agentId: string) => {
  return agentService.getRunStatus(agentId)
})

// 清理 Agent 运行记录
ipcMain.handle('agent:cleanup', async (_event, agentId: string) => {
  agentService.cleanup(agentId)
})

// 更新 Agent 配置（如严格模式）
ipcMain.handle('agent:updateConfig', async (_event, agentId: string, config: { strictMode?: boolean; commandTimeout?: number }) => {
  return agentService.updateConfig(agentId, config)
})

// ==================== 历史记录相关 ====================

// 保存聊天记录
ipcMain.handle('history:saveChatRecord', async (_event, record: ChatRecord) => {
  historyService.saveChatRecord(record)
})

// 批量保存聊天记录
ipcMain.handle('history:saveChatRecords', async (_event, records: ChatRecord[]) => {
  historyService.saveChatRecords(records)
})

// 获取聊天记录
ipcMain.handle('history:getChatRecords', async (_event, startDate?: string, endDate?: string) => {
  return historyService.getChatRecords(startDate, endDate)
})

// 保存 Agent 记录
ipcMain.handle('history:saveAgentRecord', async (_event, record: AgentRecord) => {
  historyService.saveAgentRecord(record)
})

// 获取 Agent 记录
ipcMain.handle('history:getAgentRecords', async (_event, startDate?: string, endDate?: string) => {
  return historyService.getAgentRecords(startDate, endDate)
})

// 获取数据目录路径
ipcMain.handle('history:getDataPath', async () => {
  return historyService.getDataPath()
})

// 获取存储统计
ipcMain.handle('history:getStorageStats', async () => {
  return historyService.getStorageStats()
})

// 导出数据
ipcMain.handle('history:exportData', async () => {
  const configData = configService.getAll()
  const hostProfiles = hostProfileService.getAllProfiles()
  return historyService.exportData(configData, hostProfiles)
})

// 导入数据（单文件）
ipcMain.handle('history:importData', async (_event, data: { version: string; exportTime: number; config: object; history: { chat: ChatRecord[]; agent: AgentRecord[] }; hostProfiles?: unknown[] }) => {
  // 先导入历史记录
  const historyResult = historyService.importData(data)
  if (!historyResult.success) {
    return historyResult
  }

  // 导入主机档案
  if (historyResult.hostProfiles && historyResult.hostProfiles.length > 0) {
    hostProfileService.importProfiles(historyResult.hostProfiles as HostProfile[])
  }

  // 导入配置（需要用户确认是否覆盖）
  // 这里只返回成功，配置的导入由前端单独处理
  return { success: true, configIncluded: !!data.config, hostProfilesImported: historyResult.hostProfiles?.length || 0 }
})

// 导出到文件夹
ipcMain.handle('history:exportToFolder', async (_event, options?: { includeSshPasswords?: boolean; includeApiKeys?: boolean }) => {
  try {
    // 检查 mainWindow 是否存在
    if (!mainWindow) {
      return { success: false, error: '窗口未就绪' }
    }
    
    // 选择导出目录 - createDirectory 仅在 macOS 上有效
    const dialogOptions: Electron.OpenDialogOptions = {
      title: '选择导出目录',
      properties: ['openDirectory'],
      buttonLabel: '导出到此目录'
    }
    
    // macOS 上添加 createDirectory 选项
    if (process.platform === 'darwin') {
      dialogOptions.properties!.push('createDirectory')
    }
    
    const result = await dialog.showOpenDialog(mainWindow, dialogOptions)
    
    if (result.canceled || !result.filePaths[0]) {
      return { success: false, canceled: true }
    }
    
    // 创建子目录
    const exportDir = path.join(result.filePaths[0], `sfterm-backup-${new Date().toISOString().split('T')[0]}`)
    
    const configData = configService.getAll()
    const hostProfiles = hostProfileService.getAllProfiles()
    
    return historyService.exportToFolder(exportDir, configData, hostProfiles, options)
  } catch (error) {
    console.error('导出到文件夹失败:', error)
    return { success: false, error: error instanceof Error ? error.message : '导出失败' }
  }
})

// 从文件夹导入
ipcMain.handle('history:importFromFolder', async () => {
  try {
    // 检查 mainWindow 是否存在
    if (!mainWindow) {
      return { success: false, error: '窗口未就绪' }
    }
    
    // 选择导入目录
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择备份文件夹',
      properties: ['openDirectory'],
      buttonLabel: '导入此目录'
    })
    
    if (result.canceled || !result.filePaths[0]) {
      return { success: false, canceled: true }
    }
    
    const importResult = historyService.importFromFolder(result.filePaths[0])
  
  if (importResult.success) {
    // 导入主机档案
    if (importResult.hostProfiles && importResult.hostProfiles.length > 0) {
      hostProfileService.importProfiles(importResult.hostProfiles as HostProfile[])
    }
    
    // 应用配置（合并而非覆盖）
    if (importResult.config) {
      const currentConfig = configService.getAll()
      
      // SSH 会话：合并（按 ID 去重）
      if (importResult.config.sshSessions) {
        const existingSessions = currentConfig.sshSessions || []
        const newSessions = importResult.config.sshSessions as Array<{ id: string; [key: string]: unknown }>
        const mergedSessions = [...existingSessions]
        for (const session of newSessions) {
          if (!mergedSessions.some(s => s.id === session.id)) {
            mergedSessions.push(session as typeof existingSessions[0])
          }
        }
        configService.set('sshSessions', mergedSessions)
      }
      
      // AI Profiles：合并（按 ID 去重）
      if (importResult.config.aiProfiles) {
        const existingProfiles = currentConfig.aiProfiles || []
        const newProfiles = importResult.config.aiProfiles as Array<{ id: string; [key: string]: unknown }>
        const mergedProfiles = [...existingProfiles]
        for (const profile of newProfiles) {
          if (!mergedProfiles.some(p => p.id === profile.id)) {
            mergedProfiles.push(profile as typeof existingProfiles[0])
          }
        }
        configService.set('aiProfiles', mergedProfiles)
      }
      
      // 其他设置：如果当前为默认值则覆盖
      if (importResult.config.theme) {
        configService.set('theme', importResult.config.theme as string)
      }
      if (importResult.config.terminalSettings) {
        configService.set('terminalSettings', importResult.config.terminalSettings as typeof currentConfig.terminalSettings)
      }
    }
  }
  
  return importResult
  } catch (error) {
    console.error('从文件夹导入失败:', error)
    return { success: false, imported: [], error: error instanceof Error ? error.message : '导入失败' }
  }
})

// 清理旧记录
ipcMain.handle('history:cleanup', async (_event, daysToKeep: number) => {
  return historyService.cleanupOldRecords(daysToKeep)
})

// 在文件管理器中打开数据目录
ipcMain.handle('history:openDataFolder', async () => {
  const dataPath = historyService.getDataPath()
  shell.openPath(dataPath)
})

// ==================== 主机档案相关 ====================

// 获取主机档案
ipcMain.handle('hostProfile:get', async (_event, hostId: string) => {
  return hostProfileService.getProfile(hostId)
})

// 获取所有主机档案
ipcMain.handle('hostProfile:getAll', async () => {
  return hostProfileService.getAllProfiles()
})

// 更新主机档案
ipcMain.handle('hostProfile:update', async (_event, hostId: string, updates: Partial<HostProfile>) => {
  return hostProfileService.updateProfile(hostId, updates)
})

// 添加笔记
ipcMain.handle('hostProfile:addNote', async (_event, hostId: string, note: string) => {
  hostProfileService.addNote(hostId, note)
})

// 删除主机档案
ipcMain.handle('hostProfile:delete', async (_event, hostId: string) => {
  hostProfileService.deleteProfile(hostId)
})

// 获取探测命令
ipcMain.handle('hostProfile:getProbeCommands', async (_event, os: string) => {
  return hostProfileService.getProbeCommands(os)
})

// 解析探测结果
ipcMain.handle('hostProfile:parseProbeOutput', async (_event, output: string, hostId?: string) => {
  const existingProfile = hostId ? hostProfileService.getProfile(hostId) : null
  return hostProfileService.parseProbeOutput(output, existingProfile)
})

// 生成主机 ID
ipcMain.handle('hostProfile:generateHostId', async (_event, type: 'local' | 'ssh', sshHost?: string, sshUser?: string) => {
  return hostProfileService.generateHostId(type, sshHost, sshUser)
})

// 检查是否需要探测
ipcMain.handle('hostProfile:needsProbe', async (_event, hostId: string) => {
  return hostProfileService.needsProbe(hostId)
})

// 后台探测本地主机（不在终端显示）
ipcMain.handle('hostProfile:probeLocal', async () => {
  return hostProfileService.probeAndUpdateLocal()
})

// 生成主机上下文（用于 System Prompt）
ipcMain.handle('hostProfile:generateContext', async (_event, hostId: string) => {
  return hostProfileService.generateHostContext(hostId)
})

// SSH 主机探测
ipcMain.handle('hostProfile:probeSsh', async (_event, sshId: string, hostId: string) => {
  try {
    // 通过 SSH 执行探测命令
    const probeOutput = await sshService.probe(sshId)
    
    // 解析探测结果
    const existingProfile = hostProfileService.getProfile(hostId)
    const probeResult = hostProfileService.parseProbeOutput(probeOutput, existingProfile)
    
    // 更新档案
    const updatedProfile = hostProfileService.updateProfile(hostId, {
      ...probeResult,
      lastProbed: Date.now()
    })
    
    return updatedProfile
  } catch (error) {
    console.error('[SSH Probe] 探测失败:', error)
    return null
  }
})

