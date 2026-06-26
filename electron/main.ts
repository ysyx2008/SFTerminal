// ⚠️ 必须是第一个 import：在任何 service 实例化之前完成 userData 目录重定向
import { runStartupMigrationIfNeeded, getDataDirInfo, requestDataDirMigration, requestDataDirReset, isTargetNonEmpty } from './utils/bootstrap'
import { app, BrowserWindow, ipcMain, shell, dialog, session, Tray, Menu, nativeImage, nativeTheme, powerMonitor, clipboard, protocol, net } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { GenericServerOptions, GithubOptions } from 'builder-util-runtime'
import path, { join } from 'path'
import * as fs from 'fs'
import * as os from 'os'
import { getDefaultShell } from './utils/platform'
import type { AttachmentInfo, DocumentParseProgress, UiThemeMode, UiThemeName, WebSearchSettings } from '@shared/types'
import { getAppTitle as buildAppTitle, getBrandName } from '@shared/brand'

/**
 * 展开路径开头的 `~` 为用户 home 目录。支持 `~`、`~/...`、`~\...`（兼容 Windows）。
 * 用于 shell.openPath / shell.showItemInFolder 等 Electron API（它们不支持 `~`）。
 */
function expandTildePath(p: string): string {
  if (!p) return p
  if (p === '~') return os.homedir()
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(os.homedir(), p.slice(2))
  }
  return p
}

/**
 * 反转义 Unix shell 路径转义字符：`\<space>` / `\(` / `\)` 等 → 真实字符。
 * Agent 工具卡片显示 shell 命令时会出现 `Application\ Support` 这种形式，
 * 经前端文件路径正则识别为整段链接后，路径会带 `\<char>` 转义，必须反转义后才能 openPath。
 * Windows 上 `\` 是路径分隔符，不应反转义。
 */
function unescapeShellPath(p: string): string {
  if (process.platform === 'win32') return p
  // shell 元字符（GNU bash 的可转义字符集合的常用子集）
  return p.replace(/\\([ \t!"#$&'()*,;<=>?@[\]^`{|}])/g, '$1')
}

/** 组合：先 expand `~`，再 unescape shell 转义。所有打开本地路径的 IPC 都该走这条 */
function resolveOpenablePath(p: string): string {
  return unescapeShellPath(expandTildePath(p))
}

// 开发模式下禁用硬件加速，避免热重载时 GPU 进程崩溃
// 这个调用必须在 app.whenReady() 之前
if (!app.isPackaged) {
  app.disableHardwareAcceleration()
}

// 注册 sft-local:// 为特权 scheme，用于安全地加载 userData 目录下的本地文件（如历史截图）
// 必须在 app.whenReady() 之前调用
protocol.registerSchemesAsPrivileged([
  { scheme: 'sft-local', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }
])

// 注册自定义协议，让系统将 sailfish:// 链接路由到本应用
// 开发模式需要传入 Electron 可执行文件路径
if (!app.isPackaged) {
  app.setAsDefaultProtocolClient('sailfish', process.execPath, [path.resolve(process.argv[1])])
} else {
  app.setAsDefaultProtocolClient('sailfish')
}

// 单实例锁：仅打包后启用，防止用户从 Spotlight/Launchpad 重复启动
// 开发/构建时不启用，以便 dev 与 build 可同时运行
const useSingleInstanceLock = app.isPackaged
const gotTheLock = useSingleInstanceLock ? app.requestSingleInstanceLock() : true
if (!gotTheLock) {
  app.quit()
}

registerGracefulShutdownSignals()
registerDevHotReloadGracefulShutdown()

// 深链 URL 队列：窗口未就绪时暂存，加载完成后依次发送
const pendingDeepLinkUrls: string[] = []

// macOS: open-url 可能在 app.ready 之前触发，需尽早注册
app.on('open-url', (event, url) => {
  event.preventDefault()
  if (mainWindow && !mainWindow.isDestroyed()) {
    handleDeepLink(url)
  } else {
    pendingDeepLinkUrls.push(url)
  }
})

const MAX_DEEP_LINK_TASK_LENGTH = 5000

/**
 * 解析 sailfish:// 深链 URL
 * 格式：sailfish://run?task=xxx
 */
function parseDeepLinkUrl(url: string): { action: string; task?: string; skillId?: string } | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'sailfish:') return null
    const action = parsed.hostname || parsed.pathname.replace(/^\/+/, '')
    if (action === 'run') {
      const task = parsed.searchParams.get('task')
      if (task && task.length <= MAX_DEEP_LINK_TASK_LENGTH) {
        return { action: 'run', task }
      }
    }
    if (action === 'install-skill') {
      const skillId = parsed.searchParams.get('id')
      if (skillId && skillId.length <= 128 && /^[a-zA-Z0-9_-]+$/.test(skillId)) {
        return { action: 'install-skill', skillId }
      }
    }
    return { action }
  } catch (e) {
    log.warn('DeepLink: Failed to parse URL:', url, e)
    return null
  }
}

/**
 * 处理深链 URL：解析后发送给渲染进程执行
 */
function handleDeepLink(url: string) {
  log.info('DeepLink: Handling URL:', url.substring(0, 100))
  const parsed = parseDeepLinkUrl(url)
  if (!parsed) return

  const windowReady = mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents && !mainWindow.webContents.isLoading()

  if (parsed.action === 'run' && parsed.task) {
    if (windowReady) {
      showMainWindow()
      mainWindow!.webContents.send('app:run-task', parsed.task)
    } else {
      pendingDeepLinkUrls.push(url)
    }
  } else if (parsed.action === 'install-skill' && parsed.skillId) {
    if (windowReady) {
      showMainWindow()
      mainWindow!.webContents.send('app:install-skill', parsed.skillId)
    } else {
      pendingDeepLinkUrls.push(url)
    }
  }
}

// 启动耗时基线：进程刚启动时记录，后续各阶段日志均以此为参考
// 用于在低配机器（特别是 Windows）上诊断启动慢的具体阶段
const APP_START_TIME = Date.now()

// 读取 package.json 获取版本号（开发模式下 app.getVersion() 返回 Electron 版本）
const packageJson = JSON.parse(fs.readFileSync(join(__dirname, '../package.json'), 'utf-8'))
const APP_VERSION = packageJson.version

// Steam 构建标识：主进程直接读环境变量，dev/build 均可靠
const IS_STEAM_BUILD = process.env.VITE_STEAM_BUILD === 'true'

/** 根据语言获取应用标题（Steam 版使用不同品牌名） */
function getAppTitle(language?: string): string {
  const lang = language || configService?.getLanguage() || 'zh-CN'
  return buildAppTitle(lang, APP_VERSION, IS_STEAM_BUILD)
}

/** 应用短名称（无版本号，用于通知标题等） */
function getAppName(language?: string): string {
  const lang = language || configService?.getLanguage() || 'zh-CN'
  if (IS_STEAM_BUILD) {
    return lang.startsWith('zh') ? '旗鱼终端' : 'SFTerm'
  }
  return getBrandName(lang)
}

/**
 * 修复 macOS/Linux GUI 应用的 PATH 环境变量问题
 * 当应用作为 GUI 应用启动时（双击 .app 或从 Dock/Spotlight 启动），
 * 不会加载用户的 shell 配置文件，导致 PATH 缺少开发工具路径
 * 
 * 优化策略：
 * 1. 立即添加常见路径（不阻塞启动）
 * 2. 异步获取完整 PATH（后台执行）
 * 3. 创建终端时等待 PATH 就绪
 */

// PATH 加载状态
let pathReady = false
let pathReadyResolve: (() => void) | null = null
const pathReadyPromise = new Promise<void>(resolve => {
  pathReadyResolve = resolve
})

/**
 * 立即添加常见的开发工具路径（同步，不阻塞）
 */
function addCommonPaths(): void {
  if (process.platform === 'win32') {
    pathReady = true
    pathReadyResolve?.()
    return
  }

  const homeDir = process.env.HOME || ''
  const commonPaths = [
    '/opt/homebrew/bin',                       // Homebrew (Apple Silicon)
    '/opt/homebrew/sbin',
    '/usr/local/bin',                          // Homebrew (Intel)
    '/usr/local/sbin',
    `${homeDir}/.local/bin`,                   // pipx, poetry 等
    `${homeDir}/.volta/bin`,                   // Volta
    `${homeDir}/.cargo/bin`,                   // Rust/Cargo
    '/usr/local/go/bin',                       // Go
    `${homeDir}/go/bin`,                       // Go workspace
  ]
  
  // 快速添加存在的路径（同步检查，但很快）
  const existingPaths = commonPaths.filter(p => {
    try {
      return fs.existsSync(p)
    } catch {
      return false
    }
  })
  
  if (existingPaths.length > 0) {
    const currentPaths = (process.env.PATH || '').split(':')
    const allPaths = Array.from(new Set([...existingPaths, ...currentPaths]))
    process.env.PATH = allPaths.join(':')
  }
}

/**
 * 异步获取用户 login shell 的完整环境变量
 * 
 * Electron 从 Finder/Dock 启动时 process.env 不含 shell 配置文件中的变量，
 * 通过启动一个 login interactive shell 执行 env 命令来捕获完整环境。
 */
async function fixShellEnvAsync(): Promise<void> {
  if (process.platform === 'win32') {
    pathReady = true
    pathReadyResolve?.()
    return
  }

  try {
    const { exec } = await import('child_process')
    const { promisify } = await import('util')
    const execAsync = promisify(exec)
    
    const userShell = process.env.SHELL || '/bin/zsh'
    const marker = `__SAILFISH_ENV_${Date.now()}__`
    
    // -l -i: login + interactive, 确保 .zprofile 和 .zshrc 都被 source
    const { stdout } = await execAsync(
      `${userShell} -l -i -c 'echo ${marker}START; env; echo ${marker}END'`,
      { timeout: 5000, maxBuffer: 2 * 1024 * 1024, env: { ...process.env, HOME: process.env.HOME } }
    )
    
    const startTag = `${marker}START\n`
    const endTag = `\n${marker}END`
    const startIdx = stdout.indexOf(startTag)
    const endIdx = stdout.lastIndexOf(endTag)
    
    if (startIdx >= 0 && endIdx > startIdx) {
      const envSection = stdout.substring(startIdx + startTag.length, endIdx)
      const skipKeys = new Set([
        '_', 'SHLVL', 'PWD', 'OLDPWD',
        'TERM_SESSION_ID', 'TERM_PROGRAM', 'TERM_PROGRAM_VERSION',
      ])
      let count = 0
      for (const line of envSection.split('\n')) {
        const eqIdx = line.indexOf('=')
        if (eqIdx <= 0) continue
        const key = line.substring(0, eqIdx)
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || skipKeys.has(key)) continue
        const value = line.substring(eqIdx + 1)
        if (process.env[key] !== value) {
          process.env[key] = value
          count++
        }
      }
      log.info(`fixShellEnv: merged ${count} env vars from login shell`)
    } else {
      log.warn('fixShellEnv: markers not found, falling back to PATH-only')
      await fixPathOnly(execAsync, userShell)
    }
  } catch (error) {
    log.warn('fixShellEnv: failed, falling back to PATH-only:', error)
    await fixPathFallback()
  } finally {
    pathReady = true
    pathReadyResolve?.()
    mainWindow?.webContents.send('path:ready')
  }
}

async function fixPathOnly(
  execAsync: (cmd: string, opts?: object) => Promise<{ stdout: string }>,
  userShell: string
): Promise<void> {
  try {
    const { stdout } = await execAsync(`${userShell} -l -c 'echo -n $PATH'`, {
      timeout: 3000,
      env: { ...process.env, HOME: process.env.HOME }
    })
    const shellPath = stdout.trim()
    if (shellPath && shellPath !== process.env.PATH) {
      const currentPaths = (process.env.PATH || '').split(':')
      const shellPaths = shellPath.split(':')
      process.env.PATH = Array.from(new Set([...shellPaths, ...currentPaths])).join(':')
    }
  } catch {
    await fixPathFallback()
  }
}

async function fixPathFallback(): Promise<void> {
  try {
    const homeDir = process.env.HOME || ''
    const nvmBase = `${homeDir}/.nvm/versions/node`
    if (fs.existsSync(nvmBase)) {
      const versions = fs.readdirSync(nvmBase)
      const nvmPaths = versions
        .map(v => `${nvmBase}/${v}/bin`)
        .filter(p => fs.existsSync(p))
      if (nvmPaths.length > 0) {
        const currentPaths = (process.env.PATH || '').split(':')
        process.env.PATH = Array.from(new Set([...nvmPaths, ...currentPaths])).join(':')
      }
    }
  } catch {
    // ignore
  }
}

/**
 * 等待 PATH 就绪
 */
async function waitForPath(): Promise<void> {
  if (pathReady) return
  await pathReadyPromise
}

/**
 * 检查 PATH 是否就绪
 */
function isPathReady(): boolean {
  return pathReady
}

// 立即添加常见路径（不阻塞）
addCommonPaths()

// 异步获取 shell 完整环境变量（后台执行）
fixShellEnvAsync()
import { PtyService } from './services/pty.service'
import { SshService } from './services/ssh.service'
import { AiService } from './services/ai.service'
import { ConfigService, McpServerConfig, setConfigServiceInstance, DEFAULT_KEYBOARD_SHORTCUTS, type KeyboardShortcuts } from './services/config.service'
import { initLogging, setLogLevel as setBackendLogLevel, getLogDir, createLogger } from './utils/logger'
import { serializeAgentStepForIpc } from './utils/agent-step-ipc'
import { XshellImportService } from './services/xshell-import.service'
import { AgentService, AgentStep, AgentContext } from './services/agent'
import type { PendingConfirmation, ExecutionMode } from './services/agent/types'
import { orchestratorService } from './services/agent/orchestrator'
import type { OrchestratorConfig } from './services/agent/orchestrator-types'
import { HistoryService, AgentRecord } from './services/history.service'
import { HostProfileService, HostProfile } from './services/host-profile.service'
import { getDocumentParserService, UploadedFile, ParseOptions, ParsedDocument } from './services/document-parser.service'
import { SftpService, SftpConfig } from './services/sftp.service'
import { LocalFsService } from './services/local-fs.service'
import { McpService } from './services/mcp.service'
import { getUserSkillService, UserSkill } from './services/user-skill.service'
import { getBuiltinSkillsForSettings } from './services/agent/skills/registry'
import { getSkillMarketService, type MarketSkill, type MarketSkillItem, type SkillOperationResult, type SkillRegistry, type SkillPreviewResult, type SkillSource } from './services/skill-market.service'
import { getKnowledgeService, KnowledgeService } from './services/knowledge'
import type { KnowledgeSettings, SearchOptions, AddDocumentOptions, ModelTier } from './services/knowledge/types'
import {
  decrypt
} from './services/knowledge/crypto'
import { initTerminalStateService, type TerminalState, type CwdChangeEvent, type CommandExecution, type CommandExecutionEvent } from './services/terminal-state.service'
import { initTerminalAwarenessService, type TerminalAwareness } from './services/terminal-awareness'
import { initScreenContentService } from './services/screen-content.service'
import { initBrowserBridgeService, getBrowserBridgeService } from './services/browser-bridge/browser-bridge.service'
import type { BrowserBridgeBrowser } from '@shared/types/browser-bridge'
import { menuService } from './services/menu.service'
import { t, errMsg, setConfigService as setMainI18nConfig, updateLocale as updateMainI18nLocale } from './i18n/main-i18n'
import { attentionService } from './services/attention.service'
import { getAiDebugService } from './services/ai-debug.service'
import { getSchedulerService, type CreateTaskParams } from './services/scheduler.service'
import { getSchedulerStore } from './services/scheduler.store'
import { getWatchService } from './services/watch/watch.service'
import { getSensorService } from './services/sensor'
import { getBondService } from './services/bond.service'
import { splitPaneBridge } from './services/split-pane-bridge.service'
import { workbenchBridge } from './services/workbench-bridge.service'
import type { CreateWatchParams } from './services/watch/types'
import { getWebChatService } from './services/web-chat.service'
import { getMigrationRunner, createBackup } from './migrations'
import { getGatewayService, type GatewayConfig } from './services/gateway.service'
import { BastionService } from './services/bastion.service'
import { getIMService } from './services/im/im.service'
import type { DingTalkConfig, FeishuConfig, SlackConfig, TelegramConfig, WeComConfig } from './services/im/types'
import { getWorkspacePath, ensureAgentWorkspaceDirs } from './services/agent/tools/file'
import { getContextKnowledgeService } from './services/knowledge/context-knowledge'
import {
  getEmailCredential, setEmailCredential, deleteEmailCredential,
  getCalendarCredential, setCalendarCredential, deleteCalendarCredential,
  setSkillEnv, getSkillEnv, deleteSkillEnv, listSkillEnvNames
} from './services/credential.service'
import { getServerConfig } from './services/agent/skills/email/session'
import { setEmailAccounts } from './services/agent/skills/email/executor'
import { setCalendarAccounts } from './services/agent/skills/calendar/executor'
import { readIdentityFile, readSoulFile, readUserFile, readHeartbeatFile } from './services/agent/prompt-builder'
import { startFeishuOAuth, revokeFeishuOAuth, getFeishuOAuthStatus } from './services/agent/skills/feishu/oauth'

// 禁用 GPU 加速可能导致的问题（可选）
// app.disableHardwareAcceleration()

// 禁用开发模式下的安全警告（CSP unsafe-eval 是 Vite 热更新所需）
// 打包后的生产版本不会有这个警告
if (process.env.VITE_DEV_SERVER_URL) {
  process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true'
}

// 捕获未处理的异常，防止 EPIPE 等错误导致崩溃
process.on('uncaughtException', (error) => {
  // 忽略 EPIPE 错误（管道关闭时的正常错误）
  if (error.message?.includes('EPIPE') || error.message?.includes('read EPIPE')) {
    return
  }
  log.error('Uncaught exception:', error)
})

process.on('unhandledRejection', (reason) => {
  // 忽略 EPIPE 相关的 Promise 拒绝
  if (String(reason).includes('EPIPE')) {
    return
  }
  log.error('Unhandled rejection:', reason)
})

const log = createLogger('Main')

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let fileManagerWindow: BrowserWindow | null = null  // 文件管理器独立窗口
let fileManagerParams: {  // 文件管理器窗口初始化参数
  sessionId?: string
  sftpConfig?: SftpConfig
  initialLocalPath?: string
  initialRemotePath?: string
} | null = null
let forceQuit = false  // 是否强制退出（跳过确认）
let isQuitting = false  // 是否正在退出应用（Cmd+Q 触发，区分于 Cmd+W 关闭窗口）

// macOS ⌘Q 防误触：首次按下展示提示，2 秒内再次按下才真正退出
let quitConfirmTimer: ReturnType<typeof setTimeout> | null = null

function sendQuitToast(show: boolean): void {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('quit:toast', { show })
    }
  } catch { /* ignore */ }
}

function handleQuitAttempt(): void {
  // 已进入退出流程（二次确认或终端计数对话框期间），忽略后续按键
  if (isQuitting) return
  if (quitConfirmTimer) {
    // 2 秒内再次按下：正式退出
    clearTimeout(quitConfirmTimer)
    quitConfirmTimer = null
    sendQuitToast(false)
    isQuitting = true
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (process.platform === 'darwin') app.dock?.show()
      mainWindow.show()
      mainWindow.close()
    } else {
      forceQuit = true
      app.quit()
    }
  } else {
    // 首次按下：显示提示，等待二次确认
    sendQuitToast(true)
    quitConfirmTimer = setTimeout(() => {
      quitConfirmTimer = null
      sendQuitToast(false)
    }, 2000)
  }
}

// Cmd+Q 退出确认：若渲染进程未及时回复终端数量，避免主窗口 close 永久被 preventDefault 卡住
let quitTerminalCountTimer: ReturnType<typeof setTimeout> | null = null
let quitTerminalCountHandled = false

// 服务实例
const ptyService = new PtyService()
const sshService = new SshService()

function clearQuitTerminalCountWatchdog(): void {
  if (quitTerminalCountTimer !== null) {
    clearTimeout(quitTerminalCountTimer)
    quitTerminalCountTimer = null
  }
}

function beginQuitTerminalCountRequest(): void {
  clearQuitTerminalCountWatchdog()
  quitTerminalCountHandled = false
  quitTerminalCountTimer = setTimeout(() => {
    quitTerminalCountTimer = null
    const n = ptyService.getActiveInstanceCount() + sshService.getActiveInstanceCount()
    log.warn('[Quit] 渲染进程未及时返回终端数量，使用主进程会话数兜底:', n)
    void proceedQuitAfterTerminalCount(n)
  }, 2500)
}

async function proceedQuitAfterTerminalCount(terminalCount: number): Promise<void> {
  if (quitTerminalCountHandled) {
    return
  }
  quitTerminalCountHandled = true
  clearQuitTerminalCountWatchdog()

  const messageBoxOptions = menuService.getQuitConfirmDialogOptions(terminalCount)

  if (terminalCount > 0) {
    const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null
    const result = parent
      ? await dialog.showMessageBox(parent, messageBoxOptions)
      : await dialog.showMessageBox(messageBoxOptions)

    if (result.response === 1) {
      forceQuit = true
      mainWindow?.close()
    } else {
      isQuitting = false
    }
  } else {
    forceQuit = true
    mainWindow?.close()
  }
}
const aiService = new AiService()
const configService = new ConfigService()
setConfigServiceInstance(configService)
setMainI18nConfig(configService)
initLogging(configService.getLogLevel())
// Early phase migrations（仅需 ConfigService）
getMigrationRunner().run('early', {
  configService,
  userDataPath: app.getPath('userData'),
}).catch(err => log.error('Early migration failed:', err))

const xshellImportService = new XshellImportService()
const hostProfileService = new HostProfileService()
const mcpService = new McpService()
const agentService = new AgentService(aiService, ptyService, hostProfileService, mcpService, configService, sshService)
const historyService = new HistoryService()
agentService.setHistoryService(historyService)
const documentParserService = getDocumentParserService()
const sftpService = new SftpService()
const localFsService = new LocalFsService()

// 设置 SFTP 服务到 Agent（用于 SSH 终端的文件写入）
agentService.setSftpService(sftpService)

// 插件系统
import { createPluginRegistry } from './services/plugin/registry'
const pluginRegistry = createPluginRegistry({
  enabled: configService.get('pluginsEnabled'),
  allow: configService.get('pluginsAllow'),
  deny: configService.get('pluginsDeny'),
  loadPaths: configService.get('pluginsLoadPaths'),
  entries: configService.get('pluginsEntries'),
  userDataPath: app.getPath('userData')
})
agentService.setPluginRegistry(pluginRegistry)

// 定时任务调度服务
const schedulerService = getSchedulerService()

// Watch & Sensor 服务（感知层）
const sensorService = getSensorService()
const watchService = getWatchService()
const bondService = getBondService()

// 终端状态服务（CWD 追踪、命令状态等）
const terminalStateService = initTerminalStateService(ptyService, sshService)

// 终端感知服务（整合屏幕分析和进程监控）
const terminalAwarenessService = initTerminalAwarenessService(ptyService, terminalStateService, sshService)

// 监听 CWD 变化，转发到前端
terminalStateService.onCwdChange((event: CwdChangeEvent) => {
  mainWindow?.webContents.send('terminal:cwdChange', event)
})

// 监听命令执行事件，转发到前端
terminalStateService.onCommandExecution((event: CommandExecutionEvent) => {
  mainWindow?.webContents.send('terminal:commandExecution', event)
})

// ==================== 首次启动引导向导延迟初始化 ====================
//
// 问题：Windows 首次启动时，Setup Wizard 出现后 ~500ms，initKnowledgeService()
// 开始加载 @lancedb/lancedb（Rust 编译的大型原生 .node 模块）。Windows Defender
// 等安全扫描在 LoadLibrary() 上同步阻塞 Node.js 主线程 5~30 秒，期间所有 IPC
// 消息无法处理，UI 完全卡死。
//
// 解决方案：首次启动（setupCompleted = false）时，把知识库和后端服务的重量级
// 初始化推迟到向导完成后再执行，向导期间主线程保持轻负载以保证 IPC 响应正常。
let resolveSetupDone: (() => void) | null = null
// 默认立即 resolve（非首次启动路径直接跳过等待）
let setupDonePromise: Promise<void> = Promise.resolve()

// 知识库服务（延迟初始化，需要其他服务已就绪）
let knowledgeService: KnowledgeService | null = null

// 知识库加载状态
let knowledgeReady = false
let knowledgeReadyResolve: (() => void) | null = null
const knowledgeReadyPromise = new Promise<void>(resolve => {
  knowledgeReadyResolve = resolve
})

