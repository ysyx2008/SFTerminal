/**
 * TODO.md → TODO.json 迁移标记（workspace 旁路，不污染 StoreSchema）
 *
 * 路径：{userData}/agent-workspace/migrations/todo-md.json
 * （`migrations/` 为工作区免确认目录，供升级标记复用；兼容根目录旧 `TODO.migration.json`）
 */
import * as fs from 'fs'
import * as path from 'path'
import { createLogger } from '../../../../utils/logger'

const log = createLogger('TodoMigrationMarker')

export const LEGACY_TODO_MD = 'TODO.md'
export const TODO_FILENAME = 'TODO.json'

/** 工作区内升级标记目录（免确认区，见 WORKSPACE_FREE_DIRS） */
export const MIGRATIONS_DIR = 'migrations'

/** 本条迁移的标记文件名（位于 migrations/ 下） */
export const MIGRATION_MARKER_FILENAME = 'todo-md.json'

/** 历史路径：曾落在 workspace 根目录 */
export const LEGACY_ROOT_MARKER_FILENAME = 'TODO.migration.json'

/** deferred = 用户说以后再说，下次启动再征询；skipped = 明确不用迁 */
export type TodoMigrationStatus = 'pending' | 'deferred' | 'done' | 'failed' | 'skipped'

export interface TodoMigrationMarker {
  version: 1
  status: TodoMigrationStatus
  createdAt: number
  completedAt?: number
  bakPath?: string
  lastError?: string
  note?: string
}

export function getWorkspaceDir(userDataPath: string): string {
  return path.join(userDataPath, 'agent-workspace')
}

export function getMigrationsDir(userDataPath: string): string {
  return path.join(getWorkspaceDir(userDataPath), MIGRATIONS_DIR)
}

export function getTodoMigrationMarkerPath(userDataPath: string): string {
  return path.join(getMigrationsDir(userDataPath), MIGRATION_MARKER_FILENAME)
}

function getLegacyRootMarkerPath(userDataPath: string): string {
  return path.join(getWorkspaceDir(userDataPath), LEGACY_ROOT_MARKER_FILENAME)
}

/**
 * 根目录旧标记一次性挪到 migrations/todo-md.json。
 * 已有新路径时不动旧文件（避免覆盖）；仅当新路径不存在时 rename。
 */
export function relocateLegacyTodoMigrationMarker(userDataPath: string): void {
  const next = getTodoMigrationMarkerPath(userDataPath)
  const legacy = getLegacyRootMarkerPath(userDataPath)
  if (fs.existsSync(next) || !fs.existsSync(legacy)) return
  try {
    fs.mkdirSync(path.dirname(next), { recursive: true })
    fs.renameSync(legacy, next)
    log.info('Relocated TODO.migration.json → migrations/todo-md.json')
  } catch (e) {
    log.warn('Failed to relocate legacy TODO.migration.json:', e)
  }
}

export function readTodoMigrationMarker(markerPath: string): TodoMigrationMarker | null {
  try {
    if (!fs.existsSync(markerPath)) return null
    const raw = JSON.parse(fs.readFileSync(markerPath, 'utf-8'))
    if (!raw || typeof raw !== 'object') return null
    const status = raw.status as TodoMigrationStatus
    if (!['pending', 'deferred', 'done', 'failed', 'skipped'].includes(status)) return null
    return {
      version: 1,
      status,
      createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : Date.now(),
      completedAt: typeof raw.completedAt === 'number' ? raw.completedAt : undefined,
      bakPath: typeof raw.bakPath === 'string' ? raw.bakPath : undefined,
      lastError: typeof raw.lastError === 'string' ? raw.lastError : undefined,
      note: typeof raw.note === 'string' ? raw.note : undefined,
    }
  } catch (e) {
    log.warn('Failed to read migration marker:', e)
    return null
  }
}

export function writeTodoMigrationMarker(markerPath: string, marker: TodoMigrationMarker): void {
  fs.mkdirSync(path.dirname(markerPath), { recursive: true })
  const tmp = `${markerPath}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(marker, null, 2), 'utf-8')
  fs.renameSync(tmp, markerPath)
}

/** 确保 migrations/ 存在；并把根目录旧标记迁过来（若有） */
export function ensureTodoMigrationMarker(userDataPath: string): void {
  fs.mkdirSync(getMigrationsDir(userDataPath), { recursive: true })
  relocateLegacyTodoMigrationMarker(userDataPath)
}

export function hasValidTodoJson(jsonPath: string): boolean {
  try {
    if (!fs.existsSync(jsonPath)) return false
    const raw = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'))
    return Array.isArray(raw?.todos) && raw.todos.length > 0
  } catch {
    return false
  }
}

export function isTodoMdMigrationPending(userDataPath: string): boolean {
  relocateLegacyTodoMigrationMarker(userDataPath)
  const marker = readTodoMigrationMarker(getTodoMigrationMarkerPath(userDataPath))
  return marker?.status === 'pending' || marker?.status === 'failed' || marker?.status === 'deferred'
}
