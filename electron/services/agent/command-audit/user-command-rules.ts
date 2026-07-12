/**
 * 用户命令规则（追加式 CommandRule）
 *
 * - 只允许补充内置 ARGV_COMMAND_RULES 未收录的命令名
 * - 不可覆盖内置；不可自建 blocked
 * - Agent 不可读写存储文件（userdata-guard 禁区）
 */
import { app } from 'electron'
import { promises as fs } from 'fs'
import * as fsSync from 'fs'
import * as path from 'path'
import type { RiskLevel } from '@shared/types/agent'
import { createLogger } from '../../../utils/logger'
import { ARGV_COMMAND_RULES, basenameCommand, type CommandRule } from './whitelist'

const log = createLogger('UserCommandRules')

export const USER_COMMAND_RULES_FILENAME = 'agent-command-rules.json'

/** 用户可设的基础风险（不含 blocked） */
export const USER_RULE_ALLOWED_LEVELS: readonly RiskLevel[] = ['safe', 'moderate', 'dangerous'] as const

export type UserCommandRulePathMode = 'all' | 'fixed' | 'none'

/** 持久化 / IPC 用的可序列化规则 */
export interface UserCommandRuleRecord {
  cmd: string
  baseLevel: RiskLevel
  writesTo: boolean
  pathMode: UserCommandRulePathMode
  safeFlags: string[]
}

interface UserCommandRulesFile {
  version: number
  rules: UserCommandRuleRecord[]
}

let storePathOverride: string | null = null

function getStorePath(): string {
  if (storePathOverride) return storePathOverride
  return path.join(app.getPath('userData'), USER_COMMAND_RULES_FILENAME)
}

function normalizeCmd(cmd: string): string {
  return basenameCommand(cmd).toLowerCase()
}

function normalizeSafeFlags(flags: unknown): string[] {
  if (!Array.isArray(flags)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const f of flags) {
    if (typeof f !== 'string') continue
    const t = f.trim()
    if (!t || seen.has(t)) continue
    seen.add(t)
    out.push(t)
  }
  return out.sort()
}

function parseSafeFlagsInput(raw: string | string[]): string[] {
  if (Array.isArray(raw)) return normalizeSafeFlags(raw)
  const parts = raw.split(/[\s,]+/).map(s => s.trim()).filter(Boolean)
  return normalizeSafeFlags(parts)
}

function isAllowedLevel(level: unknown): level is RiskLevel {
  return typeof level === 'string' && (USER_RULE_ALLOWED_LEVELS as readonly string[]).includes(level)
}

function recordToCommandRule(rec: UserCommandRuleRecord): CommandRule {
  return {
    cmd: rec.cmd,
    baseLevel: rec.baseLevel,
    safeFlags: new Set(rec.safeFlags),
    pathMode: rec.pathMode,
    writesTo: rec.writesTo,
  }
}

function sanitizeRecord(raw: unknown): UserCommandRuleRecord | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (typeof o.cmd !== 'string' || !o.cmd.trim()) return null
  const cmd = normalizeCmd(o.cmd)
  if (!cmd || ARGV_COMMAND_RULES[cmd]) return null
  if (!isAllowedLevel(o.baseLevel)) return null
  const writesTo = o.writesTo === true
  // v1 不支持 fixed（缺 pathArgIndices 会静默丢路径）；只读默认 none，写盘默认 all
  let pathMode: UserCommandRulePathMode = writesTo ? 'all' : 'none'
  if (o.pathMode === 'all' || o.pathMode === 'none') {
    pathMode = o.pathMode
  }
  return {
    cmd,
    baseLevel: o.baseLevel,
    writesTo,
    pathMode,
    safeFlags: normalizeSafeFlags(o.safeFlags),
  }
}

export class UserCommandRules {
  private records = new Map<string, UserCommandRuleRecord>()
  private loaded = false

