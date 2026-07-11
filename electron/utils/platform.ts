/**
 * 跨平台工具函数
 */

// getDefaultShell 仅做 re-export，让旧调用点保持不变；
// 真正的实现统一收敛到 utils/shell.ts（Windows 默认 PowerShell 而非 COMSPEC，
// 避免 cmd.exe / PowerShell 语法不匹配导致的命令执行失败）。
export { getDefaultShell } from './shell'

/**
 * 规范化当前系统的 OS 名称
 * process.platform -> 'macos' | 'windows' | 'linux' | 原始值
 */
export function getLocalOS(): string {
  switch (process.platform) {
    case 'darwin': return 'macos'
    case 'win32': return 'windows'
    default: return process.platform
  }
}