function getKnowledge(): KnowledgeService {
  if (!knowledgeService) {
    knowledgeService = getKnowledgeService(configService, aiService, mcpService)
    if (!knowledgeService) {
      throw new Error('Failed to initialize KnowledgeService')
    }
  }
  return knowledgeService
}

/**
 * 等待知识库就绪
 */
async function waitForKnowledge(): Promise<void> {
  if (knowledgeReady) return
  await knowledgeReadyPromise
}

/**
 * 检查知识库是否就绪
 */
function isKnowledgeReady(): boolean {
  return knowledgeReady
}

// 在应用启动时初始化知识库服务（确保 Agent 可以访问）
async function initKnowledgeService(): Promise<void> {
  try {
    knowledgeService = getKnowledgeService(configService, aiService, mcpService)
    
    // 如果知识库已启用，初始化服务（加载向量数据）
    if (knowledgeService && knowledgeService.isEnabled()) {
      // 监听模型升级事件（维度变化导致索引重建）
      knowledgeService.once('indexCleared', ({ reason, oldDimensions, newDimensions }) => {
        log.info(`知识库模型升级: ${reason} (${oldDimensions} -> ${newDimensions})`)
      })

      // 监听重建开始事件（任何原因：模型升级/数据损坏/BM25 缺失等）
      // 这是前端进度条出现的统一入口——indexCleared 只覆盖维度变化一种情况，
      // 数据损坏/BM25 缺失场景此前没有触发 upgrading 导致用户感觉 UI 纯卡住。
      knowledgeService.on('rebuildStarted', (
        { total, libraryTotal, reason, cause }:
        { total: number; libraryTotal?: number; reason: string; cause?: 'dimension_mismatch' | 'data_corrupted' | 'missing' }
      ) => {
        log.info(`知识库开始重建: reason=${reason}, cause=${cause || 'missing'}, total=${total}, libraryTotal=${libraryTotal ?? 'n/a'}`)
        mainWindow?.webContents.send('knowledge:upgrading', {
          reason,
          cause: cause || 'missing',
          total,
          libraryTotal,
        })
      })

      // 监听重建进度（仅在升级时通知前端）
      knowledgeService.on('rebuildProgress', (progress: { current: number; total: number; filename: string }) => {
        mainWindow?.webContents.send('knowledge:rebuildProgress', progress)
      })

      // 监听增量修复进度
      knowledgeService.on('repairStarted', (data: { total: number }) => {
        mainWindow?.webContents.send('knowledge:repairStarted', data)
      })
      knowledgeService.on('repairProgress', (progress: { current: number; total: number; filename: string }) => {
        mainWindow?.webContents.send('knowledge:repairProgress', progress)
      })
      knowledgeService.on('repairCompleted', (data: { added: number; checked: number; durationMs: number }) => {
        mainWindow?.webContents.send('knowledge:repairCompleted', data)
      })
      
      await knowledgeService.initialize()

      // 预热 embedding 推理（条件触发 + 空闲延后执行）
      //
      // ONNX 模型第一次推理需要 JIT 编译，会比较慢，提前预热可以加速首次 Agent
      // 对话响应。但 onnxruntime-node@1.14 的推理跑在主进程主线程，启动期 BFC
      // arena 还在快速扩张时再叠加一次 forward，曾在 macOS 上把 BFC arena 推到
      // 2GB 边界触发 libsystem_malloc 的 SIGTRAP（EXC_BREAKPOINT brk 0）。
      //
      // 收紧策略：
      // 1) 知识库为空 → 直接跳过预热（首次 Agent 对话才会按需加载，差几百 ms 不影响体验）
      // 2) 非空 → 延后 8 秒再跑，让启动期所有重活儿（rebuild、IM 启动、邮箱/日历同步等）
      //    都跑完，BFC arena 进入稳态后再做这一次额外推理
      const docCount = knowledgeService.getDocuments().length
      if (docCount > 0) {
        // unref：暖机仅为加速首次推理，绝不可阻塞进程退出。如果用户在 8 秒
        // 之内就退出 app，这个 timer 不会把事件循环 keep alive
        const warmupTimer = setTimeout(() => {
          knowledgeService?.search('预热', { limit: 1 }).catch(() => {
            // 忽略预热错误（可能知识库为空 / 模型未就绪）
          })
          log.info('Embedding 预热推理已启动（延后 8s）')
        }, 8000)
        warmupTimer.unref?.()
      } else {
        log.info('知识库为空，跳过 embedding 预热')
      }

      // L3 对话索引回填（后台执行，不阻塞启动）
      backfillConversationIndexAsync(knowledgeService).catch(err => {
        log.warn('对话索引回填失败:', err)
      })
    }
  } catch (e) {
    log.error('Failed to initialize KnowledgeService:', e)
  } finally {
    // 无论成功与否，都标记为就绪（避免无限等待）
    knowledgeReady = true
    knowledgeReadyResolve?.()
    // 通知前端知识库已就绪
    mainWindow?.webContents.send('knowledge:ready')
    log.info('知识库服务初始化完成')
  }
}

/**
 * L3 对话索引后台回填：将已有的历史 AgentRecord 索引到向量库
 * 只在首次启用时运行（通过标记文件判断，避免重复执行）
 */
async function backfillConversationIndexAsync(ks: KnowledgeService): Promise<void> {
  const { app } = await import('electron')
  const fs = await import('fs')
  const pathModule = await import('path')
  const markerPath = pathModule.join(app.getPath('userData'), 'knowledge', '.conversation-index-backfilled')

  if (fs.existsSync(markerPath)) return

  const records = historyService.getAgentRecords()
  if (records.length === 0) {
    fs.mkdirSync(pathModule.dirname(markerPath), { recursive: true })
    fs.writeFileSync(markerPath, new Date().toISOString(), 'utf-8')
    return
  }

  log.info(`开始对话索引回填: ${records.length} 条历史记录`)

  const result = await ks.backfillConversationIndex(
    records.map(r => ({
      id: r.id,
      userTask: r.userTask,
      finalResult: r.finalResult,
      status: r.status,
      timestamp: r.timestamp,
      hostId: undefined
    }))
  )

  // 回填完成后写入标记文件
  fs.mkdirSync(pathModule.dirname(markerPath), { recursive: true })
  fs.writeFileSync(markerPath, new Date().toISOString(), 'utf-8')

  log.info(`对话索引回填完成: indexed=${result.indexed}, skipped=${result.skipped}, failed=${result.failed}`)
}

// MCP 服务事件转发
mcpService.on('connected', (serverId: string) => {
  mainWindow?.webContents.send('mcp:connected', serverId)
})
mcpService.on('disconnected', (serverId: string) => {
  mainWindow?.webContents.send('mcp:disconnected', serverId)
})
mcpService.on('error', (data: { serverId: string; error?: string }) => {
  mainWindow?.webContents.send('mcp:error', data)
})
mcpService.on('refreshed', (serverId: string) => {
  mainWindow?.webContents.send('mcp:refreshed', serverId)
})

// ==================== 系统托盘 ====================

function createTray() {
  if (tray) return

  // dev 模式从项目 resources/ 读取，打包后从 app Resources/ 读取
  const resDir = app.isPackaged ? process.resourcesPath : join(__dirname, '../resources')
  const trayIconPath = process.platform === 'darwin'
    ? join(resDir, 'icon_trayTemplate.png')
    : join(resDir, 'icon.png')

  const icon = nativeImage.createFromPath(trayIconPath)
  if (process.platform === 'darwin') {
    icon.setTemplateImage(true)
  }

  tray = new Tray(icon)
  tray.setToolTip('SailFish')
  updateTrayMenu()

  tray.on('click', () => {
    showMainWindow()
  })
}

function updateTrayMenu() {
  if (!tray) return
  tray.setContextMenu(Menu.buildFromTemplate(
    menuService.buildTrayContextMenu({
      onShowWindow: () => showMainWindow(),
      onQuit: () => app.quit(),
    })
  ))
}

function showMainWindow() {
  if (process.platform === 'darwin') {
    app.dock?.show()
  }

  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) {
      mainWindow.restore()
    }
    mainWindow.show()
    mainWindow.focus()
    if (process.platform === 'win32') {
      // Windows 防焦点抢占：短暂置顶确保窗口前台显示
      mainWindow.setAlwaysOnTop(true)
      mainWindow.setAlwaysOnTop(false)
      // Windows 上 BrowserWindow.focus() 不一定让 webContents 获得键盘输入
      // 必须显式调用 webContents.focus() 确保键盘事件路由到渲染进程
      mainWindow.webContents.focus()
    }
  } else {
    createWindow()
    setupWindowServices()
  }
}

/**
 * 设置/更新各服务对 mainWindow 的引用和 did-finish-load 事件
 * 在首次创建窗口和窗口重建时调用
 */
function setupWindowServices() {
  if (!mainWindow) return

  webChatService.setMainWindow(mainWindow)
  gatewayService.setMainWindow(mainWindow)
  imService.setMainWindow(mainWindow)
  menuService.setMainWindow(mainWindow)
  if (process.platform === 'darwin') {
    menuService.setQuitHandler(handleQuitAttempt)
  }
  attentionService.setMainWindow(mainWindow)
  getBrowserBridgeService().setMainWindow(mainWindow)
  // macOS 一次性触发通知权限请求，让 dock badge 在打包版上能正常显示
  attentionService.ensurePermission()

  const lang = configService?.getLanguage() || 'zh-CN'
  menuService.setLanguage(lang)
  const shortcuts = configService?.getKeyboardShortcuts()
  if (shortcuts) {
    menuService.setShortcuts(shortcuts)
  }
  menuService.applyMenu()
}

/**
 * 退出时清理所有后端服务和连接
 */
let shuttingDown = false
let cleanupPromise: Promise<void> | null = null

async function cleanupAllServices(): Promise<void> {
  if (cleanupPromise) return cleanupPromise
  cleanupPromise = (async () => {
  watchService.stop()
  sensorService.stop().catch(() => {})
  schedulerService.stop()
  gatewayService.stop().catch(() => {})
  imService.stopAll().catch(() => {})
  webChatService.dispose().catch(() => {})
  ptyService.disposeAll()
  sshService.disposeAll()
  sftpService.disconnectAll()
  mcpService.disconnectAll()
  // 杀掉 assistant 模式 exec 工具留下的后台子进程。
  // beforeExit 在 Electron app.quit() 时不会触发，必须在这里显式调用，
  // 否则用户退出 SailFish 后，npm install / 长 build / 服务进程 仍挂着。
  try {
    const { getExecManager } = await import('./services/agent/tools/exec-manager')
    getExecManager().killAllOnShutdown()
  } catch (e) {
    log.warn('exec-manager shutdown 失败:', e)
  }
  // 主动释放知识库资源：让 embedding worker 收到 dispose 后干净退出，
  // 避免被 OS SIGTERM 收尸时正好打断 LanceDB transaction / ORT session
  // 释放，留下 "manifest 已落盘但 .lance 数据文件未落盘" 的损坏状态
  // （曾导致 hybridSearch 整天反复报 LanceError(IO): Not found: …lance）。
  // 给 worker 最多 3s 优雅退出预算（含 LanceDB compact + embedding dispose）。
  try {
    await knowledgeService?.disposeAsync(3000)
  } catch (e) {
    log.warn('Knowledge dispose 失败:', e)
  }
  })()
  return cleanupPromise
}

