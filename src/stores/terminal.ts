import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { v4 as uuidv4 } from 'uuid'

export type ShellType = 'powershell' | 'cmd' | 'bash' | 'zsh' | 'sh' | 'unknown'
export type OSType = 'windows' | 'linux' | 'macos' | 'unknown'

export interface SystemInfo {
  os: OSType
  shell: ShellType
  shellPath?: string
  description: string
}

export interface TerminalTab {
  id: string
  title: string
  type: 'local' | 'ssh'
  ptyId?: string
  sshConfig?: {
    host: string
    port: number
    username: string
  }
  systemInfo?: SystemInfo
  isConnected: boolean
  isLoading: boolean
}

export interface SplitPane {
  id: string
  type: 'terminal' | 'split'
  direction?: 'horizontal' | 'vertical'
  children?: SplitPane[]
  tabId?: string
  size?: number
}

export const useTerminalStore = defineStore('terminal', () => {
  // 状态
  const tabs = ref<TerminalTab[]>([])
  const activeTabId = ref<string>('')
  const splitLayout = ref<SplitPane | null>(null)

  // 计算属性
  const activeTab = computed(() => tabs.value.find(t => t.id === activeTabId.value))
  const tabCount = computed(() => tabs.value.length)

  /**
   * 检测本地系统信息
   */
  function detectLocalSystemInfo(): SystemInfo {
    const platform = navigator.platform.toLowerCase()
    
    if (platform.includes('win')) {
      // Windows 系统，COMSPEC 环境变量默认指向 cmd.exe
      return {
        os: 'windows',
        shell: 'cmd',
        shellPath: 'cmd.exe',
        description: 'Windows CMD 命令提示符'
      }
    } else if (platform.includes('mac')) {
      return {
        os: 'macos',
        shell: 'zsh',
        shellPath: '/bin/zsh',
        description: 'macOS Zsh 终端'
      }
    } else if (platform.includes('linux')) {
      return {
        os: 'linux',
        shell: 'bash',
        shellPath: '/bin/bash',
        description: 'Linux Bash 终端'
      }
    }
    
    return {
      os: 'unknown',
      shell: 'unknown',
      description: '未知终端类型'
    }
  }

  /**
   * 更新终端系统信息
   */
  function updateSystemInfo(tabId: string, systemInfo: Partial<SystemInfo>): void {
    const tab = tabs.value.find(t => t.id === tabId)
    if (tab) {
      tab.systemInfo = {
        ...tab.systemInfo,
        ...systemInfo
      } as SystemInfo
    }
  }

  /**
   * 创建新标签页
   */
  async function createTab(
    type: 'local' | 'ssh',
    sshConfig?: { host: string; port: number; username: string; password?: string; privateKey?: string }
  ): Promise<string> {
    const id = uuidv4()
    const tab: TerminalTab = {
      id,
      title: type === 'local' ? '本地终端' : `${sshConfig?.username}@${sshConfig?.host}`,
      type,
      isConnected: false,
      isLoading: true
    }

    if (type === 'ssh' && sshConfig) {
      tab.sshConfig = {
        host: sshConfig.host,
        port: sshConfig.port,
        username: sshConfig.username
      }
    }

    tabs.value.push(tab)
    activeTabId.value = id

    // 获取响应式 tab 对象的引用
    const reactiveTab = tabs.value.find(t => t.id === id)!

    // 初始化终端连接
    try {
      if (type === 'local') {
        const ptyId = await window.electronAPI.pty.create({
          cols: 80,
          rows: 24
        })
        reactiveTab.ptyId = ptyId
        reactiveTab.isConnected = true
        // 检测本地系统信息
        reactiveTab.systemInfo = detectLocalSystemInfo()
      } else if (type === 'ssh' && sshConfig) {
        const sshId = await window.electronAPI.ssh.connect({
          host: sshConfig.host,
          port: sshConfig.port,
          username: sshConfig.username,
          password: sshConfig.password,
          privateKey: sshConfig.privateKey,
          cols: 80,
          rows: 24
        })
        reactiveTab.ptyId = sshId
        reactiveTab.isConnected = true
        // SSH 连接默认假设是 Linux/Unix 系统
        reactiveTab.systemInfo = {
          os: 'linux',
          shell: 'bash',
          description: `SSH 连接: ${sshConfig.username}@${sshConfig.host}`
        }
      }
    } catch (error) {
      console.error('Failed to create terminal:', error)
      reactiveTab.isConnected = false
    } finally {
      reactiveTab.isLoading = false
    }

    return id
  }

  /**
   * 关闭标签页
   */
  async function closeTab(tabId: string): Promise<void> {
    const tab = tabs.value.find(t => t.id === tabId)
    if (!tab) return

    // 清理终端连接
    if (tab.ptyId) {
      if (tab.type === 'local') {
        await window.electronAPI.pty.dispose(tab.ptyId)
      } else {
        await window.electronAPI.ssh.disconnect(tab.ptyId)
      }
    }

    // 移除标签
    const index = tabs.value.findIndex(t => t.id === tabId)
    tabs.value.splice(index, 1)

    // 如果关闭的是当前标签，切换到其他标签
    if (activeTabId.value === tabId) {
      if (tabs.value.length > 0) {
        const newIndex = Math.min(index, tabs.value.length - 1)
        activeTabId.value = tabs.value[newIndex].id
      } else {
        activeTabId.value = ''
      }
    }
  }

  /**
   * 切换标签页
   */
  function setActiveTab(tabId: string): void {
    if (tabs.value.find(t => t.id === tabId)) {
      activeTabId.value = tabId
    }
  }

  /**
   * 更新标签标题
   */
  function updateTabTitle(tabId: string, title: string): void {
    const tab = tabs.value.find(t => t.id === tabId)
    if (tab) {
      tab.title = title
    }
  }

  /**
   * 向终端写入数据
   */
  async function writeToTerminal(tabId: string, data: string): Promise<void> {
    const tab = tabs.value.find(t => t.id === tabId)
    if (!tab?.ptyId) return

    if (tab.type === 'local') {
      await window.electronAPI.pty.write(tab.ptyId, data)
    } else {
      await window.electronAPI.ssh.write(tab.ptyId, data)
    }
  }

  /**
   * 调整终端大小
   */
  async function resizeTerminal(tabId: string, cols: number, rows: number): Promise<void> {
    const tab = tabs.value.find(t => t.id === tabId)
    if (!tab?.ptyId) return

    if (tab.type === 'local') {
      await window.electronAPI.pty.resize(tab.ptyId, cols, rows)
    } else {
      await window.electronAPI.ssh.resize(tab.ptyId, cols, rows)
    }
  }

  /**
   * 创建分屏
   */
  function splitTerminal(direction: 'horizontal' | 'vertical'): void {
    // TODO: 实现分屏逻辑
    console.log('Split terminal:', direction)
  }

  return {
    tabs,
    activeTabId,
    activeTab,
    tabCount,
    splitLayout,
    createTab,
    closeTab,
    setActiveTab,
    updateTabTitle,
    updateSystemInfo,
    writeToTerminal,
    resizeTerminal,
    splitTerminal
  }
})

