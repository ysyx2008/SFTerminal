/**
 * Migration v9: 旧版 TODO.md → 结构化待办迁移的确定性半程。
 *
 * - 若存在 agent-workspace/TODO.md 且 TODO.json 尚无有效条目：备份为 TODO.md.bak，并写入 pending 标记
 * - 真正读懂 md、调用 todo_create 由启动后的 deferred Agent 任务完成（不阻塞本 migration / 不绑 schemaVersion）
 *
 * 幂等：已有有效 TODO.json、或 migration 标记已是 done/pending 且 bak 已存在时安全重入
 */

import * as fs from 'fs'
import * as path from 'path'
import { createLogger } from '../utils/logger'
import type { Migration } from './types'
import {
  LEGACY_TODO_MD,
  TODO_FILENAME,
  ensureTodoMigrationMarker,
  getTodoMigrationMarkerPath,
  hasValidTodoJson,
  readTodoMigrationMarker,
  writeTodoMigrationMarker,
} from '../services/agent/skills/todo/migration-marker'

const log = createLogger('Migration:v9')

export function prepareTodoMdMigration(userDataPath: string): {
  status: 'skipped' | 'pending' | 'already_pending' | 'already_done'
  reason?: string
} {
  ensureTodoMigrationMarker(userDataPath)
  const workspace = path.join(userDataPath, 'agent-workspace')
  const mdPath = path.join(workspace, LEGACY_TODO_MD)
  const jsonPath = path.join(workspace, TODO_FILENAME)
  const bakPath = path.join(workspace, `${LEGACY_TODO_MD}.bak`)
  const markerPath = getTodoMigrationMarkerPath(userDataPath)

  if (!fs.existsSync(mdPath)) {
    return { status: 'skipped', reason: 'no TODO.md' }
  }

  let mdContent = ''
  try {
    mdContent = fs.readFileSync(mdPath, 'utf-8').trim()
  } catch (e) {
    log.warn('Failed to read TODO.md:', e)
    return { status: 'skipped', reason: 'unreadable TODO.md' }
  }
  if (!mdContent) {
    return { status: 'skipped', reason: 'empty TODO.md' }
  }

  if (hasValidTodoJson(jsonPath)) {
    const marker = readTodoMigrationMarker(markerPath)
    if (marker?.status !== 'done') {
      writeTodoMigrationMarker(markerPath, {
        version: 1,
        status: 'done',
        createdAt: marker?.createdAt ?? Date.now(),
        completedAt: Date.now(),
        note: 'TODO.json already has items; marked done without Agent rewrite',
      })
    }
    return { status: 'already_done', reason: 'TODO.json already populated' }
  }

  const existing = readTodoMigrationMarker(markerPath)
  if (existing?.status === 'done') {
    return { status: 'already_done' }
  }
  if (existing?.status === 'pending') {
    // 确保 bak 存在
    ensureBackup(mdPath, bakPath)
    return { status: 'already_pending' }
  }

  fs.mkdirSync(workspace, { recursive: true })
  ensureBackup(mdPath, bakPath)

  writeTodoMigrationMarker(markerPath, {
    version: 1,
    status: 'pending',
    createdAt: Date.now(),
    bakPath: path.basename(bakPath),
  })

  log.info('TODO.md migration prepared (pending Agent migrate); bak=%s', bakPath)
  return { status: 'pending' }
}

function ensureBackup(mdPath: string, bakPath: string): void {
  if (fs.existsSync(bakPath)) return
  fs.copyFileSync(mdPath, bakPath)
}

export const migrationV9: Migration = {
  version: 9,
  name: 'todo-md-to-json-prepare',
  phase: 'startup',
  migrate: async (context) => {
    const result = prepareTodoMdMigration(context.userDataPath)
    log.info('v9 todo-md prepare: %s%s', result.status, result.reason ? ` (${result.reason})` : '')
    // 无操作也算成功：保证 schemaVersion 前进；deferred 阶段再处理 pending
    ensureTodoMigrationMarker(context.userDataPath)
  },
}