/** dev Ctrl+C / 系统 SIGTERM 时尽量优雅收尾，避免 LanceDB transaction 半截退出 */
function registerGracefulShutdownSignals(): void {
  const shutdown = (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    log.info(`收到 ${signal}，正在优雅关闭后端服务...`)
    forceQuit = true
    isQuitting = true
    cleanupAllServices()
      .catch(err => log.warn('优雅关闭失败:', err))
      .finally(() => {
        if (app.isReady()) {
          app.quit()
        } else {
          process.exit(0)
        }
      })
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

/**
 * dev 主进程热重载：vite-plugin-electron 默认 treeKillSync 先杀 LanceDB worker，
 * 容易在 table.add / compact 半截时留下损坏的 .lance 文件。
 * 在 vite 重启 Electron 前先收 graceful-shutdown，跑完 disposeAsync 再退出。
 */
function registerDevHotReloadGracefulShutdown(): void {
  if (!process.env.VITE_DEV_SERVER_URL) return
  process.on('message', (msg: unknown) => {
    const type = typeof msg === 'object' && msg !== null && 'type' in msg
      ? (msg as { type?: string }).type
      : undefined
    if (type !== 'graceful-shutdown') return
    if (shuttingDown) return
    shuttingDown = true
    forceQuit = true
    log.info('dev 热重载：收到 graceful-shutdown，正在释放知识库 worker...')
    cleanupAllServices()
      .catch(err => log.warn('dev graceful-shutdown 失败:', err))
      .finally(() => process.exit(0))
  })
}

// ==================== 主窗口 ====================

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
    center: true, // 首次启动在当前屏幕工作区居中，避免默认策略下贴近屏幕上沿
    title: getAppTitle(),
    icon: iconPath,
    frame: process.platform !== 'win32', // Windows 使用无边框 + 完全自绘标题栏（min/max/close）
    // macOS: 隐藏原生标题栏但保留红绿灯按钮（浮在内容上）
    ...(process.platform === 'darwin' ? {
      titleBarStyle: 'hiddenInset' as const,
      trafficLightPosition: { x: 8, y: 8 }
    } : {}),
    // Windows: 完全无边框（不用 titleBarOverlay，因为系统按钮区无法被应用 DOM 覆盖，
    // 全屏模态时会和模态自身关闭按钮挤一起）。改由渲染端 WindowControls.vue 自绘三按钮，
    // 模态打开时按钮被模态全屏遮挡，体验最干净。
    ...(process.platform === 'win32' ? {
      titleBarStyle: 'hidden' as const,
    } : {}),
    show: false, // 先不显示，等待 ready-to-show 或兜底超时（见下方）
    backgroundColor: '#181818', // 与 :root --bg-primary 一致，避免显示瞬间黑/白闪烁
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false
    }
  })

  // 窗口显示控制：
  // - 旧逻辑（ready-to-show 触发立即 show）：ready-to-show 在首帧 paint 时就触发，
  //   此时 Vue 还没 mount（src/main.ts 之前 await IPC 拉主题阻塞了 mount），
  //   用户会看到一段"dark 背景但 #app 内 boot-splash 还隐着"的黑屏。
  // - 现在：等渲染端 Vue mount 完成（IPC 'app:mounted'）再 show，确保窗口出现
  //   时就是真实 UI；2s 兜底防止极端情况（首次启动 / 低配 Win）渲染端长时间
  //   不 mount，超时后 show 出窗口让 boot-splash 顶上。
  let mainWindowShown = false
  let showFallbackTimer: NodeJS.Timeout | null = null
  const showMainWindowOnce = (reason: string) => {
    if (mainWindowShown || !mainWindow || mainWindow.isDestroyed()) return
    mainWindowShown = true
    if (showFallbackTimer) {
      clearTimeout(showFallbackTimer)
      showFallbackTimer = null
    }
    log.info(`[startup] showing main window (${reason}, +${Date.now() - APP_START_TIME}ms)`)
    mainWindow.show()
    if (process.platform === 'win32') {
      // Windows 上 show() 可能仅闪烁任务栏而不前台显示（系统防焦点抢占）
      // 通过短暂置顶强制前台显示
      mainWindow.setAlwaysOnTop(true)
      mainWindow.setAlwaysOnTop(false)
      mainWindow.webContents.focus()
    }
  }
  // 'app:mounted' IPC 由 src/main.ts 在 Vue mount 完成后立即发出
  // 这是首选 show 时机：窗口出现 = 真实 UI 出现，不会有黑屏中转
  // 用 removeAllListeners + on 的组合（而不是 once）以支持窗口重建场景
  const onAppMounted = () => showMainWindowOnce('vue-mounted')
  ipcMain.removeAllListeners('app:mounted')
  ipcMain.on('app:mounted', onAppMounted)
  // 兜底：2s 后无论 'app:mounted' 是否到达都强制 show
  // 高配机器 Vue mount 通常 <500ms，此 setTimeout 实际上不会生效；
  // 低配 Win 上 webContents 首屏 5~10s，超时后 boot-splash 接管显示
  showFallbackTimer = setTimeout(() => showMainWindowOnce('timeout-fallback'), 2000)
  // 窗口销毁时清理兜底 timer 和 IPC listener
  mainWindow.once('closed', () => {
    if (showFallbackTimer) {
      clearTimeout(showFallbackTimer)
      showFallbackTimer = null
    }
    ipcMain.removeListener('app:mounted', onAppMounted)
    splitPaneBridge.detachWindow()
    workbenchBridge.detachWindow()
  })

  // 分屏 / 工作台反向 IPC 桥接
  splitPaneBridge.init(mainWindow)
  workbenchBridge.init(mainWindow)

  // Windows 上窗口获得焦点时，确保 webContents 也获得键盘输入路由
  // 防止 setAlwaysOnTop 切换或通知交互后出现"窗口在前台但无法输入"的僵死状态
  if (process.platform === 'win32') {
    mainWindow.on('focus', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.focus()
      }
    })
  }

  // 全屏状态变化通知：macOS 下全屏会隐藏红绿灯按钮，渲染端需要取消左侧保留空间
  mainWindow.on('enter-full-screen', () => {
    mainWindow?.webContents.send('window:fullscreenChange', true)
  })
  mainWindow.on('leave-full-screen', () => {
    mainWindow?.webContents.send('window:fullscreenChange', false)
  })

  // Windows 最大化状态变化：渲染端的自绘 Max/Restore 按钮要据此切换图标
  // （非 Windows 平台不依赖此事件，发了也无副作用）
  mainWindow.on('maximize', () => {
    mainWindow?.webContents.send('window:maximizeChange', true)
  })
  mainWindow.on('unmaximize', () => {
    mainWindow?.webContents.send('window:maximizeChange', false)
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

  // 拦截页面内链接点击，防止应用内导航到外部网页
  mainWindow.webContents.on('will-navigate', (event, url) => {
    // 允许开发环境的热更新导航
    if (process.env.VITE_DEV_SERVER_URL && url.startsWith(process.env.VITE_DEV_SERVER_URL)) {
      return
    }
    // 允许导航到本地文件（生产环境）
    if (url.startsWith('file://')) {
      return
    }
    // 阻止导航到外部 URL，改为在系统浏览器中打开
    event.preventDefault()
    shell.openExternal(url)
  })

  mainWindow.on('closed', () => {
    // macOS 上 window-all-closed 不会调用 app.quit()，需在确认退出并关闭主窗口后主动退出（先 quit 再置空，避免 quit 流程中读到窗口）
    if (process.platform === 'darwin' && isQuitting) {
      app.quit()
    }
    mainWindow = null
  })

  mainWindow.on('close', async (event) => {
    if (forceQuit) {
      return
    }

    if (isQuitting) {
      // Cmd+Q 退出：走终端确认逻辑
      event.preventDefault()
      try {
        beginQuitTerminalCountRequest()
        mainWindow?.webContents.send('window:requestTerminalCount')
      } catch (e) {
        clearQuitTerminalCountWatchdog()
        forceQuit = true
        mainWindow?.close()
      }
      return
    }

    // Cmd+W 关闭窗口：隐藏到托盘，服务继续运行
    event.preventDefault()
    mainWindow?.hide()
    if (process.platform === 'darwin') {
      app.dock?.hide()
    }
  })
}

/**
 * 创建文件管理器独立窗口
 */
function createFileManagerWindow(params?: {
  sessionId?: string
  sftpConfig?: SftpConfig
  initialLocalPath?: string
  initialRemotePath?: string
}): void {
  // 如果窗口已存在，聚焦并更新参数
  if (fileManagerWindow && !fileManagerWindow.isDestroyed()) {
    fileManagerWindow.focus()
    if (params) {
      fileManagerParams = params
      fileManagerWindow.webContents.send('fileManager:paramsUpdate', params)
    }
    return
  }

  // 保存初始化参数
  fileManagerParams = params || null

  // 根据平台选择图标
  const iconPath = process.platform === 'darwin'
    ? join(__dirname, '../resources/icon.icns')
    : process.platform === 'win32'
      ? join(__dirname, '../resources/icon.ico')
      : join(__dirname, '../resources/icon.png')

  fileManagerWindow = new BrowserWindow({
    width: 1200,
    height: 750,
    minWidth: 900,
    minHeight: 500,
    title: t('window.fileManager'),
    icon: iconPath,
    frame: true,
    show: false,
    backgroundColor: '#1e1e1e',
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  // 窗口准备好后显示
  fileManagerWindow.once('ready-to-show', () => {
    fileManagerWindow?.show()
  })

  // 加载文件管理器页面
  if (process.env.VITE_DEV_SERVER_URL) {
    fileManagerWindow.loadURL(`${process.env.VITE_DEV_SERVER_URL}file-manager.html`)
    // 开发环境可以打开开发者工具
    // fileManagerWindow.webContents.openDevTools()
  } else {
    fileManagerWindow.loadFile(join(__dirname, '../dist/file-manager.html'))
  }

  // 在浏览器中打开外部链接
  fileManagerWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  fileManagerWindow.on('closed', () => {
    fileManagerWindow = null
    fileManagerParams = null
  })
}

// AI Debug 窗口
let aiDebugWindow: BrowserWindow | null = null

/**
 * 创建 AI Debug 窗口
 * 用于显示 AI 请求和响应的实时流水
 */
function createAiDebugWindow(): void {
  // 如果窗口已存在，聚焦
  if (aiDebugWindow && !aiDebugWindow.isDestroyed()) {
    aiDebugWindow.focus()
    return
  }

  // 根据平台选择图标
  const iconPath = process.platform === 'darwin'
    ? join(__dirname, '../resources/icon.icns')
    : process.platform === 'win32'
      ? join(__dirname, '../resources/icon.ico')
      : join(__dirname, '../resources/icon.png')

  aiDebugWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    minWidth: 600,
    minHeight: 400,
    title: t('window.aiDebug'),
    icon: iconPath,
    frame: true,
    show: false,
    backgroundColor: '#0d1117',
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  // 窗口准备好后显示
  aiDebugWindow.once('ready-to-show', () => {
    aiDebugWindow?.show()
  })

  // 加载 AI Debug 页面
  if (process.env.VITE_DEV_SERVER_URL) {
    aiDebugWindow.loadURL(`${process.env.VITE_DEV_SERVER_URL}ai-debug.html`)
    // 开发环境可以打开开发者工具
    // aiDebugWindow.webContents.openDevTools()
  } else {
    aiDebugWindow.loadFile(join(__dirname, '../dist/ai-debug.html'))
  }

  getAiDebugService().setDebugWindow(aiDebugWindow)

  // 在浏览器中打开外部链接
  aiDebugWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  aiDebugWindow.on('closed', () => {
    aiDebugWindow = null
    getAiDebugService().setDebugWindow(null)
  })
}

// 应用准备就绪
app.whenReady().then(async () => {
  log.info(`[startup] app.whenReady fired (+${Date.now() - APP_START_TIME}ms)`)

  ensureAgentWorkspaceDirs()

  // 数据目录迁移：必须在创建窗口、初始化 sensor/watch/agent 等一切重活之前执行。
  // 此刻源目录无任何运行时写入，复制数据保证一致；完成后会自动重启。
  const migrated = await runStartupMigrationIfNeeded()
  if (migrated) return // 已触发重启，停止后续初始化

  // Agent 历史格式迁移（v5）：拆分旧日文件为按会话单文件，带进度窗
  try {
    const startupMigrations = await getMigrationRunner().run('startup', {
      configService,
      userDataPath: app.getPath('userData'),
    })
    if (startupMigrations > 0) {
      historyService.rebuildAgentIndex()
    }
  } catch (e) {
    log.error('Startup migration failed:', e)
  }

  // sft-local:// 协议处理器：安全代理 userData/history/images/ 目录下的截图文件
  // URL 格式：sft-local://history-image/{dateStr}/{sessionId}/{filename}
  // 只允许访问 history/images/ 子目录，防止路径穿越
  protocol.handle('sft-local', (request) => {
    try {
      const url = new URL(request.url)
      if (url.host !== 'history-image') {
        return new Response('Not found', { status: 404 })
      }
      const segments = url.pathname.split('/').filter(Boolean)
      const imagesBase = path.join(app.getPath('userData'), 'history', 'images')
      const filePath = path.join(imagesBase, ...segments)
      // 安全检查：确保解析后路径仍在 images 目录内（防路径穿越）
      if (!filePath.startsWith(imagesBase + path.sep) && filePath !== imagesBase) {
        return new Response('Forbidden', { status: 403 })
      }
      return net.fetch(`file://${filePath}`)
    } catch {
      return new Response('Bad request', { status: 400 })
    }
  })

  // 设置媒体设备权限处理器（用于语音识别等功能）
  // Windows 上必须显式授权麦克风访问，否则会报 "Requested device not found"
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    // 允许麦克风、音频和剪贴板相关权限
    const allowedPermissions = ['media', 'microphone', 'audioCapture', 'clipboard-read', 'clipboard-write']
    if (allowedPermissions.includes(permission)) {
      callback(true)
    } else {
      callback(false)
    }
  })

  // 设置设备权限检查（用于 navigator.mediaDevices.enumerateDevices 等）
  session.defaultSession.setDevicePermissionHandler((details) => {
    // 允许音频输入设备访问
    if (details.deviceType === 'hid' || details.deviceType === 'serial') {
      return false
    }
    return true
  })

  // 初始化屏幕内容服务（轻量，可以同步初始化）
  initScreenContentService()

  // 浏览器助手网关（扩展 Native Messaging）
  initBrowserBridgeService().catch((e) => log.warn('Browser bridge init failed:', e))

  // 先创建窗口，让用户尽快看到界面
  createWindow()
  setupWindowServices()
  createTray()
  log.info(`[startup] window created & tray ready (+${Date.now() - APP_START_TIME}ms)`)

  // 首次启动检测：向导未完成时推迟重量级初始化（LanceDB / ONNX DLL 加载），
  // 防止 Windows 安全扫描同步阻塞主线程，导致向导界面卡死。
  // Steam 版无向导，视为已完成。
  const isFirstLaunch = !configService.getSetupCompleted() && !IS_STEAM_BUILD
  if (isFirstLaunch) {
    log.info('[startup] 首次启动：重量级初始化将在向导完成后执行，避免 Windows 上 UI 卡死')
    setupDonePromise = new Promise<void>(resolve => {
      resolveSetupDone = resolve
    })
  }

  // webContents 加载完成日志：观测渲染端首屏 paint 完成时间（重要的低配机器诊断点）
  mainWindow?.webContents.once('did-finish-load', () => {
    log.info(`[startup] webContents did-finish-load (+${Date.now() - APP_START_TIME}ms)`)
  })

  // 知识库需要等前端 Vue 组件挂载，优先走 did-finish-load
  let knowledgeInitDone = false
  mainWindow?.webContents.on('did-finish-load', () => {
    log.info('mainWindow did-finish-load fired')
    if (!knowledgeInitDone) {
      knowledgeInitDone = true
      const startKnowledge = async () => {
        if (isFirstLaunch) {
          // 首次启动：等向导完成后再加载重量级原生模块（LanceDB），
          // 避免 Windows 安全扫描同步阻塞主线程冻结向导 UI。
          log.info('[startup] 首次启动：等待向导完成后再初始化知识库')
          await setupDonePromise
          // 让 config:setSetupCompleted IPC 先返回渲染端，再开始重量级工作
          await new Promise<void>(r => setImmediate(r))
          await new Promise<void>(r => setTimeout(r, 500))
          log.info(`[startup] 首次启动：知识库初始化开始 (+${Date.now() - APP_START_TIME}ms)`)
        } else {
          await new Promise<void>(r => setTimeout(r, 500))
        }
        initKnowledgeService().catch(e => {
          log.error('知识库服务初始化失败:', e)
        })
      }
      startKnowledge()
    }
  })
  // 兜底：如果 did-finish-load 10s 内未触发，强制初始化（首次启动时同样等待向导完成）
  setTimeout(async () => {
    if (!knowledgeInitDone) {
      knowledgeInitDone = true
      log.warn('did-finish-load 未触发，兜底初始化知识库')
      if (isFirstLaunch) {
        await setupDonePromise
        await new Promise<void>(r => setImmediate(r))
      }
      initKnowledgeService().catch(e => {
        log.error('知识库服务初始化失败:', e)
      })
    }
  }, 10_000)

  // 后端服务初始化推迟启动：低配 Windows 上 webContents 首屏 paint 可能要 5~10s，
  // 后台同时启动 plugin/Watch/Sensor/IM/Gateway/邮箱日历/MCP 会严重抢占 CPU，
  // 把首屏渲染从"窗口出来后白屏 10+ 秒"恶化成"窗口都出不来"。
  //
  // 调度策略：
  // - 优先：窗口 ready-to-show 后再延迟 800ms 启动（高配 ~1.3s，给前端首屏 paint 留 CPU）
  // - 兜底：6s 内必启动（防止极端情况 ready-to-show 一直不触发，导致后端服务永不启动）
  let backendInitStarted = false
  let backendReadyTimer: NodeJS.Timeout | null = null
  let backendFallbackTimer: NodeJS.Timeout | null = null
  const clearBackendTimers = () => {
    if (backendReadyTimer) { clearTimeout(backendReadyTimer); backendReadyTimer = null }
    if (backendFallbackTimer) { clearTimeout(backendFallbackTimer); backendFallbackTimer = null }
  }
  const startBackendInit = (reason: string) => {
    if (backendInitStarted) return
    backendInitStarted = true
    clearBackendTimers()
    log.info(`[startup] backend init triggered (${reason}, +${Date.now() - APP_START_TIME}ms)`)
    const doBackendInit = async () => {
      if (isFirstLaunch) {
        // 首次启动：等向导完成后再启动后端服务（Watch/Sensor/IM/MCP 等），
        // 避免原生模块加载同步阻塞主线程冻结向导 UI。
        log.info('[startup] 首次启动：等待向导完成后再初始化后端服务')
        await setupDonePromise
        // 让 config:setSetupCompleted IPC 先返回渲染端，再开始重量级工作
        await new Promise<void>(r => setImmediate(r))
        await new Promise<void>(r => setTimeout(r, 1000))
        log.info(`[startup] 首次启动：后端服务初始化开始 (+${Date.now() - APP_START_TIME}ms)`)
      }
      runBackendInit().catch(e => {
        log.error('后端服务初始化失败:', e)
      })
    }
    doBackendInit()
  }
  mainWindow?.once('ready-to-show', () => {
    backendReadyTimer = setTimeout(() => startBackendInit('ready-to-show+800ms'), 800)
  })
  backendFallbackTimer = setTimeout(() => startBackendInit('timeout-fallback'), 6000)
  // 应用退出时清理未触发的 timer，避免 shutdown 期间启动后端服务
  app.once('before-quit', clearBackendTimers)

  /** 向渲染进程发送启动进度事件，用于诊断 Windows 无响应时卡在哪个阶段 */
  function sendStartupProgress(stage: string): void {
    try {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('startup:progress', { stage })
      }
    } catch { /* ignore */ }
  }

  async function runBackendInit() {
    log.info(`开始初始化后端服务 (+${Date.now() - APP_START_TIME}ms)`)

    // 初始化插件系统
    sendStartupProgress('plugins')
    try {
      await pluginRegistry.loadAll()
      // 注册插件 provider 到 AI 服务
      const pluginProviders = pluginRegistry.getAllProviders()
      if (pluginProviders.length > 0) {
        aiService.setPluginProviders(pluginProviders)
      }
      // 注册插件 TTS provider
      const pluginTtsProviders = pluginRegistry.getAllTtsProviders()
      if (pluginTtsProviders.length > 0) {
        const tts = await import('./services/tts')
        for (const p of pluginTtsProviders) tts.registerProvider(p)
      }
      // 注册插件 HTTP 路由到 Gateway
      const pluginRoutes = pluginRegistry.getAllHttpRoutes()
      if (pluginRoutes.length > 0) {
        gatewayService.registerPluginRoutes(pluginRoutes)
      }
      // 注册插件 IM channels
      const pluginChannels = pluginRegistry.getAllChannels()
      if (pluginChannels.length > 0) {
        const { getIMService } = require('./services/im/im.service')
        try {
          const imService = getIMService()
          for (const channel of pluginChannels) {
            const pluginConfig = configService.get('pluginsEntries')?.[channel.id]?.config || {}
            const adapter = channel.createAdapter(pluginConfig)
            imService.registerAdapter(adapter)
          }
        } catch { /* IM service may not be available */ }
      }
      log.info('插件系统初始化完成')
    } catch (e) {
      log.error('插件系统初始化失败:', e)
    }

    // 初始化 Web 搜索服务
    sendStartupProgress('webSearch')
    try {
      const webSearch = await import('./services/web-search/index')
      const webSearchSettings = configService.get('webSearchSettings')
      await webSearch.initWebSearch(webSearchSettings)
      log.info('Web search service initialized')
    } catch (e) {
      log.error('Web search service initialization failed:', e)
    }

    // 初始化定时任务调度服务
    sendStartupProgress('scheduler')
    try {
      schedulerService.init({
        ptyService,
        sshService,
        configService,
        agentService,
        mainWindow
      })
      schedulerService.start().catch(e => {
        log.error('定时任务调度服务启动失败:', e)
      })
    } catch (e) {
      log.error('定时任务调度服务初始化失败:', e)
    }

    // 初始化 Watch & Sensor 服务（感知层）
    sendStartupProgress('watchSensor')
    try {
      watchService.init({
        ptyService,
        sshService,
        configService,
        agentService,
        aiService,
        sensorService,
        historyService,
        mainWindow
      })
      watchService.start().catch(e => {
        log.error('Watch 服务启动失败:', e)
      })

      // Services phase migrations（需要后端服务就绪）
      sendStartupProgress('migration')
      try {
        await getMigrationRunner().run('services', {
          configService,
          userDataPath: app.getPath('userData'),
          hostProfileService,
          knowledgeService,
          watchService,
          schedulerStore: getSchedulerStore(),
          schedulerService,
        })
      } catch (e) {
        log.error('Services migration failed:', e)
      }

      const awakened = configService.get('agentAwakened') as boolean ?? false
      const heartbeatInterval = configService.get('watchHeartbeatInterval') as number ?? 30

      // 修复配置不同步：agentAwakened 与 watchHeartbeatEnabled 应保持一致
      if (awakened !== (configService.get('watchHeartbeatEnabled') as boolean ?? false)) {
        configService.set('watchHeartbeatEnabled', awakened)
      }

      // 启动传感器前，先把已保存的邮箱/日历账户注入传感器，否则 shouldAutoStart() 会因为 accounts 为空而跳过
      sensorService.email.setStatePath(app.getPath('userData'))
      try {
        const emailAccounts = (configService.get('emailAccounts' as any) || []) as Array<{
          id: string; email: string; provider: string; imapHost?: string; imapPort?: number; rejectUnauthorized?: boolean
        }>
        if (emailAccounts.length > 0) {
          const sensorAccounts = emailAccounts.map(a => {
            const server = getServerConfig(a.provider, { imapHost: a.imapHost, imapPort: a.imapPort })
            return { accountId: a.id, email: a.email, provider: a.provider, imapHost: server.imapHost, imapPort: server.imapPort, rejectUnauthorized: a.rejectUnauthorized }
          }).filter(a => a.imapHost)
          await sensorService.email.configureAccounts(sensorAccounts, (id) => getEmailCredential(id))
          log.info(`Email sensor: loaded ${sensorAccounts.length} account(s) from config`)
        }
      } catch (e) {
        log.error('Email sensor 账户加载失败:', e)
      }

      try {
        const calendarAccounts = (configService.get('calendarAccounts' as any) || []) as Array<{
          id: string; name: string; provider: string; username: string; serverUrl?: string
        }>
        if (calendarAccounts.length > 0) {
          const sensorAccounts = calendarAccounts.map(a => ({
            accountId: a.id, name: a.name, provider: a.provider, username: a.username, serverUrl: a.serverUrl
          }))
          await sensorService.calendar.configureAccounts(sensorAccounts, (id) => getCalendarCredential(id))
          log.info(`Calendar sensor: loaded ${sensorAccounts.length} account(s) from config`)
        }
      } catch (e) {
        log.error('Calendar sensor 账户加载失败:', e)
      }

      sendStartupProgress('sensors')
      sensorService.start({
        heartbeatEnabled: awakened,
        heartbeatIntervalMinutes: heartbeatInterval
      }).then(async () => {
        // 安全保障：如果觉醒模式开启但心跳未启动，强制启动
        if (awakened && !sensorService.heartbeat.running) {
          log.warn('觉醒模式已开启但心跳未启动，强制启动心跳')
          sensorService.heartbeat.setInterval(heartbeatInterval)
          await sensorService.heartbeat.start()
        }
      }).catch(e => {
        log.error('Sensor 服务启动失败:', e)
      })

      // AppLifecycleSensor.start() 是同步的，在 sensorService.start() 的 for 循环中已完成
      // 不能放在 .then() 里，因为 EmailSensor 的 IDLE 循环会阻塞 Promise.allSettled
      sensorService.appLifecycle.notifyAppStarted()

      // 觉醒模式：确保内置「唤醒」关切存在
      if (awakened) {
        try { watchService.ensureWakeup() } catch (e) {
          log.error('唤醒关切创建失败:', e)
        }
      }

      // 系统电源事件：休眠恢复
      powerMonitor.on('resume', () => {
        sensorService.appLifecycle.notifyResumed()
      })
    } catch (e) {
      log.error('Watch/Sensor 服务初始化失败:', e)
    }

    // 后端服务初始化完成
    sendStartupProgress('done')
    log.info(`后端服务初始化完成 (+${Date.now() - APP_START_TIME}ms)`)

    // Gateway 远程访问自动启动
    if (configService.get('gatewayAutoStart')) {
      const port = configService.get('gatewayPort') || 3721
      const host = configService.get('gatewayHost') || '0.0.0.0'
      gatewayService.start({ enabled: true, port, host, apiToken: '' }).then(result => {
        if (result.success) {
          log.info(`Gateway auto-started on ${host}:${port}`)
        } else {
          log.error('Gateway auto-start failed:', result.error)
        }
      }).catch(e => {
        log.error('Gateway auto-start error:', e)
      })
    }

    // IM 集成自动连接（每平台独立控制）
    if (configService.get('imDingTalkAutoConnect')) {
      const dtClientId = configService.get('imDingTalkClientId') as string
      const dtClientSecret = configService.get('imDingTalkClientSecret') as string
      if (dtClientId && dtClientSecret) {
        imService.startDingTalk({ enabled: true, clientId: dtClientId, clientSecret: dtClientSecret }).then(result => {
          if (result.success) {
            log.info('IM: DingTalk auto-connect started')
          } else {
            log.error('IM: DingTalk auto-connect failed:', result.error)
          }
        }).catch(e => log.error('IM: DingTalk auto-connect error:', e))
      }
    }
    if (configService.get('imFeishuAutoConnect')) {
      const fsAppId = configService.get('imFeishuAppId') as string
      const fsAppSecret = configService.get('imFeishuAppSecret') as string
      if (fsAppId && fsAppSecret) {
        imService.startFeishu({ enabled: true, appId: fsAppId, appSecret: fsAppSecret }).then(result => {
          if (result.success) {
            log.info('IM: Feishu auto-connect started')
          } else {
            log.error('IM: Feishu auto-connect failed:', result.error)
          }
        }).catch(e => log.error('IM: Feishu auto-connect error:', e))
      }
    }
    if (configService.get('imSlackAutoConnect')) {
      const slackBotToken = (configService.get('imSlackBotToken') as string) || ''
      const slackAppToken = (configService.get('imSlackAppToken') as string) || ''
      if (slackBotToken && slackAppToken) {
        imService.startSlack({ enabled: true, botToken: slackBotToken, appToken: slackAppToken }).then(result => {
          if (result.success) {
            log.info('IM: Slack auto-connect started')
          } else {
            log.error('IM: Slack auto-connect failed:', result.error)
          }
        }).catch(e => log.error('IM: Slack auto-connect error:', e))
      }
    }
    if (configService.get('imTelegramAutoConnect')) {
      const tgBotToken = (configService.get('imTelegramBotToken') as string) || ''
      if (tgBotToken) {
        imService.startTelegram({ enabled: true, botToken: tgBotToken }).then(result => {
          if (result.success) {
            log.info('IM: Telegram auto-connect started')
          } else {
            log.error('IM: Telegram auto-connect failed:', result.error)
          }
        }).catch(e => log.error('IM: Telegram auto-connect error:', e))
      }
    }
    if (configService.get('imWeComAutoConnect')) {
      const wcBotId = (configService.get('imWeComBotId') as string) || ''
      const wcSecret = (configService.get('imWeComSecret') as string) || ''
      if (wcBotId && wcSecret) {
        imService.startWeCom({ enabled: true, botId: wcBotId, secret: wcSecret }).then(result => {
          if (result.success) {
            log.info('IM: WeCom auto-connect started')
          } else {
            log.error('IM: WeCom auto-connect failed:', result.error)
          }
        }).catch(e => log.error('IM: WeCom auto-connect error:', e))
      }
    }
    if (configService.get('imWeChatAutoConnect')) {
      const wxToken = (configService.get('imWeChatToken') as string) || ''
      const wxBaseUrl = (configService.get('imWeChatBaseUrl') as string) || ''
      if (wxToken) {
        imService.startWeChat({ enabled: true, token: wxToken, baseUrl: wxBaseUrl }).then(result => {
          if (result.success) {
            log.info('IM: WeChat auto-connect started')
          } else {
            log.error('IM: WeChat auto-connect failed:', result.error)
          }
        }).catch(e => log.error('IM: WeChat auto-connect error:', e))
      }
    }
    log.info(`[startup] backend init finished (+${Date.now() - APP_START_TIME}ms)`)
  } // end of runBackendInit

  // 启动自动检查更新
  scheduleAutoUpdateCheck()

  // 处理缓存的深链 URL 队列（窗口就绪前收到的）
  mainWindow?.webContents.once('dom-ready', () => {
    if (pendingDeepLinkUrls.length > 0) {
      const urls = pendingDeepLinkUrls.splice(0)
      setTimeout(() => {
        urls.forEach(url => handleDeepLink(url))
      }, 300)
    }
  })

  app.on('activate', () => {
    showMainWindow()
  })

  // Windows/Linux: 第二个实例通过 argv 传递 URL
  app.on('second-instance', (_event, argv) => {
    showMainWindow()
    const deepLinkUrl = argv.find(arg => {
      try {
        return arg.startsWith('sailfish://') || decodeURIComponent(arg).startsWith('sailfish://')
      } catch {
        return false
      }
    })
    if (deepLinkUrl) {
      handleDeepLink(deepLinkUrl)
    }
  })
})

// 处理 Cmd+Q / 托盘退出
app.on('before-quit', (event) => {
  // 清理 macOS 防误触等待状态（托盘/Dock 退出时直接进入此流程）
  const hadPendingTimer = !!quitConfirmTimer
  if (quitConfirmTimer) {
    clearTimeout(quitConfirmTimer)
    quitConfirmTimer = null
    sendQuitToast(false)
  }

  isQuitting = true

  if (forceQuit) {
    return
  }

  // 用户已看过防误触提示（Cmd+Q 首次按下），此时托盘/Dock 再次退出视为明确确认
  // 跳过终端计数对话框，直接退出
  if (hadPendingTimer) {
    forceQuit = true
    return
  }
  
  // 窗口可能是隐藏状态，需要先显示再走确认流程
  if (mainWindow && !mainWindow.isDestroyed()) {
    event.preventDefault()
    if (process.platform === 'darwin') {
      app.dock?.show()
    }
    mainWindow.show()
    mainWindow.close()  // 触发窗口的 close 事件，走终端确认逻辑
  }
})

