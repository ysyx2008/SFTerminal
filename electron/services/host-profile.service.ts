import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'

// ==================== 类型定义 ====================

export interface HostProfile {
  hostId: string              // 唯一标识: local 或 user@host
  hostname: string            // 主机名
  username: string            // 用户名
  os: string                  // 操作系统
  osVersion: string           // 系统版本
  shell: string               // 默认 shell
  packageManager?: string     // 包管理器
  installedTools: string[]    // 已安装的常用工具
  homeDir?: string            // 用户主目录
  currentDir?: string         // 当前工作目录
  notes: string[]             // Agent 学习到的重要信息
  lastProbed: number          // 上次探测时间
  lastUpdated: number         // 上次更新时间
}

export interface ProbeResult {
  hostname?: string
  username?: string
  os?: string
  osVersion?: string
  shell?: string
  packageManager?: string
  installedTools?: string[]
  homeDir?: string
  currentDir?: string
}

// ==================== 主机档案服务 ====================

export class HostProfileService {
  private profilesDir: string
  private profiles: Map<string, HostProfile> = new Map()

  constructor() {
    const userDataPath = app.getPath('userData')
    this.profilesDir = path.join(userDataPath, 'host-profiles')
    this.ensureDirectory()
    this.loadAllProfiles()
  }

  /**
   * 确保目录存在
   */
  private ensureDirectory(): void {
    if (!fs.existsSync(this.profilesDir)) {
      fs.mkdirSync(this.profilesDir, { recursive: true })
    }
  }

  /**
   * 生成主机 ID
   */
  generateHostId(type: 'local' | 'ssh', sshHost?: string, sshUser?: string): string {
    if (type === 'local') {
      return 'local'
    }
    return `${sshUser || 'unknown'}@${sshHost || 'unknown'}`
  }

  /**
   * 获取档案文件路径
   */
  private getProfilePath(hostId: string): string {
    // 将特殊字符替换为安全字符
    const safeId = hostId.replace(/[@:]/g, '_')
    return path.join(this.profilesDir, `${safeId}.json`)
  }

  /**
   * 加载所有档案
   */
  private loadAllProfiles(): void {
    try {
      const files = fs.readdirSync(this.profilesDir).filter(f => f.endsWith('.json'))
      for (const file of files) {
        const filePath = path.join(this.profilesDir, file)
        const content = fs.readFileSync(filePath, 'utf-8')
        const profile = JSON.parse(content) as HostProfile
        this.profiles.set(profile.hostId, profile)
      }
    } catch (e) {
      console.error('加载主机档案失败:', e)
    }
  }

  /**
   * 保存档案
   */
  private saveProfile(profile: HostProfile): void {
    try {
      const filePath = this.getProfilePath(profile.hostId)
      fs.writeFileSync(filePath, JSON.stringify(profile, null, 2), 'utf-8')
      this.profiles.set(profile.hostId, profile)
    } catch (e) {
      console.error('保存主机档案失败:', e)
    }
  }

  /**
   * 获取档案
   */
  getProfile(hostId: string): HostProfile | null {
    return this.profiles.get(hostId) || null
  }

  /**
   * 获取所有档案
   */
  getAllProfiles(): HostProfile[] {
    return Array.from(this.profiles.values())
  }

  /**
   * 创建或更新档案
   */
  updateProfile(hostId: string, updates: Partial<HostProfile>): HostProfile {
    const existing = this.profiles.get(hostId)
    const now = Date.now()

    const profile: HostProfile = {
      hostId,
      hostname: updates.hostname || existing?.hostname || '',
      username: updates.username || existing?.username || '',
      os: updates.os || existing?.os || 'unknown',
      osVersion: updates.osVersion || existing?.osVersion || '',
      shell: updates.shell || existing?.shell || 'unknown',
      packageManager: updates.packageManager || existing?.packageManager,
      installedTools: updates.installedTools || existing?.installedTools || [],
      homeDir: updates.homeDir || existing?.homeDir,
      currentDir: updates.currentDir || existing?.currentDir,
      notes: updates.notes || existing?.notes || [],
      lastProbed: updates.lastProbed || existing?.lastProbed || now,
      lastUpdated: now
    }

    this.saveProfile(profile)
    return profile
  }

