import * as fs from 'fs'
import * as path from 'path'
import type { AgentRecord } from '@shared/types'
import { writeFileAtomic } from '../../utils/atomic-write'
import { normalizeAgentRecord } from '../../utils/normalize'

/** 旧格式日文件迁移后备份后缀 */
export const LEGACY_AGENT_DAY_SUFFIX = '.json'
export const AGENT_MIGRATED_SUFFIX = '.json.migrated'
export const MIGRATED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

const DATE_DIR_RE = /^\d{4}-\d{2}-\d{2}$/
const LEGACY_DAY_FILE_RE = /^\d{4}-\d{2}-\d{2}\.json$/

export function sanitizeAgentFilename(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, '_')
}

export function getAgentDateDir(agentDir: string, dateStr: string): string {
  return path.join(agentDir, dateStr)
}

export function getAgentRecordPath(agentDir: string, dateStr: string, recordId: string): string {
  return path.join(getAgentDateDir(agentDir, dateStr), `${sanitizeAgentFilename(recordId)}.json`)
}

export function getLegacyAgentDayFilePath(agentDir: string, dateStr: string): string {
  return path.join(agentDir, `${dateStr}${LEGACY_AGENT_DAY_SUFFIX}`)
}

export function isLegacyAgentDayFileName(name: string): boolean {
  return LEGACY_DAY_FILE_RE.test(name)
}

export function isAgentDateDirName(name: string): boolean {
  return DATE_DIR_RE.test(name)
}

export function listLegacyAgentDayFiles(agentDir: string): string[] {
  if (!fs.existsSync(agentDir)) return []
  return fs.readdirSync(agentDir)
    .filter(isLegacyAgentDayFileName)
    .sort()
}

export function listAgentDateDirs(agentDir: string): string[] {
  if (!fs.existsSync(agentDir)) return []
  return fs.readdirSync(agentDir, { withFileTypes: true })
    .filter(e => e.isDirectory() && isAgentDateDirName(e.name))
    .map(e => e.name)
    .sort()
}

export function listSessionFilesInDateDir(agentDir: string, dateStr: string): string[] {
  const dateDir = getAgentDateDir(agentDir, dateStr)
  if (!fs.existsSync(dateDir)) return []
  return fs.readdirSync(dateDir).filter(f => f.endsWith('.json')).sort()
}

export function isolateCorruptFile(filePath: string): string | null {
  try {
    const corrupt = `${filePath}.corrupt.${Date.now()}`
    fs.renameSync(filePath, corrupt)
    return corrupt
  } catch {
    return null
  }
}

export function readAgentRecordFile(
  filePath: string,
  onCorrupt?: (corruptPath: string | null, error: unknown) => void
): AgentRecord | null {
  try {
    if (!fs.existsSync(filePath)) return null
    const content = fs.readFileSync(filePath, 'utf-8')
    const parsed = JSON.parse(content) as AgentRecord
    return normalizeAgentRecord(parsed)
  } catch (e) {
    const corruptPath = isolateCorruptFile(filePath)
    onCorrupt?.(corruptPath, e)
    return null
  }
}

export async function readAgentRecordFileAsync(
  filePath: string,
  onCorrupt?: (corruptPath: string | null, error: unknown) => void
): Promise<AgentRecord | null> {
  try {
    const content = await fs.promises.readFile(filePath, 'utf-8')
    const parsed = JSON.parse(content) as AgentRecord
    return normalizeAgentRecord(parsed)
  } catch (e) {
    if (fs.existsSync(filePath)) {
      const corruptPath = isolateCorruptFile(filePath)
      onCorrupt?.(corruptPath, e)
    }
    return null
  }
}

export function writeAgentRecordFile(agentDir: string, record: AgentRecord): void {
  const dateStr = new Date(record.timestamp).toISOString().split('T')[0]
  const filePath = getAgentRecordPath(agentDir, dateStr, record.id)
  writeFileAtomic(filePath, JSON.stringify(record, null, 2))
}

export function readLegacyAgentDayRecords(
  filePath: string,
  onCorrupt?: (corruptPath: string | null, error: unknown) => void
): AgentRecord[] {
  try {
    if (!fs.existsSync(filePath)) return []
    const content = fs.readFileSync(filePath, 'utf-8')
    const parsed = JSON.parse(content)
    if (!Array.isArray(parsed)) return []
    return parsed.map((r: AgentRecord) => normalizeAgentRecord(r))
  } catch (e) {
    const corruptPath = isolateCorruptFile(filePath)
    onCorrupt?.(corruptPath, e)
    return []
  }
}

export function cleanupExpiredMigratedBackups(agentDir: string, now = Date.now()): number {
  if (!fs.existsSync(agentDir)) return 0
  let removed = 0
  for (const name of fs.readdirSync(agentDir)) {
    if (!name.endsWith(AGENT_MIGRATED_SUFFIX)) continue
    const filePath = path.join(agentDir, name)
    try {
      const mtime = fs.statSync(filePath).mtimeMs
      if (now - mtime > MIGRATED_RETENTION_MS) {
        fs.unlinkSync(filePath)
        removed++
      }
    } catch { /* ignore */ }
  }
  return removed
}

export function collectAgentStorageStats(agentDir: string): {
  sessionFileCount: number
  legacyDayFileCount: number
  totalSize: number
  dateLabels: string[]
} {
  let sessionFileCount = 0
  let legacyDayFileCount = 0
  let totalSize = 0
  const dateLabels = new Set<string>()

  if (!fs.existsSync(agentDir)) {
    return { sessionFileCount: 0, legacyDayFileCount: 0, totalSize: 0, dateLabels: [] }
  }

  for (const entry of fs.readdirSync(agentDir, { withFileTypes: true })) {
    if (entry.isFile() && isLegacyAgentDayFileName(entry.name)) {
      legacyDayFileCount++
      dateLabels.add(entry.name.replace(LEGACY_AGENT_DAY_SUFFIX, ''))
      totalSize += fs.statSync(path.join(agentDir, entry.name)).size
    } else if (entry.isDirectory() && isAgentDateDirName(entry.name)) {
      dateLabels.add(entry.name)
      const dateDir = path.join(agentDir, entry.name)
      for (const file of fs.readdirSync(dateDir)) {
        if (!file.endsWith('.json')) continue
        sessionFileCount++
        totalSize += fs.statSync(path.join(dateDir, file)).size
      }
    }
  }

  return {
    sessionFileCount,
    legacyDayFileCount,
    totalSize,
    dateLabels: Array.from(dateLabels).sort()
  }
}