// 所有窗口关闭时的处理
// macOS 上 Cmd+W 只隐藏窗口不触发此事件；真正退出时由 before-quit 驱动
app.on('window-all-closed', async () => {
  await cleanupAllServices()
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// ==================== IPC 处理器 ====================

// PTY 相关
ipcMain.handle('pty:create', async (_event, options) => {
  // 等待 PATH 就绪后再创建终端
  await waitForPath()
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
  // 注意：不在此处 cleanupAgent。
  // Agent 实例归 tab 所有（agentKey = tabId），PTY 只是其当前操作的某个窗格。
  // 关闭窗格不应销毁 Agent。Agent cleanup 走独立的 'agent:cleanup' 入口（关 tab 时由前端触发）。
})

ipcMain.handle('pty:getAvailableShells', async () => {
  return ptyService.getAvailableShells()
})

// PTY 数据订阅的取消函数存储（防止重复订阅导致数据多次发送）
const ptyDataUnsubscribes = new Map<string, () => void>()

// PTY 数据输出 - 转发到渲染进程
ipcMain.on('pty:subscribe', (event, id: string) => {
  // 先取消旧的订阅，防止重复订阅导致数据多次发送
  const oldUnsubscribe = ptyDataUnsubscribes.get(id)
  if (oldUnsubscribe) {
    oldUnsubscribe()
    ptyDataUnsubscribes.delete(id)
  }

  const unsubscribe = ptyService.onData(id, (data: string) => {
    try {
      if (!event.sender.isDestroyed()) {
        event.sender.send(`pty:data:${id}`, data)
      }
      // 追踪本地终端输出（用于检测命令是否在运行）
      // 计算行数（包括 \n 和 \r 都算换行，适用于 curl 进度条等）
      const lineCount = (data.match(/[\n\r]/g) || []).length
      terminalAwarenessService.trackOutput(id, lineCount, data.length)
    } catch (e) {
      // 忽略发送错误（窗口可能已关闭）
    }
  })
  ptyDataUnsubscribes.set(id, unsubscribe)
})

// SSH 相关
ipcMain.handle('ssh:connect', async (_event, config) => {
  try {
    return await sshService.connect(config)
  } catch (err) {
    throw new Error(err instanceof Error ? err.message : String(err))
  }
})

ipcMain.handle('ssh:write', async (_event, id: string, data: string) => {
  sshService.write(id, data)
})

ipcMain.handle('ssh:resize', async (_event, id: string, cols: number, rows: number) => {
  sshService.resize(id, cols, rows)
})

ipcMain.handle('ssh:disconnect', async (_event, id: string) => {
  // 清理订阅
  const unsubscribe = sshDataUnsubscribes.get(id)
  if (unsubscribe) {
    unsubscribe()
    sshDataUnsubscribes.delete(id)
  }
  const disconnectUnsub = sshDisconnectUnsubscribes.get(id)
  if (disconnectUnsub) {
    disconnectUnsub()
    sshDisconnectUnsubscribes.delete(id)
  }
  sshService.disconnect(id)
  // 注意：不在此处 cleanupAgent，原因同 pty:dispose。
})

// SSH 数据订阅的取消函数存储
const sshDataUnsubscribes = new Map<string, () => void>()
// SSH 断开连接订阅的取消函数存储
const sshDisconnectUnsubscribes = new Map<string, () => void>()

ipcMain.on('ssh:subscribe', (event, id: string) => {
  // 先取消旧的订阅，防止重复订阅导致数据多次发送
  const oldDataUnsubscribe = sshDataUnsubscribes.get(id)
  if (oldDataUnsubscribe) {
    oldDataUnsubscribe()
    sshDataUnsubscribes.delete(id)
  }
  const oldDisconnectUnsubscribe = sshDisconnectUnsubscribes.get(id)
  if (oldDisconnectUnsubscribe) {
    oldDisconnectUnsubscribe()
    sshDisconnectUnsubscribes.delete(id)
  }

  // 注册数据回调
  const dataUnsubscribe = sshService.onData(id, (data: string) => {
    try {
      if (!event.sender.isDestroyed()) {
        event.sender.send(`ssh:data:${id}`, data)
      }
      // 追踪 SSH 终端输出（用于检测命令是否在运行）
      // 计算行数（包括 \n 和 \r 都算换行，适用于 curl 进度条等）
      const lineCount = (data.match(/[\n\r]/g) || []).length
      terminalAwarenessService.trackOutput(id, lineCount, data.length)
    } catch (e) {
      // 忽略发送错误（窗口可能已关闭）
    }
  })
  sshDataUnsubscribes.set(id, dataUnsubscribe)

  // 注册断开连接回调，通知前端
  const disconnectUnsubscribe = sshService.onDisconnect(id, (disconnectEvent) => {
    try {
      if (!event.sender.isDestroyed()) {
        event.sender.send(`ssh:disconnected:${id}`, {
          reason: disconnectEvent.reason,
          error: disconnectEvent.error?.message
        })
      }
    } catch (e) {
      // 忽略发送错误
    }
    // 清理订阅
    sshDataUnsubscribes.delete(id)
    sshDisconnectUnsubscribes.delete(id)
    // 注意：SSH 被动断开不再 cleanupAgent；Agent 归 tab 所有，由 tab 关闭走 'agent:cleanup' 触发。
  })
  sshDisconnectUnsubscribes.set(id, disconnectUnsubscribe)
})

// SSH 取消订阅
ipcMain.on('ssh:unsubscribe', (_event, id: string) => {
  const dataUnsubscribe = sshDataUnsubscribes.get(id)
  if (dataUnsubscribe) {
    dataUnsubscribe()
    sshDataUnsubscribes.delete(id)
  }
  const disconnectUnsubscribe = sshDisconnectUnsubscribes.get(id)
  if (disconnectUnsubscribe) {
    disconnectUnsubscribe()
    sshDisconnectUnsubscribes.delete(id)
  }
})

// ==================== 终端状态服务 ====================

// 初始化终端状态
ipcMain.handle('terminalState:init', async (_event, id: string, type: 'local' | 'ssh', initialCwd?: string) => {
  terminalStateService.initTerminal(id, type, initialCwd)
})

// 移除终端状态
ipcMain.handle('terminalState:remove', async (_event, id: string) => {
  terminalStateService.removeTerminal(id)
})

// 获取终端状态
ipcMain.handle('terminalState:get', async (_event, id: string): Promise<TerminalState | undefined> => {
  return terminalStateService.getState(id)
})

// 获取当前工作目录
ipcMain.handle('terminalState:getCwd', async (_event, id: string): Promise<string> => {
  return terminalStateService.getCwd(id)
})

// 刷新 CWD（强制刷新，用于打开文件管理器等场景）
ipcMain.handle('terminalState:refreshCwd', async (_event, id: string): Promise<string> => {
  // 使用 'command' trigger 绕过时间间隔检查，强制获取最新 CWD
  return terminalStateService.refreshCwd(id, 'command')
})

// 手动更新 CWD
ipcMain.handle('terminalState:updateCwd', async (_event, id: string, newCwd: string) => {
  terminalStateService.updateCwd(id, newCwd)
})

// 处理用户输入（追踪可能的 CWD 变化）
ipcMain.handle('terminalState:handleInput', async (_event, id: string, input: string) => {
  terminalStateService.handleInput(id, input)
})

// 获取终端空闲状态
ipcMain.handle('terminalState:getIdleState', async (_event, id: string): Promise<boolean> => {
  const state = terminalStateService.getState(id)
  return state?.isIdle ?? true
})

// ==================== 命令执行追踪 ====================

// 开始追踪命令执行
ipcMain.handle('terminalState:startExecution', async (
  _event, 
  id: string, 
  command: string,
  options?: { source?: 'user' | 'agent'; agentStepTitle?: string }
): Promise<CommandExecution | null> => {
  return terminalStateService.startCommandExecution(id, command, options)
})

// 追加命令输出
ipcMain.handle('terminalState:appendOutput', async (_event, id: string, output: string) => {
  terminalStateService.appendCommandOutput(id, output)
})

// 完成命令执行
ipcMain.handle('terminalState:completeExecution', async (
  _event,
  id: string,
  exitCode?: number,
  status?: 'completed' | 'failed' | 'timeout' | 'cancelled'
): Promise<CommandExecution | null> => {
  return terminalStateService.completeCommandExecution(id, exitCode, status)
})

// 获取当前正在执行的命令
ipcMain.handle('terminalState:getCurrentExecution', async (_event, id: string): Promise<CommandExecution | undefined> => {
  return terminalStateService.getCurrentExecution(id)
})

// 获取命令执行历史
ipcMain.handle('terminalState:getExecutionHistory', async (_event, id: string, limit?: number): Promise<CommandExecution[]> => {
  return terminalStateService.getExecutionHistory(id, limit)
})

// 获取最后一次命令执行
ipcMain.handle('terminalState:getLastExecution', async (_event, id: string): Promise<CommandExecution | undefined> => {
  return terminalStateService.getLastExecution(id)
})

// 清除命令执行历史
ipcMain.handle('terminalState:clearExecutionHistory', async (_event, id: string) => {
  terminalStateService.clearExecutionHistory(id)
})

// ==================== 终端感知服务 ====================

// 获取终端感知状态（综合分析）
ipcMain.handle('terminalAwareness:getAwareness', async (_event, ptyId: string): Promise<TerminalAwareness> => {
  return terminalAwarenessService.getAwareness(ptyId)
})

// 追踪输出（用于输出速率计算）
ipcMain.handle('terminalAwareness:trackOutput', async (_event, ptyId: string, lineCount: number) => {
  terminalAwarenessService.trackOutput(ptyId, lineCount)
})

// 获取终端可视区域内容
ipcMain.handle('terminalAwareness:getVisibleContent', async (_event, ptyId: string): Promise<string[] | null> => {
  return terminalAwarenessService.getVisibleContent(ptyId)
})

// 检查是否可以执行命令
ipcMain.handle('terminalAwareness:canExecute', async (_event, ptyId: string): Promise<boolean> => {
  return terminalAwarenessService.canExecute(ptyId)
})

// 获取执行命令前的建议
ipcMain.handle('terminalAwareness:getPreExecutionAdvice', async (_event, ptyId: string, command: string) => {
  return terminalAwarenessService.getPreExecutionAdvice(ptyId, command)
})

// 清理终端感知数据
ipcMain.handle('terminalAwareness:clear', async (_event, ptyId: string) => {
  terminalAwarenessService.clearTerminal(ptyId)
})

// AI 相关
ipcMain.handle('ai:chat', async (_event, messages, profileId?: string) => {
  return aiService.chat(messages, profileId)
})

ipcMain.handle('ai:testApiKey', async (_event, profile) => {
  return aiService.testApiKey(profile)
})

ipcMain.handle('ai:fetchModels', async (_event, profile) => {
  return aiService.fetchModels(profile)
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

// 应用信息
ipcMain.handle('app:getVersion', async () => {
  return APP_VERSION
})

ipcMain.handle('app:getMessagingDocsPath', async () => {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'docs', 'messaging')
  }
  return path.join(__dirname, '..', 'docs', 'messaging')
})

// 打开路径（文件或目录）
// resolveOpenablePath: 展开 `~` + 反转义 shell 转义符（如 `Application\ Support`）
// Agent 工具卡片可能传入这两种形式，Electron shell.openPath 都不直接支持
ipcMain.handle('shell:openPath', async (_event, targetPath: string) => {
  return shell.openPath(resolveOpenablePath(targetPath))
})

// 在文件管理器中显示文件（文件不存在时 fallback 到打开父目录）
ipcMain.handle('shell:showItemInFolder', async (_event, fullPath: string) => {
  const resolved = resolveOpenablePath(fullPath)
  if (fs.existsSync(resolved)) {
    shell.showItemInFolder(resolved)
  } else {
    const dir = path.dirname(resolved)
    if (dir && fs.existsSync(dir)) {
      await shell.openPath(dir)
    }
  }
})

// 弹原生"保存为"对话框写入图片到磁盘。
// 由前端预先把图片渲染成多种格式的 buffer/text 一起传过来；
// 用户在原生对话框里选格式（PNG/JPG/SVG），主进程按选定的扩展名挑对应数据写盘。
//
// 入参契约：
//   defaultName: 不带扩展名的默认文件名，如 'chart-1730000000000'
//   filters: 文件类型选项数组（顺序 = 优先级，第一项默认）
//     每项 { label: 'PNG (推荐)', extensions: ['png'] }
//   buffers: { png?: ArrayBuffer, jpg?: ArrayBuffer, svg?: string, ... }
//     key 必须等于对应 extensions[0]（jpeg 统一用 jpg）
//
// 返回 { saved: boolean, filePath?, filename? }；用户取消时 saved=false。
ipcMain.handle('image:saveWithDialog', async (event, payload: {
  defaultName: string
  filters: Array<{ label: string; extensions: string[] }>
  buffers: Record<string, ArrayBuffer | Uint8Array | string>
}) => {
  const win = BrowserWindow.fromWebContents(event.sender) ?? mainWindow
  if (!win) throw new Error('image:saveWithDialog: no parent window')
  if (!payload.filters?.length) throw new Error('image:saveWithDialog: filters required')

  const defaultExt = payload.filters[0].extensions[0]
  const result = await dialog.showSaveDialog(win, {
    defaultPath: `${payload.defaultName}.${defaultExt}`,
    filters: payload.filters.map(f => ({ name: f.label, extensions: f.extensions }))
  })
  if (result.canceled || !result.filePath) return { saved: false }

  // jpeg → jpg 归一，方便用 buffers 字典查找
  const rawExt = path.extname(result.filePath).toLowerCase().replace('.', '')
  const ext = rawExt === 'jpeg' ? 'jpg' : rawExt
  const data = payload.buffers[ext]
  if (data === undefined) {
    throw new Error(`image:saveWithDialog: no buffer provided for extension ".${rawExt}"`)
  }

  let bytes: Buffer
  if (typeof data === 'string') {
    bytes = Buffer.from(data, 'utf-8')
  } else if (Buffer.isBuffer(data)) {
    bytes = data
  } else if (data instanceof Uint8Array) {
    bytes = Buffer.from(data)
  } else {
    bytes = Buffer.from(new Uint8Array(data))
  }

  await fs.promises.writeFile(result.filePath, bytes)
  return { saved: true, filePath: result.filePath, filename: path.basename(result.filePath) }
})

// 写入图片到系统剪贴板。前端把图片渲染成 PNG buffer 传过来，
// 走 Electron 原生 clipboard 模块——绕开浏览器 navigator.clipboard.write
// 在 document focus / Permissions Policy 上的各种限制（Cmd+C 触发时常报
// "Write permission denied"）。
ipcMain.handle('clipboard:writeImage', async (_event, payload: ArrayBuffer | Uint8Array) => {
  const buf = Buffer.isBuffer(payload)
    ? payload
    : payload instanceof Uint8Array
      ? Buffer.from(payload)
      : Buffer.from(new Uint8Array(payload))
  const img = nativeImage.createFromBuffer(buf)
  if (img.isEmpty()) {
    throw new Error('clipboard:writeImage received unrecognizable image buffer')
  }
  clipboard.writeImage(img)
})

// PATH 环境变量状态
ipcMain.handle('path:isReady', async () => {
  return isPathReady()
})

ipcMain.handle('path:waitReady', async () => {
  await waitForPath()
  return true
})

// 关闭当前窗口
ipcMain.handle('window:close', async () => {
  mainWindow?.close()
})

// 查询当前窗口是否处于全屏（用于渲染端初始化时读取状态）
ipcMain.handle('window:isFullScreen', async () => {
  if (!mainWindow || mainWindow.isDestroyed()) return false
  return mainWindow.isFullScreen()
})

// 响应终端数量查询，决定是否需要确认退出
ipcMain.on('window:terminalCountResponse', (_event, terminalCount: number) => {
  const n = typeof terminalCount === 'number' && !Number.isNaN(terminalCount) ? terminalCount : 0
  void proceedQuitAfterTerminalCount(n)
})

// 强制退出（跳过确认）
ipcMain.handle('window:forceQuit', async () => {
  forceQuit = true
  mainWindow?.close()
})

// Windows 焦点恢复：渲染进程检测到输入元素无法接收键盘事件时，主动请求 webContents 获得焦点
ipcMain.on('window:focusWebContents', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.focus()
  }
})

// ==================== Windows 自绘标题栏控制 ====================
// frame:false 后窗口没有原生 min/max/close，渲染端 WindowControls 通过这些 IPC 操作窗口。
// macOS / Linux 走原生标题栏，不会调用这些 IPC，调到了也安全（仅作用于 mainWindow）。

ipcMain.on('window:minimize', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.minimize()
})

ipcMain.on('window:toggleMaximize', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMaximized()) {
    mainWindow.unmaximize()
  } else {
    mainWindow.maximize()
  }
})

// 渲染端初始化时查询当前最大化状态，避免按钮图标错位
ipcMain.handle('window:isMaximized', async () => {
  if (!mainWindow || mainWindow.isDestroyed()) return false
  return mainWindow.isMaximized()
})

// frame:false 下 Electron 不会绘制原生菜单栏，渲染端的汉堡按钮通过此 IPC
// 唤起 menuService 注册的应用菜单（role/accelerator/勾选状态全部由 Electron 处理）。
// 坐标 x/y 是渲染端按钮在窗口客户区内的坐标，由前端通过 getBoundingClientRect 提供。
ipcMain.on('window:popupAppMenu', (_event, position?: { x: number; y: number }) => {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const menu = Menu.getApplicationMenu()
  if (!menu) return
  // 不传坐标时让 Electron 在鼠标位置弹出（兼容键盘快捷键唤起场景）
  if (position && Number.isFinite(position.x) && Number.isFinite(position.y)) {
    menu.popup({ window: mainWindow, x: Math.round(position.x), y: Math.round(position.y) })
  } else {
    menu.popup({ window: mainWindow })
  }
})

// ==================== 自动更新 ====================

// 配置自动更新
autoUpdater.autoDownload = false
autoUpdater.autoInstallOnAppQuit = false

// 更新源定义
type UpdateSource = 'github' | 'oss'

const GITHUB_FEED: GithubOptions = {
  provider: 'github',
  owner: 'ysyx2008',
  repo: 'SailFish',
}

const OSS_FEED: GenericServerOptions = {
  provider: 'generic',
  url: 'https://sfterm-download.oss-cn-wuhan-lr.aliyuncs.com/releases/',
  channel: 'latest',
}

const UPDATE_SOURCE_LABELS: Record<UpdateSource, { zh: string; en: string }> = {
  github: { zh: 'GitHub（国际）', en: 'GitHub (Global)' },
  oss: { zh: '阿里云（国内加速）', en: 'Alibaba Cloud (China)' },
}

const CHINA_TIMEZONES = new Set([
  'Asia/Shanghai', 'Asia/Chongqing', 'Asia/Urumqi', 'Asia/Harbin',
  'Asia/Hong_Kong', 'Asia/Macau',
])

function isLikelyChinaTimezone(): boolean {
  try {
    return CHINA_TIMEZONES.has(Intl.DateTimeFormat().resolvedOptions().timeZone)
  } catch {
    return false
  }
}

async function measureLatency(url: string, timeoutMs = 5000): Promise<number> {
  const { net } = await import('electron')
  return new Promise<number>((resolve) => {
    const start = Date.now()
    const request = net.request({ url, method: 'HEAD' })
    const timer = setTimeout(() => { request.abort(); resolve(Infinity) }, timeoutMs)
    request.on('response', () => { clearTimeout(timer); resolve(Date.now() - start) })
    request.on('error', () => { clearTimeout(timer); resolve(Infinity) })
    request.end()
  })
}

const LATENCY_FILE = process.platform === 'darwin' ? 'latest-mac.yml'
  : process.platform === 'win32' ? 'latest.yml'
  : 'latest-linux.yml'

async function selectFastestSource(): Promise<{ recommended: UpdateSource; latency: Record<UpdateSource, number> }> {
  const [githubLatency, ossLatency] = await Promise.all([
    measureLatency(`https://github.com/ysyx2008/SailFish/releases/latest/download/${LATENCY_FILE}`),
    measureLatency(`https://sfterm-download.oss-cn-wuhan-lr.aliyuncs.com/releases/${LATENCY_FILE}`),
  ])

  log.info(`AutoUpdater: 测速 — GitHub: ${githubLatency}ms, OSS: ${ossLatency}ms`)

  const latency: Record<UpdateSource, number> = { github: githubLatency, oss: ossLatency }

  if (ossLatency === Infinity && githubLatency === Infinity) {
    return { recommended: isLikelyChinaTimezone() ? 'oss' : 'github', latency }
  }
  if (ossLatency === Infinity) return { recommended: 'github', latency }
  if (githubLatency === Infinity) return { recommended: 'oss', latency }

  const recommended: UpdateSource = ossLatency < githubLatency * 0.8 ? 'oss'
    : githubLatency < ossLatency * 0.8 ? 'github'
    : isLikelyChinaTimezone() ? 'oss' : 'github'

  return { recommended, latency }
}

function applyUpdateSource(source: UpdateSource) {
  autoUpdater.setFeedURL(source === 'oss' ? OSS_FEED : GITHUB_FEED)
  log.info(`AutoUpdater: 使用更新源: ${source}`)
}

let currentUpdateSource: UpdateSource = 'github'
let lastSpeedTestResult: { recommended: UpdateSource; latency: Record<UpdateSource, number> } | null = null
/** 用户选择「退出时安装」后为 true，退出时由 electron-updater 安装已下载更新 */
let pendingInstallOnQuit = false

function syncAutoInstallOnAppQuit(): void {
  const installOnQuitEnabled = configService?.get('installUpdateOnQuit') ?? true
  autoUpdater.autoInstallOnAppQuit = pendingInstallOnQuit && installOnQuitEnabled
}

function resetPendingInstallOnQuit(): void {
  pendingInstallOnQuit = false
  syncAutoInstallOnAppQuit()
}

// 更新状态
let updateStatus: {
  status: 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error'
  info?: {
    version?: string
    releaseNotes?: string
    releaseDate?: string
  }
  progress?: {
    percent: number
    bytesPerSecond: number
    total: number
    transferred: number
  }
  error?: string
  sources?: {
    current: UpdateSource
    recommended: UpdateSource
    latency: Record<UpdateSource, number>
    labels: Record<UpdateSource, { zh: string; en: string }>
  }
} = { status: 'idle' }

// 自动更新事件处理
autoUpdater.on('checking-for-update', () => {
  log.info('AutoUpdater: 正在检查更新...')
  updateStatus = { status: 'checking' }
  mainWindow?.webContents.send('updater:status-changed', updateStatus)
  menuService.setUpdateStatus('checking')
})

autoUpdater.on('update-available', (info) => {
  log.info('AutoUpdater: 发现新版本:', info.version)
  resetPendingInstallOnQuit()
  updateStatus = {
    status: 'available',
    info: {
      version: info.version,
      releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes : undefined,
      releaseDate: info.releaseDate
    },
    ...(lastSpeedTestResult && {
      sources: {
        current: currentUpdateSource,
        recommended: lastSpeedTestResult.recommended,
        latency: lastSpeedTestResult.latency,
        labels: UPDATE_SOURCE_LABELS,
      }
    })
  }
  mainWindow?.webContents.send('updater:status-changed', updateStatus)
  menuService.setUpdateStatus('available')

  // 静默自动更新：自动下载
  if (configService?.get('autoDownloadUpdate')) {
    log.info('AutoUpdater: 静默模式，自动开始下载')
    autoUpdater.downloadUpdate().catch(err => {
      log.warn('AutoUpdater: 自动下载失败:', err)
    })
  }
})

autoUpdater.on('update-not-available', () => {
  log.info('AutoUpdater: 当前已是最新版本')
  updateStatus = { status: 'not-available' }
  mainWindow?.webContents.send('updater:status-changed', updateStatus)
  menuService.setUpdateStatus('not-available')
})

autoUpdater.on('download-progress', (progress) => {
  log.info(`AutoUpdater: 下载进度: ${progress.percent.toFixed(1)}%`)
  updateStatus = {
    status: 'downloading',
    progress: {
      percent: progress.percent,
      bytesPerSecond: progress.bytesPerSecond,
      total: progress.total,
      transferred: progress.transferred
    }
  }
  mainWindow?.webContents.send('updater:status-changed', updateStatus)
  menuService.setUpdateStatus('downloading')
})

autoUpdater.on('update-downloaded', (info) => {
  log.info('AutoUpdater: 更新下载完成:', info.version)
  resetPendingInstallOnQuit()
  updateStatus = {
    status: 'downloaded',
    info: {
      version: info.version,
      releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes : undefined,
      releaseDate: info.releaseDate
    }
  }
  mainWindow?.webContents.send('updater:status-changed', updateStatus)
  menuService.setUpdateStatus('downloaded')
})

autoUpdater.on('error', (error) => {
  log.error('AutoUpdater: 更新错误:', error)
  updateStatus = {
    status: 'error',
    error: error.message || t('error.unknown')
  }
  mainWindow?.webContents.send('updater:status-changed', updateStatus)
  menuService.setUpdateStatus('error')
})

// 检查更新核心逻辑（含测速选源），供 IPC handler 和自动检查共用
async function performUpdateCheck(): Promise<{ success: boolean; updateInfo?: any; error?: string }> {
  if (!app.isPackaged) {
    log.info('AutoUpdater: 开发模式，跳过检查')
    return { success: true }
  }

  updateStatus = { status: 'checking' }
  mainWindow?.webContents.send('updater:status-changed', updateStatus)
  menuService.setUpdateStatus('checking')

  const speedResult = await selectFastestSource()
  lastSpeedTestResult = speedResult
  currentUpdateSource = speedResult.recommended
  applyUpdateSource(currentUpdateSource)

  const result = await autoUpdater.checkForUpdates()
  return { success: true, updateInfo: result?.updateInfo }
}

// IPC: 手动检查更新
ipcMain.handle('updater:checkForUpdates', async () => {
  try {
    if (!app.isPackaged) {
      log.info('AutoUpdater: 开发模式，模拟检查更新')
      updateStatus = { status: 'checking' }
      mainWindow?.webContents.send('updater:status-changed', updateStatus)
      menuService.setUpdateStatus('checking')
      await new Promise(resolve => setTimeout(resolve, 1500))
      updateStatus = { status: 'not-available' }
      mainWindow?.webContents.send('updater:status-changed', updateStatus)
      menuService.setUpdateStatus('not-available')
      return { success: true, status: updateStatus }
    }
    return await performUpdateCheck()
  } catch (error) {
    log.error('AutoUpdater: 检查更新失败:', error)
    return { success: false, error: errMsg(error, 'error.checkUpdateFailed') }
  }
})

// 自动检查更新：启动后延迟检查 + 每 12 小时定期检查
const AUTO_CHECK_DELAY_MS = 60_000
const AUTO_CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000

function scheduleAutoUpdateCheck() {
  if (IS_STEAM_BUILD || !app.isPackaged) return

  const enabled = configService?.get('autoCheckUpdate') ?? true
  if (!enabled) {
    log.info('AutoUpdater: 自动检查更新已禁用')
    return
  }

  setTimeout(async () => {
    try {
      log.info('AutoUpdater: 启动后自动检查更新')
      await performUpdateCheck()
    } catch (error) {
      log.warn('AutoUpdater: 自动检查更新失败:', error)
    }
  }, AUTO_CHECK_DELAY_MS)

  setInterval(async () => {
    const stillEnabled = configService?.get('autoCheckUpdate') ?? true
    if (!stillEnabled) return
    if (updateStatus.status === 'downloading' || updateStatus.status === 'downloaded') return

    try {
      log.info('AutoUpdater: 定期自动检查更新')
      await performUpdateCheck()
    } catch (error) {
      log.warn('AutoUpdater: 定期检查更新失败:', error)
    }
  }, AUTO_CHECK_INTERVAL_MS)
}

// 切换更新源（用户手动选择）
ipcMain.handle('updater:setSource', async (_event, source: UpdateSource) => {
  if (source !== 'github' && source !== 'oss') return { success: false, error: t('error.invalidSource') }
  currentUpdateSource = source
  applyUpdateSource(source)
  if (updateStatus.sources) {
    updateStatus.sources.current = source
    mainWindow?.webContents.send('updater:status-changed', updateStatus)
  }
  return { success: true }
})

// 下载更新（支持指定源，失败自动回退到另一个源）
ipcMain.handle('updater:downloadUpdate', async (_event, preferredSource?: UpdateSource) => {
  try {
    if (!app.isPackaged) {
      log.info('AutoUpdater: 开发模式，模拟下载更新')
      return { success: false, error: t('error.devModeNoDownload') }
    }

    if (preferredSource && (preferredSource === 'github' || preferredSource === 'oss')) {
      currentUpdateSource = preferredSource
      applyUpdateSource(preferredSource)
    }

    try {
      await autoUpdater.downloadUpdate()
      return { success: true, source: currentUpdateSource }
    } catch (primaryError) {
      const fallback: UpdateSource = currentUpdateSource === 'oss' ? 'github' : 'oss'
      log.warn(`AutoUpdater: ${currentUpdateSource} 下载失败，回退到 ${fallback}:`, primaryError)
      currentUpdateSource = fallback
      applyUpdateSource(fallback)

      if (updateStatus.sources) {
        updateStatus.sources.current = fallback
        mainWindow?.webContents.send('updater:status-changed', updateStatus)
      }

      await autoUpdater.downloadUpdate()
      return { success: true, source: fallback }
    }
  } catch (error) {
    log.error('AutoUpdater: 下载更新失败:', error)
    return { success: false, error: errMsg(error, 'error.downloadUpdateFailed') }
  }
})

// 安装更新并重启
ipcMain.handle('updater:quitAndInstall', async () => {
  try {
    resetPendingInstallOnQuit()
    // 安装前备份用户数据
    const version = app.getVersion()
    createBackup(app.getPath('userData'), `pre-update-v${version}`)

    // Windows：静默安装（与「退出时安装」一致），跳过 NSIS 安装模式选择页；initMultiUser 从注册表沿用 per-user/per-machine
    autoUpdater.quitAndInstall(process.platform === 'win32', true)
    return { success: true }
  } catch (error) {
    log.error('AutoUpdater: 安装更新失败:', error)
    return { success: false, error: errMsg(error, 'error.installUpdateFailed') }
  }
})

