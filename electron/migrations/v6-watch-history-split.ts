/**
 * Migration v6: 把 watch（关切）的「内心独白」执行记录从主 agent 历史树拆分到独立的 watch 树。
 *
 * 背景：watch 每次心跳/触发都通过 Agent checkpoint 写一条 AgentRecord，agentKey='__watch__'。
 * 这些记录混在 history/agent/<date>/ 里、并被写进单一的 agent-index.json——高频内心独白
 * 把主索引压到 ~149MB（2.6w 条占 93%），且每次写盘都全量重写主索引（O(N)）。
 *
 * 本迁移：
 * - 把 agent 树里属于 watch 的正文文件 **rename** 到 watch 树 history/watch/<date>/——
 *   rename 只改目录、不读写内容，正文逐字节不变（审计完整），且极快。
 * - 旧记录（agentKey 字段引入前产生的）身上没有结构化标记，只能靠 userTask 心跳模板前缀识别；
 *   该启发式**仅在此一次性迁移里使用**，运行时代码一律用 agentKey 结构化判断。
 * - 索引（agent-index.json 瘦身 + 新建 watch-index.json）由 main.ts 在 startup 迁移完成后
 *   统一调 historyService.rebuildAgentIndex() 重建，本迁移不直接碰索引。
 */

import * as fs from 'fs'
import * as path from 'path'
import { createLogger } from '../utils/logger'
import {
  createMigrationProgressWindow,
  setMigrationProgress,
} from '../utils/migration-progress'
import {
  listAgentDateDirs,
  listSessionFilesInDateDir,
  readAgentRecordFile,
} from '../services/history/agent-storage'
import type { Migration } from './types'

const log = createLogger('Migration:v6')

const WATCH_AGENT_KEY = '__watch__'

/** 文件数超过此阈值才弹进度窗，轻量用户静默快速迁移 */
const PROGRESS_THRESHOLD = 300

const PROGRESS_OPTS = {
  titleZh: '正在整理关切历史…',
  titleEn: 'Reorganizing watch history…',
  subtitleZh: '请勿关闭应用',
  subtitleEn: 'Please do not close the app',
}

/**
 * 判断一条记录是否属于 watch 内心独白。
 * 新记录靠结构化 agentKey；旧记录（无 agentKey）回退到心跳模板 userTask 前缀——
 * 仅迁移期使用的一次性数据考古，不进运行时代码。
 */
function isWatchRecord(agentKey: string | undefined, userTask: string | undefined): boolean {
  if (agentKey === WATCH_AGENT_KEY) return true
  const t = userTask ?? ''
  return t.startsWith('[当前时间：') && t.includes('触发事件')
}

export async function splitWatchHistory(
  userDataPath: string,
  onProgress?: (pct: number, label: string) => Promise<void>
): Promise<{ moved: number; scanned: number; errors: string[] }> {
  const agentDir = path.join(userDataPath, 'history', 'agent')
  const watchDir = path.join(userDataPath, 'history', 'watch')
  const errors: string[] = []

  if (!fs.existsSync(agentDir)) {
    return { moved: 0, scanned: 0, errors }
  }

  // 先收集所有待扫描的 (dateStr, file)，用于进度计算
  const targets: Array<{ dateStr: string; file: string }> = []
  for (const dateStr of listAgentDateDirs(agentDir)) {
    for (const file of listSessionFilesInDateDir(agentDir, dateStr)) {
      targets.push({ dateStr, file })
    }
  }

  let moved = 0
  let scanned = 0

  for (let i = 0; i < targets.length; i++) {
    const { dateStr, file } = targets[i]
    const srcPath = path.join(agentDir, dateStr, file)
    scanned++

    try {
      const record = readAgentRecordFile(srcPath, (corruptPath, err) => {
        errors.push(`解析失败 ${dateStr}/${file}: ${err instanceof Error ? err.message : String(err)}`)
        if (corruptPath) log.warn(`损坏记录已隔离: ${corruptPath}`)
      })

      if (record && isWatchRecord(record.agentKey, record.userTask)) {
        const destDir = path.join(watchDir, dateStr)
        fs.mkdirSync(destDir, { recursive: true })
        const destPath = path.join(destDir, file)
        if (!fs.existsSync(destPath)) {
          fs.renameSync(srcPath, destPath)
          moved++
        } else {
          // 极罕见：watch 树已有同名文件（重复迁移/同 id）。保留两者、不覆盖，仅告警
          log.warn(`watch 树已存在同名记录，跳过移动: ${dateStr}/${file}`)
        }
      }
    } catch (e) {
      errors.push(`移动失败 ${dateStr}/${file}: ${e instanceof Error ? e.message : String(e)}`)
      log.error(`移动失败 ${dateStr}/${file}:`, e)
    }

    if (onProgress && (i % 200 === 0 || i === targets.length - 1)) {
      const pct = Math.min(100, Math.floor(((i + 1) / targets.length) * 100))
      await onProgress(pct, dateStr)
      await new Promise<void>(resolve => setImmediate(resolve))
    }
  }

  // 清理因迁移变空的 agent 日期目录
  for (const dateStr of listAgentDateDirs(agentDir)) {
    const dateDir = path.join(agentDir, dateStr)
    try {
      if (fs.readdirSync(dateDir).length === 0) {
        fs.rmdirSync(dateDir)
      }
    } catch { /* ignore */ }
  }

  return { moved, scanned, errors }
}

export const migrationV6: Migration = {
  version: 6,
  name: 'watch-history-split',
  phase: 'startup',

  async migrate({ userDataPath }) {
    const agentDir = path.join(userDataPath, 'history', 'agent')
    if (!fs.existsSync(agentDir)) {
      log.info('无 agent 历史目录，跳过 watch 拆分')
      return
    }

    // 预估文件量：大量时才弹进度窗
    let totalFiles = 0
    for (const dateStr of listAgentDateDirs(agentDir)) {
      totalFiles += listSessionFilesInDateDir(agentDir, dateStr).length
    }
    if (totalFiles === 0) {
      log.info('agent 历史为空，跳过 watch 拆分')
      return
    }

    log.info(`开始扫描 ${totalFiles} 条记录，拆分 watch 内心独白到独立历史树`)
    let progressWin = totalFiles >= PROGRESS_THRESHOLD
      ? await createMigrationProgressWindow(PROGRESS_OPTS)
      : null

    try {
      const result = await splitWatchHistory(userDataPath, async (pct, label) => {
        if (progressWin) await setMigrationProgress(progressWin, pct, label)
      })

      if (progressWin) await setMigrationProgress(progressWin, 100, '')
      log.info(
        `watch 历史拆分完成：扫描 ${result.scanned} 条，移动 ${result.moved} 条到 watch 树` +
        (result.errors.length ? `，${result.errors.length} 个错误` : '')
      )
      if (result.errors.length > 0) {
        log.warn('拆分部分失败:', result.errors.slice(0, 20).join('; '))
      }
    } finally {
      if (progressWin && !progressWin.isDestroyed()) {
        progressWin.destroy()
        progressWin = null
      }
    }

    // 索引重建（agent-index 瘦身 + watch-index 新建）由 main.ts 在 startup 迁移后统一执行
  },
}
