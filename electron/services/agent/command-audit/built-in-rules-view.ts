/**
 * 内置安全规则只读视图聚合
 *
 * 把散落在 command-audit/ 各处的「宪法级」规则聚合成单一结构化对象，
 * 供设置页「安全与权限」面板只读展示。用户无法通过此视图修改任何规则。
 *
 * 设计原则：后端只返回结构化数据（路径名、模式描述等），
 * 不返回 UI 文案。文案由前端按 i18n key 渲染，避免后端绑定语言。
 *
 * 数据源：
 * - ARGV_COMMAND_RULES（whitelist.ts）
 * - SYSTEM_PATH_PATTERNS（types.ts）
 * - ALLOWED_USERDATA_ENTRIES（userdata-guard.ts）
 * - PROTECTED_WORKSPACE_FILES / PROTECTED_WORKSPACE_DIRS / WORKSPACE_FREE_DIRS（types.ts）
 */
import { app } from 'electron'
import { ARGV_COMMAND_RULES } from './whitelist'
import {
  DEV_NULL_EXEMPTIONS,
  SYSTEM_PATH_PATTERNS,
  PROTECTED_WORKSPACE_FILES,
  PROTECTED_WORKSPACE_DIRS,
  WORKSPACE_FREE_DIRS,
} from './types'
import { ALLOWED_USERDATA_ENTRIES } from './userdata-guard'
import type { RiskLevel } from '@shared/types/agent'

/** 单条 argv 命令规则的只读展示 */
export interface BuiltInCommandRuleView {
  cmd: string
  baseLevel: RiskLevel
  safeFlags: string[]
  pathMode: 'all' | 'fixed' | 'none'
  writesTo: boolean
}

/** 系统路径模式只读展示（含 severity 分级） */
export interface SystemPathPatternView {
  /** 人类可读描述（已在 types.ts 与正则成对声明） */
  description: string
  /** 严重程度：critical（写 -> blocked）/ hardened（写 -> dangerous） */
  severity: 'critical' | 'hardened'
}

/** 硬封路径块 */
export interface HardBlockedPathsView {
  /** 系统路径模式（按 severity 分级） */
  systemPatterns: SystemPathPatternView[]
  /** 黑洞设备白名单（写它们等于丢弃输出，直接 safe） */
  devNullExemptions: string[]
  /** userData 根路径 */
  userDataRoot: string
  /** userData 下允许 Agent 访问的条目 */
  userDataAllowed: string[]
}

/** 工作区路径分区视图 */
export interface WorkspaceZonesView {
  /** 自由区目录名（不含尾 /） */
  free: string[]
  protectedDirs: string[]
  protectedFiles: string[]
}

/** 内置安全规则总视图 */
export interface BuiltInRulesView {
  argvCommands: BuiltInCommandRuleView[]
  hardBlockedPaths: HardBlockedPathsView
  workspaceZones: WorkspaceZonesView
}

let cachedView: BuiltInRulesView | null = null

/**
 * 获取内置安全规则只读视图（首次调用时聚合，之后缓存）。
 *
 * 缓存原因：规则在运行期不可变（改规则需改源码并重启），
 * 重复聚合 60+ 条命令规则无意义。userData 路径在 bootstrap
 * 重定向后稳定，初始化一次即可。
 */
export function getBuiltInRulesView(): BuiltInRulesView {
  if (cachedView) return cachedView

  cachedView = {
    argvCommands: Object.entries(ARGV_COMMAND_RULES)
      .map(([cmd, rule]) => ({
        cmd,
        baseLevel: rule.baseLevel,
        safeFlags: Array.from(rule.safeFlags).sort(),
        pathMode: rule.pathMode,
        writesTo: rule.writesTo,
      }))
      .sort((a, b) => {
        const rank: Record<RiskLevel, number> = { blocked: 0, dangerous: 1, moderate: 2, safe: 3 }
        const d = rank[a.baseLevel] - rank[b.baseLevel]
        return d !== 0 ? d : a.cmd.localeCompare(b.cmd)
      }),
    hardBlockedPaths: {
      systemPatterns: SYSTEM_PATH_PATTERNS.map(p => ({
        description: p.description,
        severity: p.severity,
      })),
      devNullExemptions: [...DEV_NULL_EXEMPTIONS],
      userDataRoot: app.getPath('userData'),
      userDataAllowed: [...ALLOWED_USERDATA_ENTRIES],
    },
    workspaceZones: {
      free: [...WORKSPACE_FREE_DIRS],
      protectedDirs: [...PROTECTED_WORKSPACE_DIRS].sort(),
      protectedFiles: [...PROTECTED_WORKSPACE_FILES].sort(),
    },
  }

  return cachedView
}

/** 测试用：清缓存（用于在测试中切换 userData 路径） */
export function resetBuiltInRulesViewCacheForTest(): void {
  cachedView = null
}