// 用户选择「退出时安装」：退出应用时再安装，不打断当前操作
ipcMain.handle('updater:deferInstall', async () => {
  if (updateStatus.status !== 'downloaded') {
    return { success: false, error: t('error.noDownloadedUpdate') }
  }
  pendingInstallOnQuit = true
  syncAutoInstallOnAppQuit()
  log.info('AutoUpdater: 已安排在退出时安装', updateStatus.info?.version)
  return { success: true }
})

ipcMain.handle('updater:isInstallDeferred', async () => ({
  deferred: pendingInstallOnQuit,
  version: updateStatus.info?.version,
}))

// 获取当前更新状态
ipcMain.handle('updater:getStatus', async () => {
  return updateStatus
})

// 配置相关
ipcMain.handle('config:get', async (_event, key: string) => {
  return configService.get(key as keyof typeof configService extends { get(key: infer K): unknown } ? K : never)
})

ipcMain.handle('config:set', async (_event, key: string, value: unknown) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  configService.set(key as any, value as any)
  if (key === 'installUpdateOnQuit' && value === false) {
    syncAutoInstallOnAppQuit()
  }
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

ipcMain.handle('config:hasVisionCapability', async () => {
  return configService.hasVisionCapability()
})

// SSH 会话配置
ipcMain.handle('config:getSshSessions', async () => {
  return configService.getSshSessions()
})

ipcMain.handle('config:setSshSessions', async (_event, sessions) => {
  configService.setSshSessions(sessions)
})

// 会话分组配置
ipcMain.handle('config:getSessionGroups', async () => {
  return configService.getSessionGroups()
})

ipcMain.handle('config:setSessionGroups', async (_event, groups) => {
  configService.setSessionGroups(groups)
})

// 主题配置
ipcMain.handle('config:getTheme', async () => {
  return configService.getTheme()
})

ipcMain.handle('config:setTheme', async (_event, theme: string) => {
  configService.setTheme(theme)
})

// UI 主题配置
ipcMain.handle('config:getUiTheme', async () => {
  return configService.getUiTheme()
})

ipcMain.handle('config:setUiTheme', async (_event, theme: string) => {
  configService.setUiTheme(theme as UiThemeName)
})

// UI 主题模式（manual / auto），auto 模式下跟随系统外观
ipcMain.handle('config:getUiThemeMode', async () => {
  return configService.getUiThemeMode()
})

ipcMain.handle('config:setUiThemeMode', async (_event, mode: string) => {
  configService.setUiThemeMode(mode as UiThemeMode)
})

// 系统当前外观（dark/light），用于 auto 模式下解析实际生效的主题
ipcMain.handle('system:getColorScheme', async () => {
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
})

// 系统外观切换时广播给所有渲染进程
nativeTheme.on('updated', () => {
  const scheme = nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('system:colorSchemeChanged', scheme)
    }
  }
})

// Agent MBTI 配置
ipcMain.handle('config:getAgentMbti', async () => {
  return configService.getAgentMbti()
})

ipcMain.handle('config:setAgentMbti', async (_event, mbti: string | null) => {
  configService.setAgentMbti(mbti as import('./services/config.service').AgentMbtiType)
})

// Agent 调试模式
ipcMain.handle('config:getAgentDebugMode', async () => {
  return configService.getAgentDebugMode()
})

ipcMain.handle('config:setAgentDebugMode', async (_event, enabled: boolean) => {
  configService.setAgentDebugMode(enabled)
})

// AI Debug 窗口
// 先移除可能已存在的 handlers（ai-debug.service.ts 中已注册了一些）
try { ipcMain.removeHandler('aiDebug:openWindow') } catch { /* ignore */ }
try { ipcMain.removeHandler('aiDebug:closeWindow') } catch { /* ignore */ }

ipcMain.handle('aiDebug:openWindow', async () => {
  createAiDebugWindow()
})

ipcMain.handle('aiDebug:closeWindow', async () => {
  if (aiDebugWindow && !aiDebugWindow.isDestroyed()) {
    aiDebugWindow.close()
  }
})

// 注意: aiDebug:isWindowOpen 已在 ai-debug.service.ts 中注册，这里不重复注册

// 首次设置向导
ipcMain.handle('config:getSetupCompleted', async () => {
  return configService.getSetupCompleted()
})

ipcMain.handle('config:setSetupCompleted', async (_event, completed: boolean) => {
  configService.setSetupCompleted(completed)
  // 首次启动：向导完成后触发延迟的重量级初始化（LanceDB / 后端服务）。
  // 用 setImmediate 让本次 IPC 先返回渲染端，再开始可能阻塞主线程的原生模块加载，
  // 保证渲染端能收到响应并继续执行 initializeApp()，不会在 await 处死等。
  if (completed && resolveSetupDone) {
    const trigger = resolveSetupDone
    resolveSetupDone = null
    log.info('[startup] 引导向导完成，将在下一 tick 触发延迟初始化')
    setImmediate(trigger)
  }
})

// Agent 诞生引导
ipcMain.handle('config:getAgentOnboardingCompleted', async () => {
  return configService.getAgentOnboardingCompleted()
})

// 语言设置
ipcMain.handle('config:getLanguage', async () => {
  return configService.getLanguage()
})

ipcMain.handle('config:setLanguage', async (_event, language: string) => {
  configService.setLanguage(language as import('./services/config.service').LocaleType)
  // 更新窗口标题以反映语言变化
  if (mainWindow) {
    mainWindow.setTitle(getAppTitle(language))
  }
  // 更新菜单栏语言
  menuService.updateMenu(language)
  updateMainI18nLocale(language.startsWith('zh') ? 'zh-CN' : 'en-US')
  updateTrayMenu()
})

// 快捷键变更时重建菜单
ipcMain.handle('config:setKeyboardShortcuts', async (_event, shortcuts: KeyboardShortcuts) => {
  if (!shortcuts || typeof shortcuts !== 'object') return
  const defaults = DEFAULT_KEYBOARD_SHORTCUTS
  const validKeys = Object.keys(defaults) as (keyof KeyboardShortcuts)[]
  const sanitized: KeyboardShortcuts = { ...defaults }
  for (const key of validKeys) {
    sanitized[key] = typeof shortcuts[key] === 'string' ? shortcuts[key] : defaults[key]
  }
  configService.set('keyboardShortcuts', sanitized)
  menuService.updateMenu(undefined, sanitized)
})

ipcMain.on('menu:setTerminalState', (_event, hasTerminal: boolean) => {
  menuService.setHasTerminal(Boolean(hasTerminal))
})

ipcMain.handle('config:getSponsorStatus', async () => {
  return configService.getSponsorStatus()
})

ipcMain.handle('config:setSponsorStatus', async (_event, status: boolean) => {
  configService.setSponsorStatus(status)
})

// 排序设置
ipcMain.handle('config:getSessionSortBy', async () => {
  return configService.getSessionSortBy()
})

ipcMain.handle('config:setSessionSortBy', async (_event, sortBy: string) => {
  configService.setSessionSortBy(sortBy as import('./services/config.service').SessionSortBy)
})

ipcMain.handle('config:getDefaultGroupSortOrder', async () => {
  return configService.getDefaultGroupSortOrder()
})

ipcMain.handle('config:setDefaultGroupSortOrder', async (_event, order: number) => {
  configService.setDefaultGroupSortOrder(order)
})

// 文件书签相关
ipcMain.handle('config:getFileBookmarks', async () => {
  return configService.getFileBookmarks()
})

ipcMain.handle('config:setFileBookmarks', async (_event, bookmarks) => {
  configService.setFileBookmarks(bookmarks)
})

ipcMain.handle('config:addFileBookmark', async (_event, bookmark) => {
  configService.addFileBookmark(bookmark)
})

ipcMain.handle('config:updateFileBookmark', async (_event, bookmark) => {
  configService.updateFileBookmark(bookmark)
})

ipcMain.handle('config:deleteFileBookmark', async (_event, id: string) => {
  configService.deleteFileBookmark(id)
})

ipcMain.handle('config:getLocalBookmarks', async () => {
  return configService.getLocalBookmarks()
})

ipcMain.handle('config:getRemoteBookmarks', async (_event, hostId?: string) => {
  return configService.getRemoteBookmarks(hostId)
})

// AI Rules 相关
ipcMain.handle('config:getAiRules', async () => {
  return configService.getAiRules()
})

ipcMain.handle('config:setAiRules', async (_event, rules: string) => {
  configService.setAiRules(rules)
})

// Agent 个性描述（legacy，保留兼容）
ipcMain.handle('config:getAgentPersonalityText', async () => {
  return configService.getAgentPersonalityText()
})

ipcMain.handle('config:setAgentPersonalityText', async (_event, text: string) => {
  configService.setAgentPersonalityText(text)
})

// Agent 身份文件（IDENTITY.md / SOUL.md / USER.md / HEARTBEAT.md）
ipcMain.handle('agent:readIdentityFile', async (_event, filename: string) => {
  switch (filename) {
    case 'IDENTITY.md': return readIdentityFile()
    case 'SOUL.md': return readSoulFile()
    case 'USER.md': return readUserFile()
    case 'HEARTBEAT.md': return readHeartbeatFile()
    default: return ''
  }
})

ipcMain.handle('agent:writeIdentityFile', async (_event, filename: string, content: string) => {
  const workspace = getWorkspacePath()
  fs.mkdirSync(workspace, { recursive: true })
  fs.writeFileSync(path.join(workspace, filename), content, 'utf-8')
})

// AI 名字
ipcMain.handle('config:getAgentName', async () => {
  return configService.getAgentName()
})

ipcMain.handle('config:setAgentName', async (_event, name: string) => {
  configService.setAgentName(name)
})

// AI 头像
ipcMain.handle('config:getAgentAvatar', async () => {
  return configService.getAgentAvatar()
})

ipcMain.handle('config:setAgentAvatar', async (_event, dataUrl: string) => {
  configService.setAgentAvatar(dataUrl)
})

// 日志级别
ipcMain.handle('config:getLogLevel', async () => {
  return configService.getLogLevel()
})

ipcMain.handle('config:setLogLevel', async (_event, level: string) => {
  const logLevel = level as import('./utils/logger').LogLevel
  configService.setLogLevel(logLevel)
  setBackendLogLevel(logLevel)
})

ipcMain.handle('config:getLogDir', async () => {
  return getLogDir()
})

ipcMain.handle('config:openLogDir', async () => {
  const logDir = getLogDir()
  if (logDir) {
    const { shell } = require('electron')
    shell.openPath(logDir)
  }
})

// ==================== 定时任务调度相关 ====================

ipcMain.handle('scheduler:getTasks', async () => {
  return schedulerService.getTasks()
})

ipcMain.handle('scheduler:getTask', async (_event, id: string) => {
  return schedulerService.getTask(id)
})

ipcMain.handle('scheduler:createTask', async (_event, params: CreateTaskParams) => {
  return schedulerService.createTask(params)
})

ipcMain.handle('scheduler:updateTask', async (_event, id: string, updates: Partial<CreateTaskParams>) => {
  return schedulerService.updateTask(id, updates)
})

ipcMain.handle('scheduler:deleteTask', async (_event, id: string) => {
  return schedulerService.deleteTask(id)
})

ipcMain.handle('scheduler:toggleTask', async (_event, id: string) => {
  return schedulerService.toggleTask(id)
})

ipcMain.handle('scheduler:runTask', async (_event, id: string) => {
  return schedulerService.runTask(id)
})

ipcMain.handle('scheduler:getHistory', async (_event, taskId?: string, limit?: number) => {
  return schedulerService.getHistory(taskId, limit)
})

ipcMain.handle('scheduler:clearHistory', async (_event, taskId?: string) => {
  return schedulerService.clearHistory(taskId)
})

ipcMain.handle('scheduler:getSshSessions', async () => {
  return schedulerService.getSshSessions()
})

ipcMain.handle('scheduler:isTaskRunning', async (_event, taskId: string) => {
  return schedulerService.isTaskRunning(taskId)
})

ipcMain.handle('scheduler:getRunningTasks', async () => {
  return schedulerService.getRunningTasks()
})

// ==================== Watch & Sensor IPC ====================

ipcMain.handle('watch:getAll', async () => {
  return watchService.getAll()
})

ipcMain.handle('watch:get', async (_event, id: string) => {
  return watchService.get(id)
})

ipcMain.handle('watch:create', async (_event, params: CreateWatchParams) => {
  return watchService.create(params)
})

ipcMain.handle('watch:update', async (_event, id: string, updates: Partial<CreateWatchParams>) => {
  return watchService.update(id, updates)
})

ipcMain.handle('watch:delete', async (_event, id: string) => {
  return watchService.delete(id)
})

ipcMain.handle('watch:toggle', async (_event, id: string) => {
  return watchService.toggle(id)
})

ipcMain.handle('watch:trigger', async (_event, id: string) => {
  // Fire-and-forget: 不阻塞前端等待执行完成，通过 IPC 事件推送状态
  watchService.triggerWatch(id).catch(e => {
    log.error('Watch trigger failed:', e)
  })
  return { triggered: true }
})

ipcMain.handle('watch:getHistory', async (_event, watchId?: string, limit?: number) => {
  return watchService.getHistory(watchId, limit)
})

ipcMain.handle('watch:clearHistory', async (_event, watchId?: string) => {
  return watchService.clearHistory(watchId)
})

ipcMain.handle('watch:isRunning', async (_event, id: string) => {
  return watchService.isWatchRunning(id)
})

ipcMain.handle('watch:getRunning', async () => {
  return watchService.getRunningWatches()
})

ipcMain.handle('watch:getSshSessions', async () => {
  return watchService.getSshSessions()
})

// Sensor 相关
ipcMain.handle('sensor:getStatus', async () => {
  return sensorService.getSensorStatus()
})

ipcMain.handle('sensor:getStatusDetailed', async () => {
  try {
    return sensorService.getSensorStatusDetailed()
  } catch (error) {
    log.error('sensor:getStatusDetailed', error)
    return sensorService.getSensorStatus()
  }
})

ipcMain.handle('sensor:getRecentEvents', async (_event, limit?: number) => {
  return sensorService.getRecentEvents(limit)
})

type AwakenedApplyResult = { awakened: boolean; intervalMinutes: number }

async function applyAwakenedState(awakened: boolean, intervalMinutes?: number): Promise<AwakenedApplyResult> {
  const validInterval = (intervalMinutes && intervalMinutes > 0 && intervalMinutes <= 1440)
    ? intervalMinutes
    : undefined

  // 先写配置，避免快速 OFF→ON 时后完成的 stop 覆盖 enable 结果
  configService.set('agentAwakened', awakened)
  configService.set('watchHeartbeatEnabled', awakened)
  if (validInterval) {
    configService.set('watchHeartbeatInterval', validInterval)
  }

  if (awakened) {
    if (validInterval) {
      sensorService.heartbeat.setInterval(validInterval)
    }
    await sensorService.heartbeat.start()
    // 如果 email/calendar sensor 已配置账户，跟随觉醒模式一起启动
    if (sensorService.email.shouldAutoStart() && !sensorService.email.running) {
      await sensorService.email.start()
    }
    if (sensorService.calendar.shouldAutoStart() && !sensorService.calendar.running) {
      await sensorService.calendar.start()
    }
    watchService.ensureWakeup()
  } else {
    await sensorService.heartbeat.stop()
    await sensorService.email.stop()
    await sensorService.calendar.stop()
    watchService.removeWakeup()
  }

  sensorService.appLifecycle.notifyAwakeningChanged(awakened)
  return { awakened, intervalMinutes: sensorService.heartbeat.getIntervalMinutes() }
}

let awakenedApplyChain: Promise<AwakenedApplyResult> = Promise.resolve({
  awakened: configService.get('agentAwakened') as boolean ?? false,
  intervalMinutes: configService.get('watchHeartbeatInterval') as number ?? 30,
})

function enqueueAwakenedApply(awakened: boolean, intervalMinutes?: number): Promise<AwakenedApplyResult> {
  const task = () => applyAwakenedState(awakened, intervalMinutes)
  awakenedApplyChain = awakenedApplyChain.then(task, task)
  return awakenedApplyChain
}

ipcMain.handle('sensor:setAwakened', async (_event, awakened: boolean, intervalMinutes?: number) => {
  return enqueueAwakenedApply(awakened, intervalMinutes)
})

// 向后兼容：旧的 setHeartbeat IPC，内部转发到 setAwakened 逻辑
ipcMain.handle('sensor:setHeartbeat', async (_event, enabled: boolean, intervalMinutes?: number) => {
  log.warn('[DEPRECATED] sensor:setHeartbeat 已废弃，请使用 sensor:setAwakened')
  return enqueueAwakenedApply(enabled, intervalMinutes)
})

ipcMain.handle('sensor:triggerHeartbeat', async () => {
  sensorService.heartbeat.beat()
  return { success: true }
})

// 羁绊系统
ipcMain.handle('bond:getMetrics', async () => {
  return bondService.calculate()
})

ipcMain.handle('bond:getMilestones', async () => {
  return bondService.getAllMilestones()
})

ipcMain.handle('bond:recalculate', async () => {
  const newMilestones = bondService.recalculate()
  return { metrics: bondService.calculate(), newMilestones }
})

// Watch 模板
ipcMain.handle('watch:getTemplates', async () => {
  return watchService.getTemplates().map(t => ({
    id: t.id,
    name: t.name,
    nameEn: t.nameEn,
    description: t.description,
    descriptionEn: t.descriptionEn,
    category: t.category,
    icon: t.icon
  }))
})

ipcMain.handle('watch:getTemplateCategories', async () => {
  return watchService.getTemplateCategories()
})

ipcMain.handle('watch:createFromTemplate', async (_event, templateId: string, options?: Record<string, unknown>) => {
  return watchService.createFromTemplate(templateId, options)
})

ipcMain.handle('watch:resetHeartbeat', async () => {
  return watchService.resetHeartbeatFile()
})

