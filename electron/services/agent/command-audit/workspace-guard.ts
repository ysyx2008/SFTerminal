/**
 * 工作区路径分区与系统路径守卫
 *
 * C 方案分区：
 * - free       scratch/、charts/ — 读写删免确认
 * - protected  templates/、根目录人格配置 md — 写删需确认
 * - workspace  工作区内其他 — 写删需确认
 * - outside    工作区外 — 写删 dangerous；系统路径 blocked
 */
import * as fs from 'fs'
import * as path from 'path'
import type { RiskLevel } from '@shared/types/agent'
import {
  getWorkspacePath,
  isInWorkspace,
  isScratchPath,
} from '../tools/file'
import {
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
export function getWorkspaceZone(targetPath: string, cwd?: string): WorkspaceZone {
  const resolved = resolveRealPath(resolveCommandPath(targetPath, cwd))
  if (!isInWorkspace(resolved)) return 'outside'
  if (isScratchPath(resolved) || isChartsPath(resolved)) return 'free'

  const rel = getRelativeWorkspacePath(resolved)
  if (!rel) return 'outside'

  const first = rel.split('/')[0]
  if (PROTECTED_WORKSPACE_DIRS.has(first)) return 'protected'
  if (PROTECTED_WORKSPACE_FILES.has(rel)) return 'protected'

  return 'workspace'
}

/** 系统关键路径（写操作 hard block） */
export function isSystemPath(targetPath: string, cwd?: string): boolean {
  const abs = resolveCommandPath(targetPath, cwd)
  const resolved = normalizePathForCompare(resolveRealPath(abs))
  const unresolved = normalizePathForCompare(abs)
  if (SYSTEM_PATH_PATTERNS.some(p => p.pattern.test(resolved) || p.pattern.test(unresolved))) {
    return true
  }
  return isUserDataForbidden(targetPath, cwd)
}

/**
 * 写/删类命令：根据路径分区调整风险
 *
 * 只读命令（writesTo=false）不受路径分区影响，保持 commandLevel。
 */
export function adjustRiskByPathZones(
  commandLevel: RiskLevel,
  paths: string[],
  writesTo: boolean,
  cwd?: string,
): { level: RiskLevel; zones: WorkspaceZone[]; reasons: string[] } {
  const reasons: string[] = []
  if (paths.length === 0) {
    return { level: commandLevel, zones: [], reasons }
  }

  if (paths.some(p => isUserDataForbidden(p, cwd))) {
    return {
      level: 'blocked',
      zones: paths.map(p => getWorkspaceZone(p, cwd)),
      reasons: ['目标位于受保护的 userData 路径，禁止访问'],
    }
  }

  if (!writesTo) {
    return { level: commandLevel, zones: [], reasons }
  }

  const zones = paths.map(p => getWorkspaceZone(p, cwd))

  if (paths.some(p => isSystemPath(p, cwd))) {
    return {
      level: 'blocked',
      zones,
      reasons: ['目标路径位于系统关键目录，禁止写入或删除'],
    }
  }

  if (zones.every(z => z === 'free')) {
    reasons.push('目标位于工作区自由区（scratch/charts），允许自动执行')
    return { level: 'safe', zones, reasons }
  }
  // outside 优先于 protected/workspace（复合路径取最严）
  if (zones.some(z => z === 'outside')) {
    reasons.push('目标位于工作区外，需确认')
    return { level: 'dangerous', zones, reasons }
  }
  if (zones.some(z => z === 'protected')) {
    reasons.push('目标位于工作区保护区（templates/ 或人格配置文件），需确认')
    return { level: 'moderate', zones, reasons }
  }
  if (zones.some(z => z === 'workspace')) {
    reasons.push('目标位于工作区内，需确认')
    return { level: 'moderate', zones, reasons }
  }

  return { level: commandLevel, zones, reasons }
}
