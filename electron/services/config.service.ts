import Store from 'electron-store'
import { safeStorage } from 'electron'

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

export interface TerminalSettings {
  fontSize: number
  fontFamily: string
  cursorBlink: boolean
  cursorStyle: 'block' | 'underline' | 'bar'
  scrollback: number
}

interface StoreSchema {
  aiProfiles: AiProfile[]
  activeAiProfile: string
  sshSessions: SshSession[]
  theme: string
  terminalSettings: TerminalSettings
  proxySettings: {
    enabled: boolean
    url: string
  }
}

const defaultConfig: StoreSchema = {
  aiProfiles: [],
  activeAiProfile: '',
  sshSessions: [],
  theme: 'one-dark',
  terminalSettings: {
    fontSize: 14,
    fontFamily: '"Cascadia Code", "Fira Code", "JetBrains Mono", Consolas, monospace',
    cursorBlink: true,
    cursorStyle: 'block',
    scrollback: 10000
  },
  proxySettings: {
    enabled: false,
    url: ''
  }
}

export class ConfigService {
  private store: Store<StoreSchema>

  constructor() {
    // 使用 safeStorage 生成加密密钥
    let encryptionKey: string | undefined
    
    try {
      if (safeStorage.isEncryptionAvailable()) {
        // 使用固定标识符生成一致的加密密钥
        const keyBuffer = safeStorage.encryptString('qiyu-terminal-encryption-key-v1')
        encryptionKey = keyBuffer.toString('hex').substring(0, 32) // 取前32字符作为密钥
      }
    } catch (e) {
      console.warn('safeStorage not available, using unencrypted storage')
    }

    this.store = new Store<StoreSchema>({
      name: 'qiyu-terminal-config',
      defaults: defaultConfig,
      encryptionKey // 启用加密存储
    })
  }

  /**
   * 获取配置项
   */
  get<K extends keyof StoreSchema>(key: K): StoreSchema[K] {
    return this.store.get(key)
  }

  /**
   * 设置配置项
   */
  set<K extends keyof StoreSchema>(key: K, value: StoreSchema[K]): void {
    this.store.set(key, value)
  }

  /**
   * 获取所有配置
   */
  getAll(): StoreSchema {
    return this.store.store
  }

  // ==================== AI 配置 ====================

  /**
   * 获取所有 AI Profiles
   */
  getAiProfiles(): AiProfile[] {
    return this.store.get('aiProfiles') || []
  }

  /**
   * 设置 AI Profiles
   */
  setAiProfiles(profiles: AiProfile[]): void {
    this.store.set('aiProfiles', profiles)
  }

  /**
   * 添加 AI Profile
   */
  addAiProfile(profile: AiProfile): void {
    const profiles = this.getAiProfiles()
    profiles.push(profile)
    this.setAiProfiles(profiles)
  }

  /**
   * 更新 AI Profile
   */
  updateAiProfile(profile: AiProfile): void {
    const profiles = this.getAiProfiles()
    const index = profiles.findIndex(p => p.id === profile.id)
    if (index !== -1) {
      profiles[index] = profile
      this.setAiProfiles(profiles)
    }
  }

  /**
   * 删除 AI Profile
   */
  deleteAiProfile(id: string): void {
    const profiles = this.getAiProfiles()
    const filtered = profiles.filter(p => p.id !== id)
    this.setAiProfiles(filtered)
  }

  /**
   * 获取当前激活的 AI Profile ID
   */
  getActiveAiProfile(): string {
    return this.store.get('activeAiProfile') || ''
  }

  /**
   * 设置当前激活的 AI Profile ID
   */
  setActiveAiProfile(profileId: string): void {
    this.store.set('activeAiProfile', profileId)
  }

  // ==================== SSH 会话配置 ====================

  /**
   * 获取所有 SSH 会话
   */
  getSshSessions(): SshSession[] {
    return this.store.get('sshSessions') || []
  }

  /**
   * 设置 SSH 会话
   */
  setSshSessions(sessions: SshSession[]): void {
    this.store.set('sshSessions', sessions)
  }

  /**
   * 添加 SSH 会话
   */
  addSshSession(session: SshSession): void {
    const sessions = this.getSshSessions()
    sessions.push(session)
    this.setSshSessions(sessions)
  }

  /**
   * 更新 SSH 会话
   */
  updateSshSession(session: SshSession): void {
    const sessions = this.getSshSessions()
    const index = sessions.findIndex(s => s.id === session.id)
    if (index !== -1) {
      sessions[index] = session
      this.setSshSessions(sessions)
    }
  }

  /**
   * 删除 SSH 会话
   */
  deleteSshSession(id: string): void {
    const sessions = this.getSshSessions()
    const filtered = sessions.filter(s => s.id !== id)
    this.setSshSessions(filtered)
  }

  // ==================== 主题配置 ====================

  /**
   * 获取当前主题
   */
  getTheme(): string {
    return this.store.get('theme') || 'one-dark'
  }

  /**
   * 设置主题
   */
  setTheme(theme: string): void {
    this.store.set('theme', theme)
  }

  // ==================== 终端设置 ====================

  /**
   * 获取终端设置
   */
  getTerminalSettings(): TerminalSettings {
    return this.store.get('terminalSettings') || defaultConfig.terminalSettings
  }

  /**
   * 设置终端设置
   */
  setTerminalSettings(settings: TerminalSettings): void {
    this.store.set('terminalSettings', settings)
  }

  // ==================== 代理设置 ====================

  /**
   * 获取代理设置
   */
  getProxySettings(): { enabled: boolean; url: string } {
    return this.store.get('proxySettings') || defaultConfig.proxySettings
  }

  /**
   * 设置代理设置
   */
  setProxySettings(settings: { enabled: boolean; url: string }): void {
    this.store.set('proxySettings', settings)
  }
}

