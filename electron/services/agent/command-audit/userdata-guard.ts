/**
 * userData 目录访问守卫（白名单式）
 *
 * userData 下默认禁止 Agent 访问；仅显式 allow 的条目可读写。
 * 用于保护 credentials.json、agent-allowlist.json 等安全机制文件。
 */
import { app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { resolveCommandPath } from './workspace-guard'

/** userData 下显式允许 Agent 访问的条目（未列出的一律 block） */
export const ALLOWED_USERDATA_ENTRIES = [
  'agent-workspace',
  'skills',
  'excel-styles.json',
  'word-styles.json',
] as const

let userDataPath: string | null = null
let allowedAbsPaths: Set<string> = new Set()

function normalizePathForCompare(p: string): string {
  let n = p.replace(/\\/g, '/')
  if (n.length > 1 && n.endsWith('/')) n = n.slice(0, -1)
  return n
}

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

function isUnderDirectory(filePath: string, directory: string): boolean {
  const resolved = resolveRealPath(filePath)
  let normDir: string
  try {
    normDir = fs.realpathSync(directory).replace(/\\/g, '/')
  } catch {
    normDir = directory.replace(/\\/g, '/')
  }
  const normResolved = resolved.replace(/\\/g, '/')
  return normResolved.startsWith(normDir + '/') || normResolved === normDir
}

/** 启动时调用（app.whenReady 后、bootstrap 重定向完成后） */
export function initUserDataGuard(): void {
  const raw = app.getPath('userData')
  userDataPath = resolveRealPath(raw)
  allowedAbsPaths = new Set(
    ALLOWED_USERDATA_ENTRIES.map(e => path.join(userDataPath!, e)),
  )
}

/** 测试用：注入 userData 根路径 */
export function setUserDataGuardForTest(root: string): void {
  userDataPath = resolveRealPath(root)
  allowedAbsPaths = new Set(
    ALLOWED_USERDATA_ENTRIES.map(e => path.join(userDataPath!, e)),
  )
}

export function resetUserDataGuardForTest(): void {
  userDataPath = null
  allowedAbsPaths = new Set()
}

/** 路径是否落在 userData 下且不在 allow 列表（= 禁止访问） */
export function isUserDataForbidden(targetPath: string, cwd?: string): boolean {
  if (!userDataPath) return false

  const abs = resolveCommandPath(targetPath, cwd)
  const resolved = resolveRealPath(abs)
  const normUserData = normalizePathForCompare(userDataPath)
  const normResolved = normalizePathForCompare(resolved)

  if (normResolved !== normUserData && !normResolved.startsWith(normUserData + '/')) {
    return false
  }

  for (const allowed of allowedAbsPaths) {
    if (isUnderDirectory(resolved, allowed)) return false
  }

  return true
}
