import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

export interface AiProfile {
  id: string
  name: string
  apiUrl: string
  apiKey: string
  model: string
  proxy?: string
  contextLength?: number  // 模型上下文长度（tokens），默认 8000
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

export const useConfigStore = defineStore('config', () => {
  // AI 配置
  const aiProfiles = ref<AiProfile[]>([])
  const activeAiProfileId = ref<string>('')

  // SSH 会话
  const sshSessions = ref<SshSession[]>([])

  // 主题
  const currentTheme = ref<string>('one-dark')

  // 终端设置
  const terminalSettings = ref<TerminalSettings>({
    fontSize: 14,
    fontFamily: '"Cascadia Code", "Fira Code", "JetBrains Mono", Consolas, monospace',
    cursorBlink: true,
    cursorStyle: 'block',
    scrollback: 10000
  })

  // 计算属性
  const activeAiProfile = computed(() =>
    aiProfiles.value.find(p => p.id === activeAiProfileId.value)
  )

  const hasAiConfig = computed(() => aiProfiles.value.length > 0)

  /**
   * 加载所有配置
   */
  async function loadConfig(): Promise<void> {
    try {
      // 加载 AI 配置
      const profiles = await window.electronAPI.config.getAiProfiles()
      aiProfiles.value = profiles || []

      const activeId = await window.electronAPI.config.getActiveAiProfile()
      activeAiProfileId.value = activeId || ''

      // 加载 SSH 会话
      const sessions = await window.electronAPI.config.getSshSessions()
      sshSessions.value = sessions || []

      // 加载主题
      const theme = await window.electronAPI.config.getTheme()
      currentTheme.value = theme || 'one-dark'
    } catch (error) {
      console.error('Failed to load config:', error)
    }
  }

  // ==================== AI 配置 ====================

  async function saveAiProfiles(): Promise<void> {
    // 转换为普通对象，避免序列化错误
    const plainProfiles = JSON.parse(JSON.stringify(aiProfiles.value))
    await window.electronAPI.config.setAiProfiles(plainProfiles)
  }

  async function addAiProfile(profile: AiProfile): Promise<void> {
    aiProfiles.value.push(profile)
    await saveAiProfiles()

    // 如果是第一个，自动设为激活
    if (aiProfiles.value.length === 1) {
      await setActiveAiProfile(profile.id)
    }
  }

  async function updateAiProfile(profile: AiProfile): Promise<void> {
    const index = aiProfiles.value.findIndex(p => p.id === profile.id)
    if (index !== -1) {
      aiProfiles.value[index] = profile
      await saveAiProfiles()
    }
  }

  async function deleteAiProfile(id: string): Promise<void> {
    aiProfiles.value = aiProfiles.value.filter(p => p.id !== id)
    await saveAiProfiles()

    // 如果删除的是当前激活的，切换到第一个
    if (activeAiProfileId.value === id && aiProfiles.value.length > 0) {
      await setActiveAiProfile(aiProfiles.value[0].id)
    }
  }

  async function setActiveAiProfile(id: string): Promise<void> {
    activeAiProfileId.value = id
    await window.electronAPI.config.setActiveAiProfile(id)
  }

  // ==================== SSH 会话 ====================

  async function saveSshSessions(): Promise<void> {
    // 转换为普通对象，避免序列化错误
    const plainSessions = JSON.parse(JSON.stringify(sshSessions.value))
    await window.electronAPI.config.setSshSessions(plainSessions)
  }

  async function addSshSession(session: SshSession): Promise<void> {
    sshSessions.value.push(session)
    await saveSshSessions()
  }

  async function updateSshSession(session: SshSession): Promise<void> {
    const index = sshSessions.value.findIndex(s => s.id === session.id)
    if (index !== -1) {
      sshSessions.value[index] = session
      await saveSshSessions()
    }
  }

  async function deleteSshSession(id: string): Promise<void> {
    sshSessions.value = sshSessions.value.filter(s => s.id !== id)
    await saveSshSessions()
  }

  // ==================== 主题 ====================

  async function setTheme(theme: string): Promise<void> {
    currentTheme.value = theme
    await window.electronAPI.config.setTheme(theme)
  }

  return {
    // 状态
    aiProfiles,
    activeAiProfileId,
    activeAiProfile,
    hasAiConfig,
    sshSessions,
    currentTheme,
    terminalSettings,

    // 方法
    loadConfig,
    addAiProfile,
    updateAiProfile,
    deleteAiProfile,
    setActiveAiProfile,
    addSshSession,
    updateSshSession,
    deleteSshSession,
    setTheme
  }
})

