/**
 * 工作区路径分区与系统路径守卫
 *
 * C 方案分区：
 * - free       scratch/、charts/ — 读写删免确认
 * - protected  templates/、根目录人格配置 md — 写删需确认
 * - workspace  工作区内其他 — 写删需确认
 * - outside    工作区外 - safe 命令（如 cp）不升级；moderate/dangerous 保持原等级
 *
 * 系统路径分级（仅对写操作生效）：
 * - critical  /、/boot - 写 -> blocked（硬墙，不可逆系统灾难）
 * - hardened  /etc、/dev、/sys、/proc、/System 等 - 写 -> dangerous（弹确认放行）
 * - /dev/null、/dev/stdout、/dev/stderr 黑洞设备 -> 豁免，写它们等于丢弃输出
 */
import * as fs from 'fs'
import * as path from 'path'
import type { RiskLevel } from '@shared/types/agent'
import { t } from '../i18n'
import {
  getWorkspacePath,
  isInWorkspace,
  isScratchPath,
} from '../tools/file'
import {
  DEV_NULL_EXEMPTIONS,
  PROTECTED_WORKSPACE_DIRS,
  PROTECTED_WORKSPACE_FILES,
  SYSTEM_PATH_PATTERNS,
  type WorkspaceZone,
} from './types'
import { isUserDataForbidden } from './userdata-guard'

/** 解析相对路径（cwd 缺省时用 process.cwd()） */
export function resolveCommandPath(rawPath: string, cwd?: string): string {
  const base = cwd ? path.resolve(cwd) : process.cwd()
  return path.resolve(base, rawPath)
}

/** 规范化路径用于比较（统一斜杠、去掉尾部 /） */
function normalizePathForCompare(p: string): string {
  let n = p.replace(/\\/g, '/')
  if (n.length > 1 && n.endsWith('/')) n = n.slice(0, -1)
  return n
}

/** 尝试 realpath；文件不存在时沿父目录回退（与 file.ts 一致） */
function resolveRealPath(filePath: string): string {
  let resolved = path.resolve(filePath)
  try {
    return fs.realpathSync(resolved)
  } catch {
    let dir = path.dirname(resolved)
    while (dir !== path.dirname(dir)) {
      try {
        const realDir = fs.realpathSync(dir)
        resolved = path.join(realDir, path.relative(dir, resolved))
        break
      } catch {
        dir = path.dirname(dir)
      }
    }
    return resolved
  }
}

function getRelativeWorkspacePath(filePath: string): string | null {
  if (!isInWorkspace(filePath)) return null
  let workspace: string
  try {
    workspace = fs.realpathSync(getWorkspacePath())
  } catch {
    workspace = getWorkspacePath()
  }
  const rel = path.relative(workspace, resolveRealPath(filePath))
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null
  return rel.replace(/\\/g, '/')
}

/** 判断路径是否落在 charts/ 子目录 */
function isChartsPath(filePath: string): boolean {
  const rel = getRelativeWorkspacePath(filePath)
  if (!rel) return false
  return rel === 'charts' || rel.startsWith('charts/')
}

/**
 * 工作区路径分区（优先于命令白名单）
 */
export function getWorkspaceZone(
  targetPath: string,
  cwd?: string,
  extraFreeDirs: string[] = [],
): WorkspaceZone {
  const resolved = resolveRealPath(resolveCommandPath(targetPath, cwd))
  if (isExtraFreeDir(resolved, extraFreeDirs)) return 'free'
  if (!isInWorkspace(resolved)) return 'outside'
  if (isScratchPath(resolved) || isChartsPath(resolved)) return 'free'

  const rel = getRelativeWorkspacePath(resolved)
  if (!rel) return 'outside'

  const first = rel.split('/')[0]
  if (PROTECTED_WORKSPACE_DIRS.has(first)) return 'protected'
  if (PROTECTED_WORKSPACE_FILES.has(rel)) return 'protected'

  return 'workspace'
}

/** 用户配置的额外自由区（绝对路径前缀匹配） */
function isExtraFreeDir(resolvedPath: string, extraFreeDirs: string[]): boolean {
  if (!extraFreeDirs.length) return false
  const normalized = normalizePathForCompare(resolvedPath)
  for (const dir of extraFreeDirs) {
    let freeRoot: string
    try {
      freeRoot = normalizePathForCompare(resolveRealPath(dir))
    } catch {
      freeRoot = normalizePathForCompare(dir)
    }
    if (!freeRoot) continue
    if (normalized === freeRoot || normalized.startsWith(freeRoot.endsWith('/') ? freeRoot : freeRoot + '/')) {
      return true
    }
    // Windows 路径分隔
    if (normalized === freeRoot || normalized.startsWith(freeRoot + '\\')) {
      return true
    }
  }
  return false
}

/**
 * 系统路径严重程度（写操作判定用）。
 * - critical：写 -> blocked（硬墙）
 * - hardened：写 -> dangerous（弹确认放行）
 * - null：非系统路径
 */
export function getSystemPathSeverity(targetPath: string, cwd?: string): 'critical' | 'hardened' | null {
  const abs = resolveCommandPath(targetPath, cwd)
  const resolved = normalizePathForCompare(resolveRealPath(abs))
  const unresolved = normalizePathForCompare(abs)
  for (const p of SYSTEM_PATH_PATTERNS) {
    if (p.pattern.test(resolved) || p.pattern.test(unresolved)) {
      return p.severity
    }
  }
  return null
}

