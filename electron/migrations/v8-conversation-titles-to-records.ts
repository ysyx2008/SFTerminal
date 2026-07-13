/**
 * Migration v8: 把 config.conversationDisplayTitles 旁路标题迁入会话 AgentRecord.title。
 *
 * 背景：侧栏标题曾存在 config 字典里，与会话生命周期脱节（删另一条会误 prune）。
 * 标题应归属会话本身。本迁移把存量 overlay 写入对应 record + 索引，然后清空 config 项。
 *
 * 幂等：conversationDisplayTitles 已空则直接返回。
 */

import * as path from 'path'
import { app } from 'electron'
import { createLogger } from '../utils/logger'
import { AgentRecordStore } from '../services/history/agent-record-store'
import type { Migration } from './types'

const log = createLogger('Migration:v8')

export const migrationV8: Migration = {
  version: 8,
  name: 'conversation-titles-to-records',
  phase: 'startup',
  migrate: async (context) => {
    const raw = context.configService.get('conversationDisplayTitles')
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      log.info('No conversationDisplayTitles to migrate')
      return
    }
    const titles = raw as Record<string, string>
    const entries = Object.entries(titles).filter(([, t]) => typeof t === 'string' && t.trim())
    if (entries.length === 0) {
      context.configService.set('conversationDisplayTitles', {})
      return
    }

    const historyDir = path.join(context.userDataPath || app.getPath('userData'), 'history')
    const store = new AgentRecordStore(historyDir)
    let migrated = 0
    let missing = 0
    for (const [id, title] of entries) {
      const trimmed = title.trim()
      if (!trimmed) continue
      const record = store.getAgentRecordById(id)
      if (!record) {
        // 无正文：写入 pending，等该 session 首次 save 时并入
        store.updateTitle(id, trimmed)
        missing++
        continue
      }
      if (record.title?.trim()) {
        // 已有会话标题，不覆盖
        continue
      }
      store.updateTitle(id, trimmed)
      migrated++
    }

    context.configService.set('conversationDisplayTitles', {})
    log.info(
      `Migrated conversation titles: ${migrated} records updated, ${missing} pending (no body yet), cleared config overlay`
    )
  },
}