// Xshell 导入相关
ipcMain.handle('xshell:selectFiles', async () => {
  const result = await dialog.showOpenDialog({
    title: t('dialog.selectXshellFile'),
    filters: [
      { name: t('filter.xshellFiles'), extensions: ['xsh'] },
      { name: t('filter.allFiles'), extensions: ['*'] }
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
    title: t('dialog.selectXshellDir'),
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

ipcMain.handle('xshell:importDirectories', async (_event, dirPaths: string[]) => {
  return xshellImportService.importFromDirectories(dirPaths)
})

ipcMain.handle('xshell:scanDefaultPaths', async () => {
  return xshellImportService.scanDefaultPaths()
})

// ==================== Agent 相关 ====================

/**
 * 构建确认通知的 body 文本。
 * 优先用 displayName（已人类可读），否则从 toolArgs 提取关键内容字段，
 * 最后 fallback 到 toolName。
 */
function buildConfirmNotifBody(
  toolName: string,
  toolArgs: Record<string, unknown>,
  displayName?: string
): string {
  if (displayName) return displayName
  // 命令类工具：显示实际命令
  const cmd = typeof toolArgs.command === 'string' ? toolArgs.command : null
  if (cmd) return cmd.length > 80 ? cmd.slice(0, 80) + '…' : cmd
  // 文件类工具：显示路径
  const filePath = typeof toolArgs.path === 'string' ? toolArgs.path : (typeof toolArgs.file_path === 'string' ? toolArgs.file_path : null)
  if (filePath) return filePath
  return toolName
}

// 运行 Agent
ipcMain.handle('agent:run', async (event, { ptyId, message, context, config, profileId }: {
  ptyId: string  // 实际语义为 agentKey（终端 Agent = tabId）；字段名保留以兼容现有 IPC 协议。
  message: string
  context: AgentContext
  config?: object
  profileId?: string
}) => {
  // 从持久化配置读取 debugMode，合并到运行时配置
  const debugMode = configService.getAgentDebugMode()
  const fullConfig = { ...config, debugMode }

  // 创建回调函数，将 Agent 事件转发到渲染进程
  // 使用 JSON.parse(JSON.stringify()) 确保对象可序列化
  // 回调中的 ptyId 字段实际上是 agentKey（tabId），前端用它路由事件到对应 tab
  // 注意：回调作为参数传入 run()，每个 run 独立，解决多终端并发时回调覆盖问题
  const callbacks = {
    onStep: (agentId: string, step: AgentStep) => {
      if (!event.sender.isDestroyed()) {
        const serializedStep = serializeAgentStepForIpc(step)
        if (serializedStep) {
          event.sender.send('agent:step', { agentId, ptyId, step: serializedStep })
        }
      }
    },
    onStepRemoved: (agentId: string, stepId: string) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send('agent:stepRemoved', { agentId, ptyId, stepId })
      }
    },
    onNeedConfirm: (confirmation: PendingConfirmation) => {
      if (!event.sender.isDestroyed()) {
        // 只发送可序列化的字段，不包含 resolve 函数
        // agentId 用 tab agentKey（ptyId），便于前端多 tab 精确路由；勿用 confirmation.agentId（run.id）
        event.sender.send('agent:needConfirm', {
          agentId: ptyId,
          ptyId,
          toolCallId: confirmation.toolCallId,
          toolName: confirmation.toolName,
          toolArgs: JSON.parse(JSON.stringify(confirmation.toolArgs)),
          riskLevel: confirmation.riskLevel,
          displayName: confirmation.displayName
        })
      }
      // 任务栏/Dock 提醒 + 系统通知（仅在窗口不在前台时触发）
      const riskEmoji1 = confirmation.riskLevel === 'dangerous' ? '⚠️ ' : ''
      attentionService.request({
        title: `${riskEmoji1}${t('notification.confirmRequired', { appName: getAppName() })}`,
        body: buildConfirmNotifBody(confirmation.toolName, confirmation.toolArgs, confirmation.displayName)
      })
    },
    onNeedSecureInput: (request: import('./services/agent/types').PendingSecureInputInternal) => {
      if (!event.sender.isDestroyed()) {
        // 只发送可序列化的字段，不包含 resolve 函数
        event.sender.send('agent:needSecureInput', {
          agentId: request.agentId,
          ptyId,
          requestId: request.requestId,
          skillId: request.skillId,
          envName: request.envName,
          prompt: request.prompt,
          isUpdate: request.isUpdate
        })
      }
      attentionService.request({
        title: t('notification.apiKeyRequired', { appName: getAppName() }),
        body: t('notification.skillEnvBody', { envName: request.envName })
      })
    },
    onComplete: (agentId: string, result: string, pendingUserMessages?: string[]) => {
      const newBondMilestones = sensorService.appLifecycle.notifyConversationCompleted()
      if (!event.sender.isDestroyed()) {
        event.sender.send('agent:complete', {
          agentId,
          ptyId,
          result,
          pendingUserMessages,
          newBondMilestones,
          bondMetrics: bondService.calculate(),
        })
      }
      attentionService.request()
    },
    onError: (agentId: string, error: string) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send('agent:error', { agentId, ptyId, error })
      }
      attentionService.request()
    }
  }

  try {
    // 传入回调参数，确保每个 run 有独立的回调（解决多终端同时运行时步骤串台问题）
    const result = await agentService.run(ptyId, message, context, fullConfig, profileId, undefined, callbacks)
    return { success: true, result }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error'
    const isAborted = errorMsg === 'User aborted Agent execution'
    return { 
      success: false, 
      error: errorMsg,
      aborted: isAborted
    }
  }
})

// 中止 Agent（改用 ptyId）
ipcMain.handle('agent:abort', async (_event, ptyId: string) => {
  return agentService.abort(ptyId)
})

// 清空指定终端的任务历史记忆（用于"清空对话"功能）
// 只重置会话状态和记忆，保留 Agent 实例（避免销毁后重建的开销）
ipcMain.handle('agent:clearHistory', async (_event, ptyId: string) => {
  agentService.resetSession(ptyId)
})

// 确认工具调用（改用 ptyId）
ipcMain.handle('agent:confirm', async (_event, { ptyId, toolCallId, approved, modifiedArgs, alwaysAllow }: {
  ptyId: string
  toolCallId: string
  approved: boolean
  modifiedArgs?: Record<string, unknown>
  alwaysAllow?: boolean
}) => {
  return agentService.confirmToolCall(ptyId, toolCallId, approved, modifiedArgs, alwaysAllow)
})

// 解决安全输入请求（前端弹框用户完成输入后调用）
ipcMain.handle('agent:resolveSecureInput', async (_event, {
  ptyId, requestId, value, cancelled
}: {
  ptyId: string
  requestId: string
  value?: string
  cancelled?: boolean
}) => {
  if (cancelled || !value) {
    return agentService.resolveSecureInput(ptyId, requestId, false)
  }
  // 取出 pendingSecureInput 的 skillId/envName，直接存到加密存储（值不经过 LLM）
  const pending = agentService.getPendingSecureInput(ptyId)
  if (pending && pending.requestId === requestId) {
    await setSkillEnv(pending.skillId, pending.envName, value)
  }
  return agentService.resolveSecureInput(ptyId, requestId, true)
})

// ==================== 技能 env key 管理 IPC ====================

ipcMain.handle('skill:setEnv', async (_event, skillId: string, envName: string, value: string) => {
  await setSkillEnv(skillId, envName, value)
  return { success: true }
})

ipcMain.handle('skill:getEnvNames', async (_event, skillId: string) => {
  return listSkillEnvNames(skillId)
})

ipcMain.handle('skill:deleteEnv', async (_event, skillId: string, envName: string) => {
  const removed = await deleteSkillEnv(skillId, envName)
  return { success: removed }
})

ipcMain.handle('skill:getEnvStatus', async (_event, skillId: string) => {
  const { getUserSkillService } = await import('./services/user-skill.service')
  return getUserSkillService().getSkillEnvStatus(skillId)
})

// 获取 Agent 状态（改用 ptyId）
ipcMain.handle('agent:getStatus', async (_event, ptyId: string) => {
  return agentService.getRunStatus(ptyId)
})

// 获取 Agent 执行阶段状态（用于智能打断判断，改用 ptyId）
ipcMain.handle('agent:getExecutionPhase', async (_event, ptyId: string) => {
  return agentService.getExecutionPhase(ptyId)
})

// 清理 Agent 运行记录（改用 ptyId）
ipcMain.handle('agent:cleanup', async (_event, ptyId: string) => {
  agentService.cleanupAgent(ptyId)
})

// Fork Agent：从一个已存在的 Agent 会话分叉出新的助手 Agent（"另开一聊"）
ipcMain.handle('agent:fork', async (_event, opts: {
  sourceAgentKey: string
  newAgentId: string
  untilTaskCount?: number
  targetMode?: 'assistant'
  titleSuffix?: string
  sourceSessionId?: string
}) => {
  return await agentService.forkAgent(opts)
})

// 更新 Agent 配置（如执行模式、超时时间，改用 ptyId）
ipcMain.handle('agent:updateConfig', async (_event, ptyId: string, config: { executionMode?: ExecutionMode; commandTimeout?: number; profileId?: string }) => {
  return agentService.updateConfig(ptyId, config)
})

// 添加用户补充消息（Agent 执行过程中，改用 ptyId）
ipcMain.handle('agent:addMessage', async (_event, ptyId: string, message: string, attachments?: AttachmentInfo[], documentContext?: string, images?: string[]) => {
  return agentService.addUserMessage(ptyId, message, attachments, documentContext, images)
})

// 运行独立助手 Agent（无终端绑定）
// 注意：事件中使用前端传入的 agentId（如 assistant-<uuid>），而非后端 run.id，
// 因为独立助手没有 ptyId，前端依赖 agentId 匹配事件到正确的标签页。
ipcMain.handle('agent:runStandalone', async (event, { agentId, message, context, config, profileId }: {
  agentId: string
  message: string
  context: AgentContext
  config?: object
  profileId?: string
}) => {
  const debugMode = configService.getAgentDebugMode()
  const fullConfig = { ...config, debugMode }

  // WebChatService 已改为后端直驱，不再需要 runStandalone 转发
  // 但桌面用户仍可通过远程 tab UI 发送消息，此时需要同步事件到 WebChatService
  const wcs = getWebChatService()
  const isRemote = agentId === wcs.getAgentId()

  const callbacks = {
    onStep: (_runId: string, step: AgentStep) => {
      if (!event.sender.isDestroyed()) {
        const serializedStep = serializeAgentStepForIpc(step)
        if (serializedStep) {
          event.sender.send('agent:step', { agentId, ptyId: agentId, step: serializedStep })
        }
      }
      if (isRemote) wcs.onAgentStep(step)
    },
    onStepRemoved: (_runId: string, stepId: string) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send('agent:stepRemoved', { agentId, ptyId: agentId, stepId })
      }
    },
    onNeedConfirm: (confirmation: PendingConfirmation) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send('agent:needConfirm', {
          agentId,
          ptyId: agentId,
          toolCallId: confirmation.toolCallId,
          toolName: confirmation.toolName,
          toolArgs: JSON.parse(JSON.stringify(confirmation.toolArgs)),
          riskLevel: confirmation.riskLevel,
          displayName: confirmation.displayName
        })
      }
      // 任务栏/Dock 提醒 + 系统通知（仅在窗口不在前台时触发）
      const riskEmoji2 = confirmation.riskLevel === 'dangerous' ? '⚠️ ' : ''
      attentionService.request({
        title: `${riskEmoji2}${t('notification.confirmRequired', { appName: getAppName() })}`,
        body: buildConfirmNotifBody(confirmation.toolName, confirmation.toolArgs, confirmation.displayName)
      })
    },
    onNeedSecureInput: (request: import('./services/agent/types').PendingSecureInputInternal) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send('agent:needSecureInput', {
          agentId,
          ptyId: agentId,
          requestId: request.requestId,
          skillId: request.skillId,
          envName: request.envName,
          prompt: request.prompt,
          isUpdate: request.isUpdate
        })
      }
      attentionService.request({
        title: t('notification.apiKeyRequired', { appName: getAppName() }),
        body: t('notification.skillEnvBody', { envName: request.envName })
      })
    },
    onComplete: (_runId: string, result: string, pendingUserMessages?: string[]) => {
      const newBondMilestones = sensorService.appLifecycle.notifyConversationCompleted()
      if (!event.sender.isDestroyed()) {
        event.sender.send('agent:complete', {
          agentId,
          ptyId: agentId,
          result,
          pendingUserMessages,
          newBondMilestones,
          bondMetrics: bondService.calculate(),
        })
      }
      if (isRemote) wcs.onAgentComplete(result)
      // 远程会话由 Web 端用户在用，桌面用户没参与，不应打扰
      if (!isRemote) attentionService.request()
    },
    onError: (_runId: string, error: string) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send('agent:error', { agentId, ptyId: agentId, error })
      }
      if (isRemote) wcs.onAgentError(error)
      if (!isRemote) attentionService.request()
    }
  }

  try {
    const result = await agentService.runAssistant(agentId, message, context, fullConfig, profileId, callbacks)
    return { success: true, result }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error'
    const isAborted = errorMsg === 'User aborted Agent execution'
    if (isRemote) wcs.onAgentError(errorMsg)
    return {
      success: false,
      error: errorMsg,
      aborted: isAborted
    }
  }
})

// ==================== 远程会话共享服务 ====================

const webChatService = getWebChatService()
webChatService.setDependencies({
  agentService,
  configService,
  mainWindow: null
})

// ==================== Gateway 远程访问 ====================

const gatewayService = getGatewayService()
gatewayService.setDependencies({
  webChatService,
  mainWindow: null
})

ipcMain.handle('gateway:start', async (_event, config: GatewayConfig) => {
  const result = await gatewayService.start(config)
  if (result.success) {
    // 保存端口和监听地址到配置
    configService.set('gatewayPort', config.port || 3721)
    configService.set('gatewayHost', config.host || '0.0.0.0')
  }
  return result
})

ipcMain.handle('gateway:stop', async () => {
  await gatewayService.stop()
  return { success: true }
})

ipcMain.handle('gateway:getConfig', async () => {
  return gatewayService.getConfig()
})

ipcMain.handle('gateway:isRunning', async () => {
  return gatewayService.isRunning()
})

ipcMain.handle('gateway:getAutoStart', async () => {
  return configService.get('gatewayAutoStart')
})

ipcMain.handle('gateway:setAutoStart', async (_event, enabled: boolean) => {
  configService.set('gatewayAutoStart', enabled)
})

ipcMain.handle('gateway:getAuditLog', async (_event, limit?: number) => {
  return gatewayService.getAuditLog(limit)
})

// ==================== IM 集成服务 ====================

const imService = getIMService()
imService.setDependencies({
  agentService,
  mainWindow: null
})
// 从持久化配置恢复 IM 执行模式
const savedImExecutionMode = configService.get('imExecutionMode') as string | undefined
if (savedImExecutionMode && ['strict', 'relaxed', 'free'].includes(savedImExecutionMode)) {
  imService.setExecutionMode(savedImExecutionMode as ExecutionMode)
}
// 从持久化配置恢复 IM 过程消息设置
const savedImSendProcess = configService.get('imSendProcessMessages')
if (savedImSendProcess === false) {
  imService.setSendProcessMessages(false)
}
// 从持久化配置恢复 IM 思考过程开关（默认 false）
const savedImSendThinking = configService.get('imSendThinkingProcess')
if (savedImSendThinking === true) {
  imService.setSendThinkingProcess(true)
}

ipcMain.handle('im:startDingTalk', async (_event, config: DingTalkConfig) => {
  // 保存配置
  configService.set('imDingTalkClientId', config.clientId)
  configService.set('imDingTalkClientSecret', config.clientSecret)
  return await imService.startDingTalk(config)
})

ipcMain.handle('im:stopDingTalk', async () => {
  await imService.stopDingTalk()
  return { success: true }
})

ipcMain.handle('im:startFeishu', async (_event, config: FeishuConfig) => {
  // 保存配置
  configService.set('imFeishuAppId', config.appId)
  configService.set('imFeishuAppSecret', config.appSecret)
  return await imService.startFeishu(config)
})

ipcMain.handle('im:stopFeishu', async () => {
  await imService.stopFeishu()
  return { success: true }
})

// ==================== 飞书 OAuth 用户授权 ====================

ipcMain.handle('feishu:startOAuth', async () => {
  try {
    return await startFeishuOAuth()
  } catch (err: any) {
    return { authorized: false, error: err.message || String(err) }
  }
})

ipcMain.handle('feishu:revokeOAuth', async () => {
  try {
    await revokeFeishuOAuth()
    return { success: true }
  } catch (err: any) {
    return { success: false, error: err.message || String(err) }
  }
})

ipcMain.handle('feishu:getOAuthStatus', async () => {
  try {
    return await getFeishuOAuthStatus()
  } catch {
    return { authorized: false }
  }
})

ipcMain.handle('im:startSlack', async (_event, config: SlackConfig) => {
  configService.set('imSlackBotToken', config.botToken)
  configService.set('imSlackAppToken', config.appToken)
  return await imService.startSlack(config)
})

ipcMain.handle('im:stopSlack', async () => {
  await imService.stopSlack()
  return { success: true }
})

ipcMain.handle('im:startTelegram', async (_event, config: TelegramConfig) => {
  configService.set('imTelegramBotToken', config.botToken)
  return await imService.startTelegram(config)
})

ipcMain.handle('im:stopTelegram', async () => {
  await imService.stopTelegram()
  return { success: true }
})

ipcMain.handle('im:startWeCom', async (_event, config: WeComConfig) => {
  configService.set('imWeComBotId', config.botId)
  configService.set('imWeComSecret', config.secret)
  return await imService.startWeCom(config)
})

ipcMain.handle('im:stopWeCom', async () => {
  await imService.stopWeCom()
  return { success: true }
})

ipcMain.handle('im:wechatLogin', async () => {
  return await imService.loginWeChat((creds) => {
    configService.set('imWeChatToken', creds.token)
    configService.set('imWeChatBaseUrl', creds.baseUrl)
  })
})

ipcMain.handle('im:startWeChat', async () => {
  const token = (configService.get('imWeChatToken') as string) || ''
  const baseUrl = (configService.get('imWeChatBaseUrl') as string) || ''
  return await imService.startWeChat({ enabled: true, token, baseUrl })
})

ipcMain.handle('im:stopWeChat', async () => {
  await imService.stopWeChat()
  return { success: true }
})

ipcMain.handle('im:wechatLogout', async () => {
  await imService.stopWeChat()
  configService.set('imWeChatToken', '')
  configService.set('imWeChatBaseUrl', '')
  configService.set('imWeChatAutoConnect', false)
  return { success: true }
})

ipcMain.handle('im:getStatus', async () => {
  return imService.getStatus()
})

ipcMain.handle('im:getConfig', async () => {
  return {
    dingtalk: {
      clientId: (configService.get('imDingTalkClientId') as string) || '',
      clientSecret: (configService.get('imDingTalkClientSecret') as string) || '',
      autoConnect: configService.get('imDingTalkAutoConnect') || false,
    },
    feishu: {
      appId: (configService.get('imFeishuAppId') as string) || '',
      appSecret: (configService.get('imFeishuAppSecret') as string) || '',
      autoConnect: configService.get('imFeishuAutoConnect') || false,
    },
    slack: {
      botToken: (configService.get('imSlackBotToken') as string) || '',
      appToken: (configService.get('imSlackAppToken') as string) || '',
      autoConnect: configService.get('imSlackAutoConnect') || false,
    },
    telegram: {
      botToken: (configService.get('imTelegramBotToken') as string) || '',
      autoConnect: configService.get('imTelegramAutoConnect') || false,
    },
    wecom: {
      botId: (configService.get('imWeComBotId') as string) || '',
      secret: (configService.get('imWeComSecret') as string) || '',
      autoConnect: configService.get('imWeComAutoConnect') || false,
    },
    wechat: {
      hasToken: !!(configService.get('imWeChatToken') as string),
      autoConnect: configService.get('imWeChatAutoConnect') || false,
    },
    executionMode: (configService.get('imExecutionMode') as string) || 'relaxed',
    sendProcessMessages: configService.get('imSendProcessMessages') !== false,
    sendThinkingProcess: configService.get('imSendThinkingProcess') === true,
  }
})

ipcMain.handle('im:setAutoConnect', async (_event, platform: string, enabled: boolean) => {
  if (platform === 'dingtalk') {
    configService.set('imDingTalkAutoConnect', enabled)
  } else if (platform === 'feishu') {
    configService.set('imFeishuAutoConnect', enabled)
  } else if (platform === 'slack') {
    configService.set('imSlackAutoConnect', enabled)
  } else if (platform === 'telegram') {
    configService.set('imTelegramAutoConnect', enabled)
  } else if (platform === 'wecom') {
    configService.set('imWeComAutoConnect', enabled)
  } else if (platform === 'wechat') {
    configService.set('imWeChatAutoConnect', enabled)
  }
})

ipcMain.handle('im:setExecutionMode', async (_event, mode: ExecutionMode) => {
  configService.set('imExecutionMode', mode)
  imService.setExecutionMode(mode)
})

ipcMain.handle('im:setSendProcessMessages', async (_event, enabled: boolean) => {
  configService.set('imSendProcessMessages', enabled)
  imService.setSendProcessMessages(enabled)
})

ipcMain.handle('im:setSendThinkingProcess', async (_event, enabled: boolean) => {
  configService.set('imSendThinkingProcess', enabled)
  imService.setSendThinkingProcess(enabled)
})

// 更新远程 Agent 运行时执行模式（仅运行时，不持久化，用于 tab 界面手动切换）
ipcMain.handle('web-chat:setExecutionMode', async (_event, mode: ExecutionMode) => {
  if (!['strict', 'relaxed', 'free'].includes(mode)) return
  webChatService.executionMode = mode
})

ipcMain.handle('im:sendNotification', async (_event, text: string, options?: { markdown?: boolean; title?: string }) => {
  return await imService.sendNotification(text, options)
})

// ==================== 堡垒机（JumpServer）集成 ====================

const bastionService = new BastionService(configService)

const getBastionConfig = () => ({
  url: (configService.get('bastionUrl') as string) || '',
  username: (configService.get('bastionUsername') as string) || '',
  password: (configService.get('bastionPassword') as string) || '',
  autoJumpHost: configService.get('bastionAutoJumpHost') ?? true,
  jumpHostPort: configService.get('bastionJumpHostPort') || 2222,
  rejectUnauthorized: configService.get('bastionRejectUnauthorized') ?? true
})

ipcMain.handle('bastion:getConfig', async () => getBastionConfig())

ipcMain.handle('bastion:saveConfig', async (_event, config: { url: string; username: string; password: string; autoJumpHost: boolean; jumpHostPort: number; rejectUnauthorized: boolean }) => {
  configService.set('bastionUrl', config.url)
  configService.set('bastionUsername', config.username)
  configService.set('bastionPassword', config.password)
  configService.set('bastionAutoJumpHost', config.autoJumpHost)
  configService.set('bastionJumpHostPort', config.jumpHostPort)
  configService.set('bastionRejectUnauthorized', config.rejectUnauthorized)
})

ipcMain.handle('bastion:testConnection', async (_event, config: { url: string; username: string; password: string; rejectUnauthorized: boolean }) => {
  return bastionService.testConnection({ ...config, autoJumpHost: true, jumpHostPort: 2222 })
})

ipcMain.handle('bastion:syncAssets', async () => {
  return bastionService.syncAssets(getBastionConfig())
})

// ==================== 智能巡检协调器相关 ====================

// 初始化协调器服务依赖
// 记录终端类型（用于 Worker Agent 获取正确的上下文）
const terminalTypes = new Map<string, 'local' | 'ssh'>()

function initOrchestratorService() {
  orchestratorService.setServices({
    aiService,
    getSshSessions: () => configService.getSshSessions(),
    createLocalTerminal: async () => {
      // 创建本地终端
      const tabId = ptyService.create({})
      terminalTypes.set(tabId, 'local')
      terminalStateService.initTerminal(tabId, 'local')
      return tabId
    },
    createSshTerminal: async (sshConfig) => {
      // 创建 SSH 终端
      const config = sshConfig as {
        host: string
        port: number
        username: string
        password?: string
        privateKey?: string
      }
      const tabId = await sshService.connect({
        host: config.host,
        port: config.port,
        username: config.username,
        password: config.password,
        privateKey: config.privateKey
      })
      terminalTypes.set(tabId, 'ssh')
      terminalStateService.initTerminal(tabId, 'ssh')
      return tabId
    },
    closeTerminal: async (terminalId) => {
      const type = terminalTypes.get(terminalId)
      if (type === 'local') {
        ptyService.dispose(terminalId)
      } else {
        sshService.disconnect(terminalId)
      }
      terminalTypes.delete(terminalId)
      terminalStateService.removeTerminal(terminalId)
      // Worker Agent 与终端是 1:1 绑定（agentKey = terminalId），随终端一起清理是合理的。
      // 这跟用户 tab 的多窗格场景不同（用户 tab 的 Agent 归 tab 所有，与 PTY 解耦）。
      agentService.cleanupAgent(terminalId)
    },
    getTerminalType: (terminalId) => {
      return terminalTypes.get(terminalId) || 'ssh'
    },
    runWorkerAgent: async (ptyId, task, workerOptions) => {
      const type = terminalTypes.get(ptyId) || 'ssh'
      
      // Worker Agent 的上下文：初始输出为空，Agent 运行时会通过工具获取最新输出
      const context: AgentContext = {
        ptyId,
        terminalOutput: [],  // Worker 启动时输出为空，实际输出会在运行时获取
        systemInfo: { 
          os: type === 'local' ? process.platform : 'linux', 
          shell: type === 'local' ? getDefaultShell() : 'bash' 
        },
        terminalType: type
      }
      // 运行 Worker Agent（使用严格模式）
      return agentService.run(ptyId, task, context, { executionMode: 'strict' }, undefined, workerOptions)
    }
  })
}

// 启动智能巡检任务
ipcMain.handle('orchestrator:start', async (_event, task: string, config?: Partial<OrchestratorConfig>) => {
  // 确保协调器服务已初始化
  initOrchestratorService()
  return orchestratorService.startTask(task, config)
})

// 停止智能巡检任务
ipcMain.handle('orchestrator:stop', async (_event, orchestratorId: string) => {
  return orchestratorService.stopTask(orchestratorId)
})

// 获取可用主机列表（直接从 configService 获取，不依赖协调器初始化）
ipcMain.handle('orchestrator:listHosts', async () => {
  const sessions = configService.getSshSessions()
  return sessions.map(session => ({
    hostId: session.id,
    name: session.name,
    host: session.host,
    port: session.port,
    username: session.username,
    group: session.group,
    groupId: session.groupId
  }))
})

// 响应批量确认
ipcMain.handle('orchestrator:batchConfirmResponse', async (
  _event,
  orchestratorId: string,
  action: 'cancel' | 'current' | 'all',
  selectedTerminals?: string[]
) => {
  orchestratorService.respondBatchConfirm(orchestratorId, action, selectedTerminals)
})

// 获取协调器状态
ipcMain.handle('orchestrator:getStatus', async (_event, orchestratorId: string) => {
  const status = orchestratorService.getStatus(orchestratorId)
  if (!status) return null
  // 序列化 Map 为数组
  return {
    ...status,
    workers: Array.from(status.workers.values())
  }
})

// ==================== 历史记录相关 ====================

// 保存 Agent 记录
ipcMain.handle('history:saveAgentRecord', async (_event, record: AgentRecord) => {
  historyService.saveAgentRecord(record)
})

// 保存（更新）产出物面板清单
ipcMain.handle('history:saveArtifacts', async (_event, recordId: string, artifacts: AgentRecord['artifacts']) => {
  historyService.saveArtifacts(recordId, artifacts ?? [])
})

// 获取 Agent 记录
ipcMain.handle('history:getAgentRecords', async (_event, startDate?: string, endDate?: string) => {
  return historyService.getAgentRecords(startDate, endDate)
})

ipcMain.handle('history:getRecentAgentRecords', async (_event, limit?: number, excludeWakeup?: boolean) => {
  // 结构化过滤：watch 内心独白（agentKey='__watch__'）已存独立索引，联络会话（agentKey='__companion__'）
  // 有独立常驻 tab，均不应出现在任务侧栏的「最近记录」里。
  const filter = excludeWakeup
    ? (r: AgentRecord) => r.agentKey !== '__watch__' && r.agentKey !== '__companion__' && !r.id.startsWith('watch_')
    : undefined
  return historyService.getRecentAgentRecords(limit ?? 5, filter)
})

ipcMain.handle('history:listAgentSummaries', async (_event, excludeWakeup?: boolean) => {
  return historyService.listAgentHistorySummaries(excludeWakeup)
})

ipcMain.handle(
  'history:searchAgentRecords',
  async (
    _event,
    options: {
      keyword?: string
      startDate?: string
      endDate?: string
      limit?: number
      excludeWakeup?: boolean
      titleOnly?: boolean
    }
  ) => {
    // 结构化过滤：watch 内心独白和联络会话均不应出现在任务搜索结果中。
    const filter = options.excludeWakeup
      ? (r: AgentRecord) => r.agentKey !== '__watch__' && r.agentKey !== '__companion__' && !r.id.startsWith('watch_')
      : undefined
    return await historyService.searchAgentRecordsAdvanced({
      keyword: options.keyword,
      startDate: options.startDate,
      endDate: options.endDate,
      limit: options.limit ?? 50,
      filter,
      titleOnly: options.titleOnly
    })
  }
)

// 按 ID 获取单条 Agent 记录（用于 Watch 执行详情查看）
ipcMain.handle('history:getAgentRecordById', async (_event, id: string) => {
  return historyService.getAgentRecordById(id)
})

// 取某 agentKey 最近 N 条完整会话记录（联络常驻 tab 重启后合并恢复历史对话）
ipcMain.handle('history:getRecentByAgentKey', async (_event, agentKey: string, limit?: number) => {
  return historyService.getRecentRecordsByAgentKey(agentKey, limit ?? 10)
})

ipcMain.handle('history:deleteAgentRecord', async (_event, id: string) => {
  return historyService.deleteAgentRecord(id)
})

// 获取数据目录路径
ipcMain.handle('history:getDataPath', async () => {
  return historyService.getDataPath()
})

// ==================== 数据目录自定义 / 迁移 ====================

// 获取数据目录信息（当前 / 默认 / 是否自定义 / 上次迁移错误）
ipcMain.handle('dataDir:getInfo', async () => {
  return getDataDirInfo()
})

// 是否有 Agent 正在运行（迁移前提示用户重启会中断任务）
ipcMain.handle('dataDir:hasRunningAgents', async () => {
  return agentService.hasRunningAgents()
})

// 选择目标目录（返回所选路径 + 是否非空，供前端确认）
ipcMain.handle('dataDir:pickTarget', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory', 'createDirectory'],
    title: getAppName(),
  })
  if (result.canceled || result.filePaths.length === 0) {
    return { canceled: true }
  }
  const target = result.filePaths[0]
  return { canceled: false, target, nonEmpty: isTargetNonEmpty(target) }
})

