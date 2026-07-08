/**
 * 用户「始终允许」持久化清单（全局共享、跨重启）
 */
import { app } from 'electron'
import { promises as fs } from 'fs'
import * as path from 'path'
import type { RiskLevel } from '@shared/types/agent'
import { createLogger } from '../../../utils/logger'

const log = createLogger('UserAllowlist')

export type AllowlistSourceKind = 'task' | 'companion' | 'watch' | 'wakeup'

export interface AllowlistEntry {
  key: string
  toolName: string
  keyArgs: Record<string, unknown>
  riskLevelAtApproval: RiskLevel
  approvedAt: number
  sourceAgentKey: string
  sourceKind: AllowlistSourceKind
}

export type AllowlistCheckAction = 'allow' | 'reconfirm' | 'block'

export interface AllowlistCheckResult {
  hit: boolean
  action?: AllowlistCheckAction
  entry?: AllowlistEntry
}

const RISK_RANK: Record<RiskLevel, number> = {
  safe: 0,
  moderate: 1,
  dangerous: 2,
  blocked: 3,
}

function isRiskHigher(a: RiskLevel, b: RiskLevel): boolean {
  return RISK_RANK[a] > RISK_RANK[b]
}

interface AllowlistFile {
  version: number
  entries: AllowlistEntry[]
}

let storePathOverride: string | null = null

function getStorePath(): string {
  if (storePathOverride) return storePathOverride
  return path.join(app.getPath('userData'), 'agent-allowlist.json')
}

export class UserAllowlist {
  private entries: AllowlistEntry[] = []
  private loaded = false
  private loadPromise: Promise<void> | null = null

  async load(): Promise<void> {
    if (this.loaded) return
    this.loadPromise ??= this.doLoad()
    await this.loadPromise
    this.loadPromise = null
  }

  private async doLoad(): Promise<void> {
    const filePath = getStorePath()
    try {
      const raw = await fs.readFile(filePath, 'utf-8')
      const parsed = JSON.parse(raw) as AllowlistFile
      if (parsed && Array.isArray(parsed.entries)) {
        this.entries = parsed.entries.filter(e => e && typeof e.key === 'string')
      } else {
        this.entries = []
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') {
        log.warn(`Failed to load allowlist from ${filePath}:`, err)
      }
      this.entries = []
    }
    this.loaded = true
  }

  private async save(): Promise<void> {
    const filePath = getStorePath()
    const payload: AllowlistFile = { version: 1, entries: this.entries }
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf-8')
  }

  list(): readonly AllowlistEntry[] {
    return this.entries
  }

  async check(
    key: string,
    reassess: () => Promise<RiskLevel> | RiskLevel,
  ): Promise<AllowlistCheckResult> {
    await this.load()
    const entry = this.entries.find(e => e.key === key)
    if (!entry) return { hit: false }

    const current = await Promise.resolve(reassess())
    if (current === 'blocked') {
      await this.remove(key)
      return { hit: true, action: 'block', entry }
    }
    if (isRiskHigher(current, entry.riskLevelAtApproval)) {
      return { hit: true, action: 'reconfirm', entry }
    }
    return { hit: true, action: 'allow', entry }
  }

  async add(entry: AllowlistEntry): Promise<void> {
    await this.load()
    const idx = this.entries.findIndex(e => e.key === entry.key)
    if (idx >= 0) {
      this.entries[idx] = entry
    } else {
      this.entries.push(entry)
    }
    await this.save()
  }

  async remove(key: string): Promise<void> {
    await this.load()
    const before = this.entries.length
    this.entries = this.entries.filter(e => e.key !== key)
    if (this.entries.length !== before) {
      await this.save()
    }
  }

  async clear(): Promise<void> {
    await this.load()
    if (this.entries.length === 0) return
    this.entries = []
    await this.save()
  }

  /** 批准并更新风险快照（重新确认后用户仍选始终允许） */
  async upsertRiskSnapshot(key: string, riskLevel: RiskLevel): Promise<void> {
    await this.load()
    const entry = this.entries.find(e => e.key === key)
    if (!entry) return
    entry.riskLevelAtApproval = riskLevel
    entry.approvedAt = Date.now()
    await this.save()
  }
}

let singleton: UserAllowlist | null = null

export function getUserAllowlist(): UserAllowlist {
  singleton ??= new UserAllowlist()
  return singleton
}

/** 测试用：重置单例与存储路径 */
export function resetUserAllowlistForTest(storePath?: string): UserAllowlist {
  singleton = new UserAllowlist()
  storePathOverride = storePath ?? null
  return singleton
}

export function clearUserAllowlistTestState(): void {
  singleton = null
  storePathOverride = null
}
