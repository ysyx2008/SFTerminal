/**
 * 跨平台工具函数
 */

/**
 * 规范化当前系统的 OS 名称
 * process.platform → 'macos' | 'windows' | 'linux' | 原始值
 */
export function getLocalOS(): string {
  switch (process.platform) {
    case 'darwin': return 'macos'
    case 'win32': return 'windows'
    default: return process.platform
  }
}

/**
 * 获取当前系统的默认 Shell
 * - Windows: COMSPEC 环境变量 → cmd.exe
 * - Unix/Linux/macOS: SHELL 环境变量 → /bin/bash
 */
export function getDefaultShell(): string {
  if (process.platform === 'win32') {
    return process.env.COMSPEC || 'powershell.exe'
  }
  return process.env.SHELL || '/bin/bash'
}