  ensureLoadedSync(): void {
    if (this.loaded) return
    const filePath = getStorePath()
    try {
      const raw = fsSync.readFileSync(filePath, 'utf-8')
      const parsed = JSON.parse(raw) as UserCommandRulesFile
      this.records.clear()
      if (parsed && Array.isArray(parsed.rules)) {
        for (const item of parsed.rules) {
          const rec = sanitizeRecord(item)
          if (rec) this.records.set(rec.cmd, rec)
        }
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') {
        log.warn(`Failed to load user command rules from ${filePath}:`, err)
      }
      this.records.clear()
    }
    this.loaded = true
  }

  async load(): Promise<void> {
    this.ensureLoadedSync()
  }

  private async save(): Promise<void> {
    const filePath = getStorePath()
    const payload: UserCommandRulesFile = {
      version: 1,
      rules: this.list(),
    }
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    const tmpPath = `${filePath}.${process.pid}.tmp`
    await fs.writeFile(tmpPath, JSON.stringify(payload, null, 2), 'utf-8')
    await fs.rename(tmpPath, filePath)
  }

  lookup(cmdName: string): CommandRule | undefined {
    this.ensureLoadedSync()
    const rec = this.records.get(normalizeCmd(cmdName))
    return rec ? recordToCommandRule(rec) : undefined
  }

  list(): UserCommandRuleRecord[] {
    this.ensureLoadedSync()
    return [...this.records.values()].sort((a, b) => a.cmd.localeCompare(b.cmd))
  }

  /**
   * 添加或更新用户规则。
   * @returns error code on failure
   */
  async upsert(input: {
    cmd: string
    baseLevel: RiskLevel
    writesTo?: boolean
    pathMode?: UserCommandRulePathMode
    safeFlags?: string | string[]
  }): Promise<{ ok: true; rule: UserCommandRuleRecord } | { ok: false; error: string }> {
    this.ensureLoadedSync()
    const cmd = normalizeCmd(input.cmd)
    if (!cmd || cmd === '.' || cmd === '..') return { ok: false, error: 'empty_cmd' }
    if (ARGV_COMMAND_RULES[cmd]) return { ok: false, error: 'builtin_conflict' }
    if (!isAllowedLevel(input.baseLevel)) return { ok: false, error: 'invalid_level' }

    const writesTo = input.writesTo === true
    // v1：不支持 fixed（无 pathArgIndices）；显式传入 fixed 则拒绝
    if (input.pathMode === 'fixed') {
      return { ok: false, error: 'fixed_path_mode_unsupported' }
    }
    const pathMode: UserCommandRulePathMode =
      input.pathMode === 'all' || input.pathMode === 'none'
        ? input.pathMode
        : (writesTo ? 'all' : 'none')

    const rec: UserCommandRuleRecord = {
      cmd,
      baseLevel: input.baseLevel,
      writesTo,
      pathMode,
      safeFlags: parseSafeFlagsInput(input.safeFlags ?? []),
    }
    this.records.set(cmd, rec)
    await this.save()
    return { ok: true, rule: rec }
  }

  async remove(cmd: string): Promise<boolean> {
    this.ensureLoadedSync()
    const key = normalizeCmd(cmd)
    if (!this.records.has(key)) return false
    this.records.delete(key)
    await this.save()
    return true
  }

  async clear(): Promise<void> {
    this.ensureLoadedSync()
    if (this.records.size === 0) return
    this.records.clear()
    await this.save()
  }
}

let singleton: UserCommandRules | null = null

export function getUserCommandRules(): UserCommandRules {
  singleton ??= new UserCommandRules()
  return singleton
}

/** 同步查找（供 getArgvCommandRule）；未加载时先读盘 */
export function lookupUserCommandRule(cmdName: string): CommandRule | undefined {
  return getUserCommandRules().lookup(cmdName)
}

export function resetUserCommandRulesForTest(storePath?: string): UserCommandRules {
  singleton = new UserCommandRules()
  storePathOverride = storePath ?? null
  return singleton
}

export function clearUserCommandRulesTestState(): void {
  singleton = null
  storePathOverride = null
}
