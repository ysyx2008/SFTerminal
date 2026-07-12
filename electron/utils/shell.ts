/**
 * 跨平台 Shell 抽象层
 *
 * 唯一真相源：所有需要 spawn shell 执行命令的地方（pty.service、
 * command-executor、exec-manager、command-probe-sensor 等）都应通过
 * 本模块获取 shell 路径和参数，避免重复实现导致行为不一致。
 *
 * Windows 策略（关键）：
 * - 默认使用 PowerShell（PS 5.1+ 所有 Windows 自带，PS7+ 名为 pwsh.exe）
 * - 不再依赖 COMSPEC：COMSPEC 在 Windows 上系统约定永远指向 cmd.exe，
 *   但本项目的命令包裹语法（$LASTEXITCODE、Write-Host 等）都是 PowerShell 语义，
 *   cmd.exe 不兼容。历史上 COMSPEC fallback 导致"有的电脑时好时坏"。
 * - 探测顺序：pwsh.exe（PS7+）> powershell.exe（PS5.1）> cmd.exe（兜底）
 * - PowerShell 一律带 -NoProfile，避免用户 profile 拖慢启动和改变行为
 */
import { execSync } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'

/** Shell 类型分类，供调用方按语义构建命令 */
export type ShellKind = 'powershell' | 'cmd' | 'bash'

export interface ResolvedShell {
  /** 可执行文件路径，可直接用于 spawn / pty.spawn 的 command 参数 */
  path: string
  /** Shell 类型，用于决定命令包裹语法 */
  kind: ShellKind
}

let cachedShell: ResolvedShell | null = null

/**
 * 在 Windows 上定位可用的 PowerShell。
 * 返回 null 表示未找到，调用方应回退到 cmd.exe。
 */
function findPowerShellOnWindows(): string | null {
  // 1. 优先 PS7+ (pwsh.exe) - 跨平台版本，行为更现代
  const pwshPaths = [
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'PowerShell', '7', 'pwsh.exe'),
    process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'PowerShell', '7', 'pwsh.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'PowerShell', '7', 'pwsh.exe'),
  ].filter(Boolean) as string[]

  for (const p of pwshPaths) {
    try {
      if (fs.existsSync(p)) return p
    } catch {
      // 忽略访问错误，继续尝试下一个
    }
  }

  // 2. PS 5.1 (powershell.exe) - 所有 Windows 自带
  const ps51Paths = [
    process.env.SystemRoot && path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    process.env.WINDIR && path.join(process.env.WINDIR, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  ].filter(Boolean) as string[]

  for (const p of ps51Paths) {
    try {
      if (fs.existsSync(p)) return p
    } catch {
      // 忽略
    }
  }

  // 3. PATH 里找 powershell.exe / pwsh.exe
  try {
    const where = execSync('where powershell.exe 2>nul', { encoding: 'utf-8', timeout: 1500 }).trim()
    if (where) return where.split(/\r?\n/)[0]
  } catch {
    // where 命令失败，忽略
  }
  try {
    const where = execSync('where pwsh.exe 2>nul', { encoding: 'utf-8', timeout: 1500 }).trim()
    if (where) return where.split(/\r?\n/)[0]
  } catch {
    // 忽略
  }

  return null
}

/**
 * 解析当前平台默认 Shell（带类型信息）
 *
 * - Windows：PowerShell 优先，cmd.exe 兜底
 * - Unix：跟随 $SHELL，回退 /bin/bash
 */