// 确认迁移到指定目录：写入待迁移标记并重启
ipcMain.handle('dataDir:migrate', async (_e, target: string) => {
  const res = requestDataDirMigration(target)
  if (!res.ok) return res
  setTimeout(() => { app.relaunch(); app.exit(0) }, 150)
  return { ok: true }
})

// 恢复到默认数据目录：写入待迁移标记并重启
ipcMain.handle('dataDir:reset', async () => {
  const res = requestDataDirReset()
  if (!res.ok) return res
  setTimeout(() => { app.relaunch(); app.exit(0) }, 150)
  return { ok: true }
})

// 获取存储统计
ipcMain.handle('history:getStorageStats', async () => {
  return historyService.getStorageStats()
})

// 获取 Token 用量统计
ipcMain.handle('history:getTokenUsageStats', async () => {
  return historyService.getTokenUsageStats()
})

// 导出到文件夹
ipcMain.handle('history:exportToFolder', async (_event, options?: { includeSshPasswords?: boolean; includeApiKeys?: boolean }) => {
  try {
    // 检查 mainWindow 是否存在
    if (!mainWindow) {
      return { success: false, error: t('error.windowNotReady') }
    }
    
    // 选择导出目录 - createDirectory 仅在 macOS 上有效
    const dialogOptions: Electron.OpenDialogOptions = {
      title: t('dialog.selectExportDir'),
      properties: ['openDirectory'],
      buttonLabel: t('dialog.exportHere')
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
    log.error('导出到文件夹失败:', error)
    return { success: false, error: errMsg(error, 'error.exportFailed') }
  }
})

// 从文件夹导入
ipcMain.handle('history:importFromFolder', async () => {
  try {
    // 检查 mainWindow 是否存在
    if (!mainWindow) {
      return { success: false, error: t('error.windowNotReady') }
    }
    
    // 选择导入目录
    const result = await dialog.showOpenDialog(mainWindow, {
      title: t('dialog.selectBackupFolder'),
      properties: ['openDirectory'],
      buttonLabel: t('dialog.importHere')
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
            mergedSessions.push(session as unknown as typeof existingSessions[0])
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
            mergedProfiles.push(profile as unknown as typeof existingProfiles[0])
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
    log.error('从文件夹导入失败:', error)
    return { success: false, imported: [], error: errMsg(error, 'error.importFailed') }
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
    log.error('SSH Probe 探测失败:', error)
    return null
  }
})

// ==================== 文档解析相关 ====================

// 选择文件对话框
ipcMain.handle('document:selectFiles', async () => {
  const result = await dialog.showOpenDialog({
    title: t('dialog.selectFile'),
    filters: [
      { name: t('filter.allFiles'), extensions: ['*'] }
    ],
    properties: ['openFile', 'multiSelections']
  })
  
  if (result.canceled || result.filePaths.length === 0) {
    return { canceled: true, files: [] }
  }
  
  // 获取文件信息
  const files: UploadedFile[] = result.filePaths.map(filePath => {
    const stats = fs.statSync(filePath)
    return {
      name: path.basename(filePath),
      path: filePath,
      size: stats.size
    }
  })
  
  return { canceled: false, files }
})

// 解析单个文档（extractImages 由后端根据视觉模型配置自动决定）
ipcMain.handle('document:parse', async (_event, file: UploadedFile, options?: ParseOptions) => {
  const extractImages = options?.extractImages ?? configService.hasVisionCapability()
  return documentParserService.parseDocument(file, { ...options, extractImages })
})

// 批量解析文档（extractImages 由后端根据视觉模型配置自动决定）
ipcMain.handle('document:parseMultiple', async (event, files: UploadedFile[], options?: ParseOptions) => {
  const extractImages = options?.extractImages ?? configService.hasVisionCapability()
  const requestId = options?.requestId || `doc_parse_${Date.now()}`
  const sendProgress = (progress: DocumentParseProgress) => {
    if (!event.sender.isDestroyed()) {
      event.sender.send('document:parseProgress', progress)
    }
  }
  return documentParserService.parseDocuments(files, { ...options, requestId, extractImages, onProgress: sendProgress })
})

// 格式化为 AI 上下文
ipcMain.handle('document:formatAsContext', async (_event, docs: ParsedDocument[]) => {
  return documentParserService.formatAsContext(docs)
})

// 生成文档摘要
ipcMain.handle('document:generateSummary', async (_event, doc: ParsedDocument) => {
  return documentParserService.generateSummary(doc)
})

// 检查解析能力
ipcMain.handle('document:checkCapabilities', async () => {
  return documentParserService.checkCapabilities()
})

// 获取支持的文件类型
ipcMain.handle('document:getSupportedTypes', async () => {
  return documentParserService.getSupportedTypes()
})

// ==================== PPT 预览修复（历史 HTML 去 CDN + 内联 echarts） ====================

ipcMain.handle('ppt:sanitizePreview', async (_event, html: unknown) => {
  const { sanitizePreviewHtml } = await import('./services/agent/skills/ppt/preview')
  return sanitizePreviewHtml(typeof html === 'string' ? html : '')
})

// ==================== 本地文件系统相关 ====================

// 获取主目录
ipcMain.handle('localFs:getHomeDir', async () => {
  return localFsService.getHomeDir()
})

// 获取驱动器列表
ipcMain.handle('localFs:getDrives', async () => {
  return localFsService.getDrives()
})

// 列出目录内容
ipcMain.handle('localFs:list', async (_event, dirPath: string) => {
  try {
    const files = await localFsService.list(dirPath)
    return { success: true, data: files }
  } catch (error) {
    return { 
      success: false, 
      error: errMsg(error, 'error.listDirFailed') 
    }
  }
})

// 获取文件信息
ipcMain.handle('localFs:stat', async (_event, filePath: string) => {
  try {
    const stat = await localFsService.stat(filePath)
    return { success: true, data: stat }
  } catch (error) {
    return { 
      success: false, 
      error: errMsg(error, 'error.getFileInfoFailed') 
    }
  }
})

// 检查路径是否存在
ipcMain.handle('localFs:exists', async (_event, filePath: string) => {
  try {
    const exists = await localFsService.exists(filePath)
    return { success: true, data: exists }
  } catch (error) {
    return { 
      success: false, 
      error: errMsg(error, 'error.checkPathFailed') 
    }
  }
})

// 创建目录
ipcMain.handle('localFs:mkdir', async (_event, dirPath: string) => {
  try {
    await localFsService.mkdir(dirPath)
    return { success: true }
  } catch (error) {
    return { 
      success: false, 
      error: errMsg(error, 'error.createDirFailed') 
    }
  }
})

// 删除文件
ipcMain.handle('localFs:delete', async (_event, filePath: string) => {
  try {
    await localFsService.delete(filePath)
    return { success: true }
  } catch (error) {
    return { 
      success: false, 
      error: errMsg(error, 'error.deleteFileFailed') 
    }
  }
})

// 删除目录
ipcMain.handle('localFs:rmdir', async (_event, dirPath: string) => {
  try {
    await localFsService.rmdir(dirPath)
    return { success: true }
  } catch (error) {
    return { 
      success: false, 
      error: errMsg(error, 'error.deleteDirFailed') 
    }
  }
})

// 重命名/移动
ipcMain.handle('localFs:rename', async (_event, oldPath: string, newPath: string) => {
  try {
    await localFsService.rename(oldPath, newPath)
    return { success: true }
  } catch (error) {
    return { 
      success: false, 
      error: errMsg(error, 'error.renameFailed') 
    }
  }
})

// 复制文件
ipcMain.handle('localFs:copyFile', async (_event, src: string, dest: string) => {
  try {
    await localFsService.copyFile(src, dest)
    return { success: true }
  } catch (error) {
    return { 
      success: false, 
      error: errMsg(error, 'error.copyFileFailed') 
    }
  }
})

// 复制目录
ipcMain.handle('localFs:copyDir', async (_event, src: string, dest: string) => {
  try {
    await localFsService.copyDir(src, dest)
    return { success: true }
  } catch (error) {
    return { 
      success: false, 
      error: errMsg(error, 'error.copyDirFailed') 
    }
  }
})

// 读取文本文件
ipcMain.handle('localFs:readFile', async (_event, filePath: string) => {
  try {
    const content = await localFsService.readFile(filePath)
    return { success: true, data: content }
  } catch (error) {
    return { 
      success: false, 
      error: errMsg(error, 'error.readFileFailed') 
    }
  }
})

// 产出物预览重建（Word/Excel/md/html 从磁盘再生 HTML/文本）
ipcMain.handle('localFs:previewArtifact', async (_event, filePath: string, renderer: string) => {
  try {
    const { tryPreviewArtifactFromFile } = await import('./services/artifact-preview.service')
    const data = await tryPreviewArtifactFromFile(filePath, renderer as import('@shared/types').CanvasRendererType)
    if (data == null) {
      return { success: false, error: 'Preview generation failed' }
    }
    return { success: true, data }
  } catch (error) {
    return { success: false, error: errMsg(error, 'error.readFileFailed') }
  }
})

// 写入文本文件
ipcMain.handle('localFs:writeFile', async (_event, filePath: string, content: string) => {
  try {
    await localFsService.writeFile(filePath, content)
    return { success: true }
  } catch (error) {
    return { 
      success: false, 
      error: errMsg(error, 'error.writeFileFailed') 
    }
  }
})

// 获取上级目录
ipcMain.handle('localFs:getParentDir', async (_event, filePath: string) => {
  return localFsService.getParentDir(filePath)
})

// 拼接路径
ipcMain.handle('localFs:joinPath', async (_event, ...parts: string[]) => {
  return localFsService.joinPath(...parts)
})

// 获取路径分隔符
ipcMain.handle('localFs:getSeparator', async () => {
  return localFsService.getSeparator()
})

// 获取常用目录
ipcMain.handle('localFs:getSpecialFolders', async () => {
  return localFsService.getSpecialFolders()
})

// 在系统文件管理器中显示
ipcMain.handle('localFs:showInExplorer', async (_event, filePath: string) => {
  return localFsService.showInExplorer(filePath)
})

// 用系统默认程序打开
ipcMain.handle('localFs:openFile', async (_event, filePath: string) => {
  return localFsService.openFile(filePath)
})

// ==================== 文件管理器窗口相关 ====================

// 打开文件管理器窗口
ipcMain.handle('fileManager:open', async (_event, config: {
  sessionId?: string
  sftpConfig?: SftpConfig
  initialLocalPath?: string
  initialRemotePath?: string
}) => {
  createFileManagerWindow(config)
  return { success: true }
})

// 关闭文件管理器窗口
ipcMain.handle('fileManager:close', async () => {
  if (fileManagerWindow && !fileManagerWindow.isDestroyed()) {
    fileManagerWindow.close()
  }
})

// 获取窗口初始化参数
ipcMain.handle('fileManager:getInitParams', async () => {
  return fileManagerParams
})

// ==================== SFTP 相关 ====================

// SFTP 传输进度事件转发（发送到主窗口和文件管理器窗口）
sftpService.on('transfer-start', (progress) => {
  mainWindow?.webContents.send('sftp:transfer-start', progress)
  fileManagerWindow?.webContents.send('sftp:transfer-start', progress)
})
sftpService.on('transfer-progress', (progress) => {
  mainWindow?.webContents.send('sftp:transfer-progress', progress)
  fileManagerWindow?.webContents.send('sftp:transfer-progress', progress)
})
sftpService.on('transfer-complete', (progress) => {
  mainWindow?.webContents.send('sftp:transfer-complete', progress)
  fileManagerWindow?.webContents.send('sftp:transfer-complete', progress)
})
sftpService.on('transfer-error', (progress) => {
  mainWindow?.webContents.send('sftp:transfer-error', progress)
  fileManagerWindow?.webContents.send('sftp:transfer-error', progress)
})
sftpService.on('transfer-cancelled', (progress) => {
  mainWindow?.webContents.send('sftp:transfer-cancelled', progress)
  fileManagerWindow?.webContents.send('sftp:transfer-cancelled', progress)
})

// 连接 SFTP
ipcMain.handle('sftp:connect', async (_event, sessionId: string, config: SftpConfig) => {
  try {
    await sftpService.connect(sessionId, config)
    return { success: true }
  } catch (error) {
    return { 
      success: false, 
      error: errMsg(error, 'error.connectFailed') 
    }
  }
})

// 断开 SFTP 连接
ipcMain.handle('sftp:disconnect', async (_event, sessionId: string) => {
  await sftpService.disconnect(sessionId)
})

// 检查连接是否存在
ipcMain.handle('sftp:hasSession', async (_event, sessionId: string) => {
  return sftpService.hasSession(sessionId)
})

// 列出目录内容
ipcMain.handle('sftp:list', async (_event, sessionId: string, remotePath: string) => {
  log.info(`SFTP list 请求: sessionId=${sessionId}, remotePath=${remotePath}`)
  try {
    const { files, resolvedPath } = await sftpService.list(sessionId, remotePath)
    log.info(`SFTP list 结果: resolvedPath=${resolvedPath}, 文件数=${files.length}`)
    return { success: true, data: files, resolvedPath }
  } catch (error) {
    log.error('SFTP list 失败:', error)
    return {
      success: false,
      error: errMsg(error, 'error.listDirFailed')
    }
  }
})

// 获取当前工作目录
ipcMain.handle('sftp:pwd', async (_event, sessionId: string) => {
  try {
    const cwd = await sftpService.pwd(sessionId)
    return { success: true, data: cwd }
  } catch (error) {
    return { 
      success: false, 
      error: errMsg(error, 'error.getCwdFailed') 
    }
  }
})

// 检查路径是否存在
ipcMain.handle('sftp:exists', async (_event, sessionId: string, remotePath: string) => {
  try {
    const result = await sftpService.exists(sessionId, remotePath)
    return { success: true, data: result }
  } catch (error) {
    return { 
      success: false, 
      error: errMsg(error, 'error.checkPathFailed') 
    }
  }
})

// 获取文件/目录信息
ipcMain.handle('sftp:stat', async (_event, sessionId: string, remotePath: string) => {
  try {
    const stats = await sftpService.stat(sessionId, remotePath)
    return { success: true, data: stats }
  } catch (error) {
    return { 
      success: false, 
      error: errMsg(error, 'error.getFileInfoFailed') 
    }
  }
})

// 上传文件
ipcMain.handle('sftp:upload', async (_event, sessionId: string, localPath: string, remotePath: string, transferId: string) => {
  try {
    await sftpService.upload(sessionId, localPath, remotePath, transferId)
    return { success: true }
  } catch (error) {
    return { 
      success: false, 
      error: errMsg(error, 'error.uploadFailed') 
    }
  }
})

// 下载文件
ipcMain.handle('sftp:download', async (_event, sessionId: string, remotePath: string, localPath: string, transferId: string) => {
  try {
    await sftpService.download(sessionId, remotePath, localPath, transferId)
    return { success: true }
  } catch (error) {
    return { 
      success: false, 
      error: errMsg(error, 'error.downloadFailed') 
    }
  }
})

// 上传目录
ipcMain.handle('sftp:uploadDir', async (_event, sessionId: string, localDir: string, remoteDir: string) => {
  try {
    await sftpService.uploadDir(sessionId, localDir, remoteDir)
    return { success: true }
  } catch (error) {
    return { 
      success: false, 
      error: errMsg(error, 'error.uploadDirFailed') 
    }
  }
})

// 下载目录
ipcMain.handle('sftp:downloadDir', async (_event, sessionId: string, remoteDir: string, localDir: string) => {
  try {
    await sftpService.downloadDir(sessionId, remoteDir, localDir)
    return { success: true }
  } catch (error) {
    return { 
      success: false, 
      error: errMsg(error, 'error.downloadDirFailed') 
    }
  }
})

// 创建目录
ipcMain.handle('sftp:mkdir', async (_event, sessionId: string, remotePath: string) => {
  try {
    await sftpService.mkdir(sessionId, remotePath)
    return { success: true }
  } catch (error) {
    return { 
      success: false, 
      error: errMsg(error, 'error.createDirFailed') 
    }
  }
})

// 删除文件
ipcMain.handle('sftp:delete', async (_event, sessionId: string, remotePath: string) => {
  try {
    await sftpService.delete(sessionId, remotePath)
    return { success: true }
  } catch (error) {
    return { 
      success: false, 
      error: errMsg(error, 'error.deleteFileFailed') 
    }
  }
})

// 删除目录
ipcMain.handle('sftp:rmdir', async (_event, sessionId: string, remotePath: string) => {
  try {
    await sftpService.rmdir(sessionId, remotePath)
    return { success: true }
  } catch (error) {
    return { 
      success: false, 
      error: errMsg(error, 'error.deleteDirFailed') 
    }
  }
})

// 重命名/移动
ipcMain.handle('sftp:rename', async (_event, sessionId: string, oldPath: string, newPath: string) => {
  try {
    await sftpService.rename(sessionId, oldPath, newPath)
    return { success: true }
  } catch (error) {
    return { 
      success: false, 
      error: errMsg(error, 'error.renameFailed') 
    }
  }
})

// 修改权限
ipcMain.handle('sftp:chmod', async (_event, sessionId: string, remotePath: string, mode: string | number) => {
  try {
    await sftpService.chmod(sessionId, remotePath, mode)
    return { success: true }
  } catch (error) {
    return { 
      success: false, 
      error: errMsg(error, 'error.chmodFailed') 
    }
  }
})

// 读取文本文件
ipcMain.handle('sftp:readFile', async (_event, sessionId: string, remotePath: string) => {
  try {
    const content = await sftpService.readFile(sessionId, remotePath)
    return { success: true, data: content }
  } catch (error) {
    return { 
      success: false, 
      error: errMsg(error, 'error.readFileFailed') 
    }
  }
})

// 写入文本文件
ipcMain.handle('sftp:writeFile', async (_event, sessionId: string, remotePath: string, content: string) => {
  try {
    await sftpService.writeFile(sessionId, remotePath, content)
    return { success: true }
  } catch (error) {
    return { 
      success: false, 
      error: errMsg(error, 'error.writeFileFailed') 
    }
  }
})

// 获取当前传输列表
ipcMain.handle('sftp:getTransfers', async () => {
  return sftpService.getTransfers()
})

// 取消传输
ipcMain.handle('sftp:cancelTransfer', async (_event, transferId: string) => {
  try {
    const cancelled = sftpService.cancelTransfer(transferId)
    return { success: cancelled }
  } catch (error) {
    return {
      success: false,
      error: errMsg(error, 'error.cancelFailed')
    }
  }
})

// 选择本地文件（用于上传）
ipcMain.handle('sftp:selectLocalFiles', async () => {
  const result = await dialog.showOpenDialog({
    title: t('dialog.selectUploadFiles'),
    properties: ['openFile', 'multiSelections']
  })
  
  if (result.canceled || result.filePaths.length === 0) {
    return { canceled: true, files: [] }
  }
  
  const files = result.filePaths.map(filePath => {
    const stats = fs.statSync(filePath)
    return {
      name: path.basename(filePath),
      path: filePath,
      size: stats.size,
      isDirectory: stats.isDirectory()
    }
  })
  
  return { canceled: false, files }
})

// 选择本地目录（用于上传或保存下载）
ipcMain.handle('sftp:selectLocalDirectory', async (_event, options?: { title?: string; forSave?: boolean }) => {
  const dialogOptions: Electron.OpenDialogOptions = {
    title: options?.title || t('dialog.selectDir'),
    properties: ['openDirectory']
  }
  
  // macOS 上允许创建新目录
  if (process.platform === 'darwin') {
    dialogOptions.properties!.push('createDirectory')
  }
  
  const result = await dialog.showOpenDialog(dialogOptions)
  
  if (result.canceled || result.filePaths.length === 0) {
    return { canceled: true, path: '' }
  }
  
  return { canceled: false, path: result.filePaths[0] }
})

// 选择保存文件路径
ipcMain.handle('sftp:selectSavePath', async (_event, defaultName: string) => {
  const result = await dialog.showSaveDialog({
    title: t('dialog.saveFile'),
    defaultPath: defaultName,
    properties: ['createDirectory', 'showOverwriteConfirmation']
  })
  
  if (result.canceled || !result.filePath) {
    return { canceled: true, path: '' }
  }
  
  return { canceled: false, path: result.filePath }
})

// ==================== MCP 相关 ====================

// 获取 MCP 服务器配置列表
ipcMain.handle('mcp:getServers', async () => {
  return configService.getMcpServers()
})

// 保存 MCP 服务器配置列表
ipcMain.handle('mcp:setServers', async (_event, servers: McpServerConfig[]) => {
  configService.setMcpServers(servers)
})

// 添加 MCP 服务器
ipcMain.handle('mcp:addServer', async (_event, server: McpServerConfig) => {
  configService.addMcpServer(server)
})

// 更新 MCP 服务器
ipcMain.handle('mcp:updateServer', async (_event, server: McpServerConfig) => {
  configService.updateMcpServer(server)
})

// 删除 MCP 服务器
ipcMain.handle('mcp:deleteServer', async (_event, id: string) => {
  // 先断开连接
  await mcpService.disconnect(id)
  configService.deleteMcpServer(id)
})

// 连接到 MCP 服务器
ipcMain.handle('mcp:connect', async (_event, config: McpServerConfig) => {
  try {
    await mcpService.connect(config)
    return { success: true }
  } catch (error) {
    return { 
      success: false, 
      error: errMsg(error, 'error.connectFailed') 
    }
  }
})

// 断开 MCP 服务器连接
ipcMain.handle('mcp:disconnect', async (_event, serverId: string) => {
  await mcpService.disconnect(serverId)
})

// 测试 MCP 服务器连接
ipcMain.handle('mcp:testConnection', async (_event, config: McpServerConfig) => {
  return mcpService.testConnection(config)
})

// 获取所有已连接服务器的状态
ipcMain.handle('mcp:getServerStatuses', async () => {
  return mcpService.getServerStatuses()
})

// 获取所有可用工具
ipcMain.handle('mcp:getAllTools', async () => {
  return mcpService.getAllTools()
})

// 获取所有可用资源
ipcMain.handle('mcp:getAllResources', async () => {
  return mcpService.getAllResources()
})

// 获取所有可用提示模板
ipcMain.handle('mcp:getAllPrompts', async () => {
  return mcpService.getAllPrompts()
})

// 调用 MCP 工具
ipcMain.handle('mcp:callTool', async (_event, serverId: string, toolName: string, args: Record<string, unknown>) => {
  return mcpService.callTool(serverId, toolName, args)
})

// 读取 MCP 资源
ipcMain.handle('mcp:readResource', async (_event, serverId: string, uri: string) => {
  return mcpService.readResource(serverId, uri)
})

// 获取 MCP 提示模板
ipcMain.handle('mcp:getPrompt', async (_event, serverId: string, promptName: string, args?: Record<string, string>) => {
  return mcpService.getPrompt(serverId, promptName, args)
})

// 刷新服务器的工具/资源/提示列表
ipcMain.handle('mcp:refreshServer', async (_event, serverId: string) => {
  try {
    await mcpService.refreshServer(serverId)
    return { success: true }
  } catch (error) {
    return { 
      success: false, 
      error: errMsg(error, 'error.refreshFailed') 
    }
  }
})

// 检查服务器是否已连接
ipcMain.handle('mcp:isConnected', async (_event, serverId: string) => {
  return mcpService.isConnected(serverId)
})

// 连接所有启用的 MCP 服务器
ipcMain.handle('mcp:connectEnabledServers', async () => {
  const servers = configService.getEnabledMcpServers()
  const results: Array<{ id: string; success: boolean; error?: string }> = []
  
  for (const server of servers) {
    try {
      await mcpService.connect(server)
      results.push({ id: server.id, success: true })
    } catch (error) {
      results.push({ 
        id: server.id, 
        success: false, 
        error: errMsg(error, 'error.connectFailed') 
      })
    }
  }
  
  return results
})

// 断开所有 MCP 连接
ipcMain.handle('mcp:disconnectAll', async () => {
  await mcpService.disconnectAll()
})

// ==================== 插件系统相关 ====================

import { installPlugin, uninstallPlugin, updatePlugin } from './services/plugin/installer'

ipcMain.handle('plugin:list', async () => {
  return pluginRegistry.listAll()
})

ipcMain.handle('plugin:enable', async (_event, id: string) => {
  const success = pluginRegistry.enablePlugin(id)
  if (success) {
    const entries = configService.get('pluginsEntries') || {}
    entries[id] = { ...entries[id], enabled: true }
    configService.set('pluginsEntries', entries)
  }
  return success
})

ipcMain.handle('plugin:disable', async (_event, id: string) => {
  const success = pluginRegistry.disablePlugin(id)
  if (success) {
    const entries = configService.get('pluginsEntries') || {}
    entries[id] = { ...entries[id], enabled: false }
    configService.set('pluginsEntries', entries)
  }
  return success
})

ipcMain.handle('plugin:install', async (_event, spec: string) => {
  const result = await installPlugin(spec, app.getPath('userData'))
  if (result.success) {
    await pluginRegistry.loadAll()
    const providers = pluginRegistry.getAllProviders()
    if (providers.length > 0) aiService.setPluginProviders(providers)
    const routes = pluginRegistry.getAllHttpRoutes()
    if (routes.length > 0) gatewayService.registerPluginRoutes(routes)
    const ttsPs = pluginRegistry.getAllTtsProviders()
    if (ttsPs.length > 0) {
      const tts = await import('./services/tts')
      for (const p of ttsPs) tts.registerProvider(p)
    }
  }
  return result
})

ipcMain.handle('plugin:uninstall', async (_event, packageName: string) => {
  return uninstallPlugin(packageName, app.getPath('userData'))
})

ipcMain.handle('plugin:update', async (_event, packageName: string) => {
  return updatePlugin(packageName, app.getPath('userData'))
})

ipcMain.handle('plugin:getConfig', async (_event, id: string) => {
  const entries = configService.get('pluginsEntries') || {}
  return entries[id]?.config || {}
})

ipcMain.handle('plugin:setConfig', async (_event, id: string, config: Record<string, unknown>) => {
  const entries = configService.get('pluginsEntries') || {}
  entries[id] = { ...entries[id], enabled: entries[id]?.enabled ?? true, config }
  configService.set('pluginsEntries', entries)
})

// ==================== 浏览器助手（扩展桥接） ====================

ipcMain.handle('browserBridge:getStatus', async () => {
  return getBrowserBridgeService().getStatus()
})

ipcMain.handle('browserBridge:install', async () => {
  return getBrowserBridgeService().install()
})

ipcMain.handle('browserBridge:uninstall', async () => {
  return getBrowserBridgeService().uninstall()
})

ipcMain.handle('browserBridge:openExtensionGuide', async (_event, browser: BrowserBridgeBrowser) => {
  await getBrowserBridgeService().openExtensionGuide(browser)
})

// ==================== 内置技能相关 ====================

ipcMain.handle('builtinSkill:list', async () => {
  const disabledIds = configService.get('disabledBuiltinSkills') || []
  return getBuiltinSkillsForSettings(disabledIds)
})

ipcMain.handle('builtinSkill:toggle', async (_event, skillId: string, enabled: boolean) => {
  if (!skillId || typeof skillId !== 'string') return false
  try {
    const disabledIds = new Set(configService.get('disabledBuiltinSkills') || [])
    if (enabled) {
      disabledIds.delete(skillId)
    } else {
      disabledIds.add(skillId)
    }
    configService.set('disabledBuiltinSkills', Array.from(disabledIds))
    return true
  } catch (error) {
    log.error('Failed to toggle builtin skill:', error)
    return false
  }
})

// ==================== 用户技能相关 ====================

// 获取所有用户技能列表
ipcMain.handle('userSkill:list', async (): Promise<UserSkill[]> => {
  return getUserSkillService().getAllSkills()
})

// 刷新技能列表
ipcMain.handle('userSkill:refresh', async (): Promise<UserSkill[]> => {
  return getUserSkillService().refresh()
})

// 启用/禁用技能
ipcMain.handle('userSkill:toggle', async (_event, skillId: string, enabled: boolean): Promise<boolean> => {
  return getUserSkillService().toggleSkill(skillId, enabled)
})

// 打开技能目录
ipcMain.handle('userSkill:openFolder', async (): Promise<void> => {
  await getUserSkillService().openSkillsFolder()
})

// 获取技能完整内容
ipcMain.handle('userSkill:getContent', async (_event, skillId: string): Promise<string | null> => {
  return getUserSkillService().getSkillContent(skillId)
})

// 获取技能目录路径
ipcMain.handle('userSkill:getSkillsDir', async (): Promise<string> => {
  return getUserSkillService().getSkillsDir()
})

// ==================== 技能市场相关 ====================

function getMarketService() {
  return getSkillMarketService(configService, getUserSkillService())
}

ipcMain.handle('skillMarket:list', async (_event, force?: boolean): Promise<MarketSkillItem[]> => {
  return getMarketService().listSkills(force)
})

ipcMain.handle('skillMarket:search', async (_event, query: string): Promise<MarketSkillItem[]> => {
  return getMarketService().searchSkills(query)
})

ipcMain.handle('skillMarket:install', async (_event, skillId: string): Promise<SkillOperationResult> => {
  return getMarketService().installSkill(skillId)
})

ipcMain.handle('skillMarket:uninstall', async (_event, skillId: string): Promise<SkillOperationResult> => {
  return getMarketService().uninstallSkill(skillId)
})

ipcMain.handle('skillMarket:update', async (_event, skillId: string): Promise<SkillOperationResult> => {
  return getMarketService().updateSkill(skillId)
})

ipcMain.handle('skillMarket:getRegistryUrl', async (): Promise<string> => {
  return getMarketService().getRegistryUrl()
})

ipcMain.handle('skillMarket:setRegistryUrl', async (_event, url: string): Promise<void> => {
  getMarketService().setRegistryUrl(url)
})

ipcMain.handle('skillMarket:fetchRegistry', async (_event, force?: boolean): Promise<SkillRegistry> => {
  return getMarketService().fetchRegistry(force)
})

ipcMain.handle('skillMarket:preview', async (_event, skillId: string, source: SkillSource): Promise<SkillPreviewResult> => {
  return getMarketService().previewSkill(skillId, source)
})

ipcMain.handle('skillMarket:searchClawHub', async (_event, query: string): Promise<MarketSkill[]> => {
  return getMarketService().searchClawHub(query)
})

// ==================== 知识库相关 ====================

// 初始化知识库服务
ipcMain.handle('knowledge:initialize', async () => {
  try {
    const service = getKnowledge()
    await service.initialize()
    return { success: true }
  } catch (error) {
    return { 
      success: false, 
      error: errMsg(error, 'error.initFailed') 
    }
  }
})

// 获取知识库设置
ipcMain.handle('knowledge:getSettings', async () => {
  return getKnowledge().getSettings()
})

// 更新知识库设置
ipcMain.handle('knowledge:updateSettings', async (_event, settings: Partial<KnowledgeSettings>) => {
  try {
    await getKnowledge().updateSettings(settings)
    return { success: true }
  } catch (error) {
    log.error('Knowledge 更新设置失败:', error)
    return { 
      success: false, 
      error: errMsg(error, 'error.updateSettingsFailed') 
    }
  }
})

// 添加文档到知识库
ipcMain.handle('knowledge:addDocument', async (_event, doc: ParsedDocument, options?: AddDocumentOptions) => {
  try {
    const knowledgeService = getKnowledge()
    
    // 先检查是否重复
    const duplicateCheck = knowledgeService.isDuplicate(doc.content)
    if (duplicateCheck.isDuplicate && duplicateCheck.existingDoc) {
      return { 
        success: true, 
        docId: duplicateCheck.existingDoc.id,
        duplicate: true,
        existingFilename: duplicateCheck.existingDoc.filename
      }
    }
    
    const docId = await knowledgeService.addDocument(doc, options)
    return { success: true, docId, duplicate: false }
  } catch (error) {
    return { 
      success: false, 
      error: errMsg(error, 'error.addDocFailed') 
    }
  }
})

// 删除文档
ipcMain.handle('knowledge:removeDocument', async (_event, docId: string) => {
  try {
    const result = await getKnowledge().removeDocument(docId)
    return { success: result }
  } catch (error) {
    return { 
      success: false, 
      error: errMsg(error, 'error.deleteDocFailed') 
    }
  }
})

// 批量删除文档
ipcMain.handle('knowledge:removeDocuments', async (_event, docIds: string[]) => {
  try {
    const result = await getKnowledge().removeDocuments(docIds)
    // 只有全部删除成功才返回 success: true
    return { 
      success: result.failed === 0, 
      deleted: result.success, 
      failed: result.failed,
      error: result.failed > 0 ? t('error.docsDeletePartialFailed', { count: result.failed }) : undefined
    }
  } catch (error) {
    return { 
      success: false, 
      error: errMsg(error, 'error.batchDeleteDocFailed') 
    }
  }
})

// 搜索知识库
ipcMain.handle('knowledge:search', async (_event, query: string, options?: Partial<SearchOptions>) => {
  try {
    const results = await getKnowledge().search(query, options)
    return { success: true, results }
  } catch (error) {
    return { 
      success: false, 
      error: errMsg(error, 'error.searchFailed'),
      results: []
    }
  }
})

// 获取主机相关知识
ipcMain.handle('knowledge:getHostKnowledge', async (_event, hostId: string) => {
  try {
    const results = await getKnowledge().getHostKnowledge(hostId)
    return { success: true, results }
  } catch (error) {
    return { 
      success: false, 
      error: errMsg(error, 'error.getKnowledgeFailed'),
      results: []
    }
  }
})

// 构建 AI 上下文
ipcMain.handle('knowledge:buildContext', async (_event, query: string, options?: { hostId?: string; maxTokens?: number }) => {
  try {
    const context = await getKnowledge().buildContext(query, options)
    return { success: true, context }
  } catch (error) {
    return { 
      success: false, 
      error: errMsg(error, 'error.buildContextFailed'),
      context: ''
    }
  }
})

// 获取所有文档
ipcMain.handle('knowledge:getDocuments', async () => {
  const docs = getKnowledge().getDocuments()
  // 解密主机记忆内容（用于前端显示）
  return docs.map(doc => {
    if (doc.fileType === 'host-memory') {
      return {
        ...doc,
        content: decrypt(doc.content)
      }
    }
    return doc
  })
})

// 获取指定文档
ipcMain.handle('knowledge:getDocument', async (_event, docId: string) => {
  return getKnowledge().getDocument(docId)
})

// 获取统计信息
ipcMain.handle('knowledge:getStats', async () => {
  try {
    const stats = await getKnowledge().getStats()
    return { success: true, stats }
  } catch (error) {
    return { 
      success: false, 
      error: errMsg(error, 'error.getStatsFailed') 
    }
  }
})

// 清空知识库
ipcMain.handle('knowledge:clear', async () => {
  try {
    await getKnowledge().clear()
    return { success: true }
  } catch (error) {
    return { 
      success: false, 
      error: errMsg(error, 'error.clearFailed') 
    }
  }
})

// 导出知识库数据
ipcMain.handle('knowledge:exportData', async () => {
  try {
    const { dialog } = require('electron')
    const result = await dialog.showOpenDialog({
      title: t('dialog.selectExportDir'),
      properties: ['openDirectory', 'createDirectory']
    })
    
    if (result.canceled || !result.filePaths[0]) {
      return { canceled: true }
    }
    
    const path = require('path')
    const exportPath = path.join(result.filePaths[0], `knowledge-backup-${Date.now()}`)
    const exportResult = await getKnowledge().exportData(exportPath)
    
    return { ...exportResult, path: exportPath }
  } catch (error) {
    return { 
      success: false, 
      error: errMsg(error, 'error.exportFailed') 
    }
  }
})

// 导入知识库数据
ipcMain.handle('knowledge:importData', async () => {
  try {
    const { dialog } = require('electron')
    const result = await dialog.showOpenDialog({
      title: t('dialog.selectKnowledgeBackupDir'),
      properties: ['openDirectory']
    })
    
    if (result.canceled || !result.filePaths[0]) {
      return { canceled: true }
    }
    
    return await getKnowledge().importData(result.filePaths[0])
  } catch (error) {
    return { 
      success: false, 
      error: errMsg(error, 'error.importFailed') 
    }
  }
})

// 检查服务状态
// 检查知识库初始化是否完成
ipcMain.handle('knowledge:isInitialized', async () => {
  return isKnowledgeReady()
})

// 等待知识库初始化完成
ipcMain.handle('knowledge:waitInitialized', async () => {
  await waitForKnowledge()
  return true
})

ipcMain.handle('knowledge:isReady', async () => {
  try {
    return getKnowledge().isReady()
  } catch {
    return false
  }
})

// 检查服务是否启用
ipcMain.handle('knowledge:isEnabled', async () => {
  try {
    return getKnowledge().isEnabled()
  } catch {
    return false
  }
})

// 增量修复索引（只补充缺失文档，不清空已有数据）
ipcMain.handle('knowledge:repairIndex', async () => {
  try {
    await waitForKnowledge()
    const result = await getKnowledge().repairIndex()
    return { success: true, ...result }
  } catch (error) {
    log.error('knowledge:repairIndex failed:', error)
    return { success: false, error: (error as Error).message }
  }
})

// ==================== 模型管理相关 ====================

// 获取所有模型
ipcMain.handle('knowledge:getModels', async () => {
  return getKnowledge().getModels()
})

// 获取模型状态
ipcMain.handle('knowledge:getModelStatuses', async () => {
  return getKnowledge().getModelStatuses()
})

// 下载模型
ipcMain.handle('knowledge:downloadModel', async (event, modelId: ModelTier) => {
  try {
    await getKnowledge().downloadModel(modelId, (percent, downloaded, total) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send('knowledge:downloadProgress', { modelId, percent, downloaded, total })
      }
    })
    return { success: true }
  } catch (error) {
    return { 
      success: false, 
      error: errMsg(error, 'error.downloadFailed') 
    }
  }
})

// 切换模型
ipcMain.handle('knowledge:switchModel', async (_event, modelId: ModelTier) => {
  try {
    await getKnowledge().switchModel(modelId)
    return { success: true }
  } catch (error) {
    return { 
      success: false, 
      error: errMsg(error, 'error.switchModelFailed') 
    }
  }
})

// ==================== 知识文档（L2 Context Knowledge） ====================

ipcMain.handle('contextKnowledge:list', async () => {
  try {
    const service = getContextKnowledgeService()
    const ids = service.listContextIds()
    const items = ids.map(id => ({
      contextId: id,
      content: service.getDocument(id)
    }))
    return { success: true, items, maxDocChars: service.getMaxDocChars() }
  } catch (error) {
    return { success: false, error: errMsg(error, 'error.getListFailed'), items: [], maxDocChars: 5000 }
  }
})

ipcMain.handle('contextKnowledge:get', async (_event, contextId: string) => {
  try {
    return { success: true, content: getContextKnowledgeService().getDocument(contextId) }
  } catch (error) {
    return { success: false, error: errMsg(error, 'error.getDocFailed'), content: '' }
  }
})

ipcMain.handle('contextKnowledge:set', async (_event, contextId: string, content: string) => {
  try {
    getContextKnowledgeService().setDocument(contextId, content)
    return { success: true }
  } catch (error) {
    return { success: false, error: errMsg(error, 'error.saveDocFailed') }
  }
})

ipcMain.handle('contextKnowledge:delete', async (_event, contextId: string) => {
  try {
    getContextKnowledgeService().deleteDocument(contextId)
    return { success: true }
  } catch (error) {
    return { success: false, error: errMsg(error, 'error.deleteDocFailed') }
  }
})

// ==================== 邮箱相关 ====================

// 设置邮箱凭据
ipcMain.handle('email:setCredential', async (_event, accountId: string, credential: string) => {
  await setEmailCredential(accountId, credential)
})

// 删除邮箱凭据
ipcMain.handle('email:deleteCredential', async (_event, accountId: string) => {
  return await deleteEmailCredential(accountId)
})

// 同步邮箱账户配置到 email skill + email sensor
ipcMain.handle('email:syncAccounts', async (_event, accounts: Array<{
  id: string
  name: string
  email: string
  provider: string
  authType: 'password' | 'oauth2'
  imapHost?: string
  imapPort?: number
  smtpHost?: string
  smtpPort?: number
  smtpSecure?: boolean
  rejectUnauthorized?: boolean
}>) => {
  setEmailAccounts(accounts)

  // 同步到 EmailSensor（利用 email skill 的 getServerConfig 填充 IMAP host/port）
  try {

    const sensorAccounts = accounts.map(a => {
      const server = getServerConfig(a.provider, {
        imapHost: a.imapHost,
        imapPort: a.imapPort
      })
      return {
        accountId: a.id,
        email: a.email,
        provider: a.provider,
        imapHost: server.imapHost,
        imapPort: server.imapPort,
        rejectUnauthorized: a.rejectUnauthorized
      }
    }).filter(a => a.imapHost)

    await sensorService.email.configureAccounts(
      sensorAccounts,
      (accountId) => getEmailCredential(accountId)
    )

    log.info(`Email: Synced ${accounts.length} account(s) to skill + ${sensorAccounts.length} to sensor`)
  } catch (err) {
    log.error('Email: Failed to sync accounts to sensor:', err)
  }
})

// 测试邮箱连接
ipcMain.handle('email:testConnection', async (_event, config: {
  email: string
  password: string
  provider?: string
  imapHost?: string
  imapPort?: number
  rejectUnauthorized?: boolean
}) => {
  try {
    const serverConfig = getServerConfig(config.provider || 'gmail', {
      imapHost: config.imapHost,
      imapPort: config.imapPort
    })

    const { ImapFlow } = await import('imapflow')
    const client = new ImapFlow({
      host: serverConfig.imapHost,
      port: serverConfig.imapPort,
      secure: true,
      auth: {
        user: config.email,
        pass: config.password
      },
      logger: false,
      tls: {
        rejectUnauthorized: config.rejectUnauthorized !== false
      }
    })

    await client.connect()
    await client.logout()

    return { success: true, message: t('msg.connectSuccess') }
  } catch (error) {
    return { 
      success: false, 
      message: errMsg(error, 'error.connectFailed')
    }
  }
})

// 验证已保存的邮箱账户（从 keychain 读取密码）
ipcMain.handle('email:verifyAccount', async (_event, account: {
  id: string
  email: string
  provider?: string
  imapHost?: string
  imapPort?: number
  rejectUnauthorized?: boolean
}) => {
  if (!account.id || !account.email) {
    return { success: false, message: t('error.invalidAccount') }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let client: any = null
  try {
    const password = await getEmailCredential(account.id)
    if (!password) {
      return { success: false, message: t('error.credentialsNotFound') }
    }

    const serverConfig = getServerConfig(account.provider || 'gmail', {
      imapHost: account.imapHost,
      imapPort: account.imapPort
    })

    const { ImapFlow } = await import('imapflow')
    client = new ImapFlow({
      host: serverConfig.imapHost,
      port: serverConfig.imapPort,
      secure: true,
      auth: {
        user: account.email,
        pass: password
      },
      logger: false,
      tls: {
        rejectUnauthorized: account.rejectUnauthorized !== false
      }
    })

    await client.connect()
    return { success: true, message: t('msg.connectOk') }
  } catch (error) {
    return {
      success: false,
      message: errMsg(error, 'error.connectFailed')
    }
  } finally {
    try { await client?.logout() } catch { /* ignore logout errors */ }
  }
})

// ==================== 日历相关 ====================

// 设置日历凭据
ipcMain.handle('calendar:setCredential', async (_event, accountId: string, credential: string) => {
  await setCalendarCredential(accountId, credential)
})

// 删除日历凭据
ipcMain.handle('calendar:deleteCredential', async (_event, accountId: string) => {
  return await deleteCalendarCredential(accountId)
})

// 同步日历账户配置到 calendar skill + calendar sensor
ipcMain.handle('calendar:syncAccounts', async (_event, accounts: Array<{
  id: string
  name: string
  provider: string
  username: string
  serverUrl?: string
}>) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setCalendarAccounts(accounts as any)

  // 同步到 CalendarSensor
  try {
    const sensorAccounts = accounts.map(a => ({
      accountId: a.id,
      name: a.name,
      provider: a.provider,
      username: a.username,
      serverUrl: a.serverUrl
    }))

    await sensorService.calendar.configureAccounts(
      sensorAccounts,
      (accountId) => getCalendarCredential(accountId)
    )

    log.info(`Calendar: Synced ${accounts.length} account(s) to skill + sensor`)
  } catch (err) {
    log.error('Calendar: Failed to sync accounts to sensor:', err)
  }
})

// 测试日历连接
ipcMain.handle('calendar:testConnection', async (_event, config: {
  username: string
  password: string
  provider?: string
  serverUrl?: string
}) => {
  try {
    const tsdav = await import('tsdav')
    
    const client = new tsdav.DAVClient({
      serverUrl: config.serverUrl || 'https://caldav.wecom.work',
      credentials: {
        username: config.username,
        password: config.password
      },
      authMethod: 'Basic',
      defaultAccountType: 'caldav'
    })

    await client.login()
    const calendars = await client.fetchCalendars()
    
    return { 
      success: true, 
      message: t('msg.calendarsConnectSuccess', { count: calendars.length }) 
    }
  } catch (error) {
    return { 
      success: false, 
      message: errMsg(error, 'error.connectFailed')
    }
  }
})

// 验证已保存的日历账户（从 keychain 读取密码）
ipcMain.handle('calendar:verifyAccount', async (_event, account: {
  id: string
  username: string
  provider?: string
  serverUrl?: string
}) => {
  if (!account.id || !account.username) {
    return { success: false, message: t('error.invalidAccount') }
  }

  try {
    const password = await getCalendarCredential(account.id)
    if (!password) {
      return { success: false, message: t('error.credentialsNotFound') }
    }

    const tsdav = await import('tsdav')
    const client = new tsdav.DAVClient({
      serverUrl: account.serverUrl || 'https://caldav.wecom.work',
      credentials: {
        username: account.username,
        password
      },
      authMethod: 'Basic',
      defaultAccountType: 'caldav'
    })

    await client.login()
    const calendars = await client.fetchCalendars()

    return {
      success: true,
      message: t('msg.calendarsConnectOk', { count: calendars.length })
    }
  } catch (error) {
    return {
      success: false,
      message: errMsg(error, 'error.connectFailed')
    }
  }
})

// ==================== 语音识别相关 ====================
// 使用 sherpa-onnx-node + Paraformer 模型

// 获取语音识别状态
ipcMain.handle('speech:getStatus', async () => {
  const { getStatus } = await import('./services/speech')
  return getStatus()
})

// 获取模型信息
ipcMain.handle('speech:getModelInfo', async () => {
  const { getModelInfo } = await import('./services/speech')
  return getModelInfo()
})

// 初始化语音识别服务
ipcMain.handle('speech:initialize', async () => {
  const { initialize } = await import('./services/speech')
  return initialize()
})

// 转录音频数据
ipcMain.handle('speech:transcribe', async (_event, audioData: number[], sampleRate: number = 16000) => {
  try {
    const { transcribe } = await import('./services/speech')
    const float32Data = new Float32Array(audioData)
    return await transcribe(float32Data, sampleRate)
  } catch (error) {
    return { 
      success: false, 
      error: errMsg(error, 'error.transcribeFailed') 
    }
  }
})

// 检查服务是否就绪
ipcMain.handle('speech:isReady', async () => {
  const { isReady } = await import('./services/speech')
  return isReady()
})

// ==================== TTS 语音合成 ====================

async function ensureTtsService() {
  const tts = await import('./services/tts')
  tts.ensureInitialized()
  const proxyGet = () => configService.getProxySettings()
  const { setProxyGetter } = await import('./services/tts/openai-provider')
  const { setVolcengineProxyGetter } = await import('./services/tts/volcengine-provider')
  const { setDashScopeProxyGetter } = await import('./services/tts/dashscope-provider')
  setProxyGetter(proxyGet)
  setVolcengineProxyGetter(proxyGet)
  setDashScopeProxyGetter(proxyGet)
  const settings = configService.get('ttsSettings')
  if (settings) tts.updateSettings(settings)
  return tts
}

ipcMain.handle('tts:synthesize', async (_event, text: string, options?: { voice?: string; model?: string; speed?: number }) => {
  try {
    const tts = await ensureTtsService()
    const result = await tts.synthesize(text, options)
    return {
      success: true,
      audio: result.audio.buffer.slice(result.audio.byteOffset, result.audio.byteOffset + result.audio.byteLength),
      format: result.format,
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
})

ipcMain.handle('tts:getVoices', async () => {
  try {
    const tts = await ensureTtsService()
    return await tts.getVoices()
  } catch {
    return []
  }
})

ipcMain.handle('tts:getProviders', async () => {
  try {
    const tts = await ensureTtsService()
    return tts.getProviders()
  } catch {
    return []
  }
})

ipcMain.handle('tts:stop', async () => {
  try {
    const tts = await import('./services/tts')
    tts.stopSynthesis()
  } catch { /* ignore */ }
})

// ==================== Web Search ====================

ipcMain.handle('webSearch:updateSettings', async (_event, settings: WebSearchSettings) => {
  configService.set('webSearchSettings', settings)
  const webSearch = await import('./services/web-search/index')
  webSearch.updateSettings(settings)
})