  /**
   * 添加笔记（Agent 学习到的信息）
   */
  addNote(hostId: string, note: string): void {
    const profile = this.profiles.get(hostId)
    if (!profile) return

    // 避免重复
    if (!profile.notes.includes(note)) {
      profile.notes.push(note)
      // 只保留最近 20 条
      if (profile.notes.length > 20) {
        profile.notes = profile.notes.slice(-20)
      }
      profile.lastUpdated = Date.now()
      this.saveProfile(profile)
    }
  }

  /**
   * 更新已安装工具
   */
  updateInstalledTools(hostId: string, tools: string[]): void {
    const profile = this.profiles.get(hostId)
    if (!profile) return

    // 合并工具列表
    const allTools = new Set([...profile.installedTools, ...tools])
    profile.installedTools = Array.from(allTools)
    profile.lastUpdated = Date.now()
    this.saveProfile(profile)
  }

  /**
   * 删除档案
   */
  deleteProfile(hostId: string): void {
    const filePath = this.getProfilePath(hostId)
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath)
      }
      this.profiles.delete(hostId)
    } catch (e) {
      console.error('删除主机档案失败:', e)
    }
  }

  /**
   * 生成探测命令
   */
  getProbeCommands(os: string = 'linux'): string[] {
    const isWindows = os.toLowerCase().includes('windows')
    
    if (isWindows) {
      return [
        'hostname',
        'whoami',
        'echo %OS%',
        'echo %USERPROFILE%',
        'cd',
        // 检测常用工具
        'where git 2>nul && echo [HAS_GIT]',
        'where docker 2>nul && echo [HAS_DOCKER]',
        'where python 2>nul && echo [HAS_PYTHON]',
        'where node 2>nul && echo [HAS_NODE]',
      ]
    }

    // Unix/Linux/macOS
    return [
      'hostname 2>/dev/null || echo "unknown"',
      'whoami 2>/dev/null || echo "unknown"',
      'uname -s 2>/dev/null || echo "unknown"',
      // 系统版本
      'cat /etc/os-release 2>/dev/null | grep -E "^(NAME|VERSION)=" | head -2 || sw_vers 2>/dev/null || echo "unknown"',
      'echo $SHELL',
      'echo $HOME',
      'pwd',
      // 检测包管理器
      'command -v apt >/dev/null 2>&1 && echo "[PKG_APT]"',
      'command -v yum >/dev/null 2>&1 && echo "[PKG_YUM]"',
      'command -v dnf >/dev/null 2>&1 && echo "[PKG_DNF]"',
      'command -v brew >/dev/null 2>&1 && echo "[PKG_BREW]"',
      'command -v pacman >/dev/null 2>&1 && echo "[PKG_PACMAN]"',
      // 检测常用工具
      'command -v git >/dev/null 2>&1 && echo "[HAS_GIT]"',
      'command -v docker >/dev/null 2>&1 && echo "[HAS_DOCKER]"',
      'command -v python3 >/dev/null 2>&1 && echo "[HAS_PYTHON3]"',
      'command -v python >/dev/null 2>&1 && echo "[HAS_PYTHON]"',
      'command -v node >/dev/null 2>&1 && echo "[HAS_NODE]"',
      'command -v nginx >/dev/null 2>&1 && echo "[HAS_NGINX]"',
      'command -v systemctl >/dev/null 2>&1 && echo "[HAS_SYSTEMD]"',
      'command -v vim >/dev/null 2>&1 && echo "[HAS_VIM]"',
      'command -v nano >/dev/null 2>&1 && echo "[HAS_NANO]"',
    ]
  }

  /**
   * 解析探测结果
   */
  parseProbeOutput(output: string, existingProfile?: HostProfile | null): ProbeResult {
    const result: ProbeResult = {}
    const lines = output.split('\n').map(l => l.trim()).filter(l => l)

    // 解析主机名
    const hostnameLine = lines.find(l => !l.includes('=') && !l.startsWith('[') && !l.includes('/'))
    if (hostnameLine && hostnameLine.length < 100) {
      result.hostname = hostnameLine
    }

    // 解析用户名（通常是第二个非标记行）
    const userLine = lines.find((l, i) => i > 0 && !l.includes('=') && !l.startsWith('[') && !l.includes('/') && l !== result.hostname)
    if (userLine && userLine.length < 50) {
      result.username = userLine
    }

    // 解析操作系统
    if (output.includes('Darwin')) {
      result.os = 'macos'
    } else if (output.includes('Linux')) {
      result.os = 'linux'
    } else if (output.includes('Windows')) {
      result.os = 'windows'
    }

    // 解析系统版本
    const nameMatch = output.match(/NAME="?([^"\n]+)"?/)
    const versionMatch = output.match(/VERSION="?([^"\n]+)"?/)
    if (nameMatch && versionMatch) {
      result.osVersion = `${nameMatch[1]} ${versionMatch[1]}`
    } else if (output.includes('ProductName')) {
      // macOS
      const productMatch = output.match(/ProductName:\s*(.+)/)
      const versionMatch2 = output.match(/ProductVersion:\s*(.+)/)
      if (productMatch) {
        result.osVersion = `${productMatch[1]} ${versionMatch2?.[1] || ''}`.trim()
      }
    }

    // 解析 Shell
    const shellLine = lines.find(l => l.includes('/bin/') || l.includes('/usr/'))
    if (shellLine) {
      if (shellLine.includes('zsh')) result.shell = 'zsh'
      else if (shellLine.includes('bash')) result.shell = 'bash'
      else if (shellLine.includes('fish')) result.shell = 'fish'
      else if (shellLine.includes('sh')) result.shell = 'sh'
    }

    // 解析主目录
    const homeLine = lines.find(l => l.startsWith('/home/') || l.startsWith('/Users/') || l.startsWith('/root'))
    if (homeLine) {
      result.homeDir = homeLine
    }

    // 解析当前目录
    const pwdLine = lines.find(l => l.startsWith('/') && l !== result.homeDir && !l.includes('bin'))
    if (pwdLine) {
      result.currentDir = pwdLine
    }

    // 解析包管理器
    if (output.includes('[PKG_APT]')) result.packageManager = 'apt'
    else if (output.includes('[PKG_DNF]')) result.packageManager = 'dnf'
    else if (output.includes('[PKG_YUM]')) result.packageManager = 'yum'
    else if (output.includes('[PKG_BREW]')) result.packageManager = 'brew'
    else if (output.includes('[PKG_PACMAN]')) result.packageManager = 'pacman'

    // 解析已安装工具
    const tools: string[] = []
    if (output.includes('[HAS_GIT]')) tools.push('git')
    if (output.includes('[HAS_DOCKER]')) tools.push('docker')
    if (output.includes('[HAS_PYTHON3]')) tools.push('python3')
    else if (output.includes('[HAS_PYTHON]')) tools.push('python')
    if (output.includes('[HAS_NODE]')) tools.push('node')
    if (output.includes('[HAS_NGINX]')) tools.push('nginx')
    if (output.includes('[HAS_SYSTEMD]')) tools.push('systemd')
    if (output.includes('[HAS_VIM]')) tools.push('vim')
    if (output.includes('[HAS_NANO]')) tools.push('nano')
    
    if (tools.length > 0) {
      result.installedTools = tools
    }

    return result
  }

  /**
   * 生成用于 System Prompt 的主机信息
   */
  generateHostContext(hostId: string): string {
    const profile = this.profiles.get(hostId)
    if (!profile) {
      return '主机信息: 未知（首次连接，正在探测...）'
    }

    const lines: string[] = ['## 主机信息']
    
    if (profile.hostname) {
      lines.push(`- 主机名: ${profile.hostname}`)
    }
    if (profile.username) {
      lines.push(`- 用户: ${profile.username}`)
    }
    if (profile.osVersion) {
      lines.push(`- 系统: ${profile.osVersion}`)
    } else if (profile.os) {
      lines.push(`- 系统: ${profile.os}`)
    }
    if (profile.shell) {
      lines.push(`- Shell: ${profile.shell}`)
    }
    if (profile.packageManager) {
      lines.push(`- 包管理器: ${profile.packageManager}`)
    }
    if (profile.installedTools.length > 0) {
      lines.push(`- 已安装工具: ${profile.installedTools.join(', ')}`)
    }
    if (profile.currentDir) {
      lines.push(`- 当前目录: ${profile.currentDir}`)
    }

    // 添加已知信息
    if (profile.notes.length > 0) {
      lines.push('')
      lines.push('## 已知信息（来自历史交互）')
      for (const note of profile.notes.slice(-10)) {  // 只显示最近 10 条
        lines.push(`- ${note}`)
      }
    }

    return lines.join('\n')
  }

  /**
   * 检查是否需要探测
   */
  needsProbe(hostId: string): boolean {
    const profile = this.profiles.get(hostId)
    if (!profile) return true

    // 如果超过 24 小时没有探测，建议重新探测
    const hoursSinceProbe = (Date.now() - profile.lastProbed) / (1000 * 60 * 60)
    return hoursSinceProbe > 24
  }
}