export function resolveDefaultShell(): ResolvedShell {
  if (cachedShell) return cachedShell

  let result: ResolvedShell

  if (process.platform === 'win32') {
    const psPath = findPowerShellOnWindows()
    if (psPath) {
      result = { path: psPath, kind: 'powershell' }
    } else {
      // 兜底：cmd.exe（SystemRoot 兜底防止环境变量缺失）
      const cmdPath = process.env.COMSPEC
        || (process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32', 'cmd.exe') : 'cmd.exe')
      result = { path: cmdPath, kind: 'cmd' }
    }
  } else {
    result = { path: process.env.SHELL || '/bin/bash', kind: 'bash' }
  }

  cachedShell = result
  return result
}

/**
 * 获取默认 Shell 路径（向后兼容旧调用点）
 */
export function getDefaultShell(): string {
  return resolveDefaultShell().path
}

/**
 * 获取默认 Shell 的类型
 */
export function getDefaultShellKind(): ShellKind {
  return resolveDefaultShell().kind
}

/**
 * 从可执行文件路径推断 ShellKind（用户显式传入 shell 时用）。
 * 路径本身即真相；无法识别时按 POSIX 系归为 bash。
 */
export function inferShellKind(shellPath: string): ShellKind {
  const base = path.basename(shellPath).toLowerCase()
  if (base === 'pwsh.exe' || base === 'pwsh' || base === 'powershell.exe' || base === 'powershell') {
    return 'powershell'
  }
  if (base === 'cmd.exe' || base === 'cmd') {
    return 'cmd'
  }
  return 'bash'
}

/**
 * 判断当前平台是否为 Windows
 */
export function isWindows(): boolean {
  return process.platform === 'win32'
}

/**
 * 为给定命令构建 spawn 参数数组。
 *
 * 调用方典型用法：
 * ```ts
 * const shell = resolveDefaultShell()
 * const args = getShellSpawnArgs(shell.kind, command)
 * spawn(shell.path, args, { cwd, env })
 * ```
 *
 * @param kind Shell 类型
 * @param command 要执行的命令字符串
 * @param opts.noProfile 是否跳过加载用户 profile（PowerShell 推荐 true，避免慢启动和被用户自定义影响）
 * @param opts.login 是否作为 login shell 启动（仅 bash/zsh 有效：加 `-l` 标志，会 source
 *                   `.bash_profile`/`.profile`，让 nvm/rbenv/Homebrew PATH 等环境就绪。
 *                   PowerShell/cmd 忽略此选项）
 */
export function getShellSpawnArgs(
  kind: ShellKind,
  command: string,
  opts: { noProfile?: boolean; login?: boolean } = {}
): string[] {
  switch (kind) {
    case 'powershell': {
      const args: string[] = []
      if (opts.noProfile !== false) args.push('-NoProfile')
      args.push('-NoLogo', '-Command', command)
      return args
    }
    case 'cmd':
      return ['/c', command]
    case 'bash': {
      // login shell 会 source .bash_profile/.profile，让 nvm/rbenv/Homebrew PATH 等就绪。
      // 旧 exec-manager 实现 spawn(shell, ['-l', '-c', cmd]) 依赖 login 环境，
      // 这里通过 opts.login 保留该行为，默认开启以保持向后兼容。
      const args: string[] = []
      if (opts.login !== false) args.push('-l')
      args.push('-c', command)
      return args
    }
  }
}

/**
 * 为给定 shell 转义字符串，使其可作为单个字面量参数传入。
 *
 * 用途：构建 PowerShell / cmd / bash 的字符串字面量时（如 marker echo）。
 *
 * @param kind Shell 类型
 * @param str 要转义的字符串
 */
export function quoteForShell(kind: ShellKind, str: string): string {
  switch (kind) {
    case 'powershell':
      // PowerShell 单引号字符串：内部单引号用 '' 转义，其他字符原样
      return `'${str.replace(/'/g, "''")}'`
    case 'cmd':
      // cmd.exe 双引号字符串：内部双引号用 "" 转义（cmd 不认 \"）
      // 注意：cmd 字符串处理较弱，复杂场景应尽量走 PowerShell
      return `"${str.replace(/"/g, '""')}"`
    case 'bash':
      // POSIX shell 单引号字符串：内部单引号用 '\'' 序列转义
      return `'${str.replace(/'/g, "'\\''")}'`
  }
}

/**
 * 清除缓存（主要供测试使用）
 */
export function clearShellCache(): void {
  cachedShell = null
}