/**
 * 系统关键路径（写操作 hard block）
 *
 * @deprecated 语义混淆：把「系统路径」和「userData 禁区」两件事揉在一起。
 * 调用方需要 severity 时应直接用 getSystemPathSeverity；需要 userData 检查时用 isUserDataForbidden。
 * 保留仅为向后兼容（测试用）。
 */
export function isSystemPath(targetPath: string, cwd?: string): boolean {
  if (getSystemPathSeverity(targetPath, cwd) !== null) return true
  return isUserDataForbidden(targetPath, cwd)
}

/**
 * 是否为黑洞/标准流设备（写它等于丢弃或重定向输出，完全无害）。
 * 仅对写重定向目标有意义，不判定命令参数。
 */
function isDevNullPath(targetPath: string, cwd?: string): boolean {
  const abs = resolveCommandPath(targetPath, cwd)
  const resolved = normalizePathForCompare(resolveRealPath(abs))
  const unresolved = normalizePathForCompare(abs)
  return DEV_NULL_EXEMPTIONS.some(p => p === resolved || p === unresolved)
}

/**
 * 写/删类命令：根据路径分区调整风险
 *
 * userData 禁区检查对读和写都生效（读 credentials.json 也 blocked）。
 * 但只读命令（writesTo=false）不走系统路径/工作区分区判定，保持 commandLevel。
 *
 * 写路径分级（取最严）：
 * 1. userData 禁区 -> blocked（不可恢复的应用数据，读+写都拦）
 * 2. 黑洞设备（/dev/null 等）-> 从写路径判定中豁免（写它们无害）
 * 3. critical 系统路径（/、/boot）-> blocked（不可逆系统灾难）
 * 4. hardened 系统路径（/etc、/dev、/sys 等）-> dangerous（弹确认放行）
 * 5. 工作区 free -> safe；protected/workspace -> moderate；outside 不升级 safe 命令
 *
 * @param commandLevel 命令本身的风险等级（白名单 + flag 判定后）
 * @param allPaths 命令参数路径 + 写重定向路径（用于 userData 检查）
 * @param writePaths 真正的写路径（命令写时含参数路径 + 写重定向；只读时仅写重定向）
 * @param writesTo 是否涉及写操作（命令写 或 有写重定向）
 * @param cwd 工作目录
 * @param opts 用户策略：outside 升级、额外自由区
 */
export function adjustRiskByPathZones(
  commandLevel: RiskLevel,
  allPaths: string[],
  writePaths: string[],
  writesTo: boolean,
  cwd?: string,
  opts?: { outsideWritesUpgrade?: boolean; extraFreeDirs?: string[] },
): { level: RiskLevel; zones: WorkspaceZone[]; reasons: string[] } {
  const reasons: string[] = []
  const extraFreeDirs = opts?.extraFreeDirs ?? []

  // userData 禁区检查：对读和写都生效（读 credentials.json 也 blocked）
  if (allPaths.some(p => isUserDataForbidden(p, cwd))) {
    return {
      level: 'blocked',
      zones: allPaths.map(p => getWorkspaceZone(p, cwd, extraFreeDirs)),
      reasons: [t('risk.reason.userdata_protected')],
    }
  }

  if (!writesTo || writePaths.length === 0) {
    return { level: commandLevel, zones: [], reasons }
  }

  // 黑洞设备豁免：写 /dev/null 等无害，单独剔除不参与系统路径判定
  const nonDevNullPaths = writePaths.filter(p => !isDevNullPath(p, cwd))
  const zones = writePaths.map(p => getWorkspaceZone(p, cwd, extraFreeDirs))

  // 所有写路径都是黑洞设备 -> 直接 safe（写 /dev/null 等于丢弃输出）
  if (nonDevNullPaths.length === 0) {
    return { level: 'safe', zones, reasons: [t('risk.reason.devnull_safe')] }
  }

  // critical 系统路径 -> blocked（/、/boot 等不可逆灾难）
  const criticalHit = nonDevNullPaths.find(p => getSystemPathSeverity(p, cwd) === 'critical')
  if (criticalHit) {
    return {
      level: 'blocked',
      zones,
      reasons: [t('risk.reason.system_critical_blocked')],
    }
  }

  // hardened 系统路径 -> dangerous（弹确认放行）
  const hardenedHit = nonDevNullPaths.find(p => getSystemPathSeverity(p, cwd) === 'hardened')
  if (hardenedHit) {
    return {
      level: 'dangerous',
      zones,
      reasons: [t('risk.reason.system_hardened')],
    }
  }

  const effectiveZones = nonDevNullPaths.map(p => getWorkspaceZone(p, cwd, extraFreeDirs))
  if (effectiveZones.every(z => z === 'free')) {
    reasons.push(t('risk.reason.workspace_free'))
    return { level: 'safe', zones, reasons }
  }
  // outside：默认不升级 safe 命令（如 cp）；开启 outsideWritesUpgrade 时升为 moderate
  if (effectiveZones.some(z => z === 'outside')) {
    if (commandLevel === 'safe' && opts?.outsideWritesUpgrade) {
      reasons.push(t('risk.reason.workspace_outside'))
      return { level: 'moderate', zones, reasons }
    }
    if (commandLevel !== 'safe') {
      reasons.push(t('risk.reason.workspace_outside'))
    }
    return { level: commandLevel, zones, reasons }
  }
  if (effectiveZones.some(z => z === 'protected')) {
    reasons.push(t('risk.reason.workspace_protected'))
    return { level: 'moderate', zones, reasons }
  }
  if (effectiveZones.some(z => z === 'workspace')) {
    reasons.push(t('risk.reason.workspace_inside'))
    return { level: 'moderate', zones, reasons }
  }

  return { level: commandLevel, zones, reasons }
}
