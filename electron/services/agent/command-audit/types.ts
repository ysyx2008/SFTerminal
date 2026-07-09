/**
 * 命令审计类型定义
 *
 * 设计原则：
 * - Fail-Closed：解析失败 / 动态命令 / 写操作未知 → dangerous；纯只读未知 → moderate + 强制确认
 * - 路径优先：先判断路径是否在工作区，再判断命令本身
 * - 沙箱分区：工作区内按 free/protected/workspace 三档调整风险
 */

import type { RiskLevel } from '@shared/types/agent'

/**
 * 工作区路径分区
 *
 * 分区设计（C 方案）：
 * - free      自由区（scratch/、charts/）—— 读写删全免确认
 * - protected 保护文件（templates/、IDENTITY.md 等）—— 写/删需确认
 * - workspace  工作区内其他位置 —— 写/删需确认（moderate）
 * - outside    工作区外 —— 危险操作（dangerous）/ 越界（blocked）
 */
export type WorkspaceZone = 'free' | 'protected' | 'workspace' | 'outside'

/**
 * 命令审计上下文
 *
 * 审计时需要的环境信息：当前工作目录、工作区根、shell 类型。
 */
export interface AuditContext {
  /** 工作区根目录（agent-workspace/），用于路径分区判断 */
  workspaceRoot?: string
  /** 命令的当前工作目录（cwd 参数或 spawn cwd） */
  cwd?: string
  /** shell 类型，影响审计策略 */
  shell?: 'bash' | 'zsh' | 'sh' | 'powershell' | 'cmd' | 'unknown'
}

/**
 * 已审计的命令调用（统一中间表示）
 *
 * shell 通道由 AST 解析后归一化为此结构。
 */
export interface AuditedCall {
  /** 命令名（已 unwrap wrapper，如 sudo rm 的 cmd 仍是 "rm"） */
  cmd: string
  /** 规范化后的 flags（合并短 flag：-rf → -r -f） */
  flags: string[]
  /** 非路径、非 flag 的位置参数 */
  args: string[]
  /** 路径参数（按在原命令中的位置标记，用于路径分区判断） */
  paths: string[]
  /** 重定向（> file、>> file、< file 等）—— 写重定向的路径参与风险判定 */
  redirects: AuditedRedirect[]
  /** wrapper 信息（sudo / bash -c / sh -c / eval 等）—— 已 unwrap */
  wrapper?: {
    name: string
    /** wrapper 的额外参数，如 sudo -u root 的 "root" */
    args?: string[]
    /** bash -c 'script' 中的内层脚本（已递归审计时为空，否则需递归） */
    script?: string
  }
  /** 原始命令文本（用于错误信息和日志） */
  raw: string
  /** shell 来源（AST 解析的 shell 类型） */
  source: 'bash' | 'zsh' | 'sh'
  /** 存在 $VAR / $(...) 等无法静态解析的路径参数 */
  dynamicPaths?: boolean
}

/**
 * 命令重定向
 */
export interface AuditedRedirect {
  /** 重定向类型 */
  op: '>' | '>>' | '<' | '2>' | '2>>' | '&>' | '2>&1'
  /** 目标路径（重定向到文件时；2>&1 这类 fd 复制无路径） */
  target?: string
  /** 是否为写操作（>、>>、2>、&> 等会写文件） */
  isWrite: boolean
}

/**
 * 单条命令的审计结果
 */
export interface CallRiskAssessment {
  /** 最终风险等级（已经过路径调整） */
  level: RiskLevel
  /** 命令本身风险（未经路径调整） */
  commandLevel: RiskLevel
  /** 触发此风险等级的原因（用于确认卡片展示给用户） */
  reasons: string[]
  /** 路径分区分析（用于调试和审计日志） */
  pathZones?: WorkspaceZone[]
  /** 不在 argv 白名单（relaxed 模式下仍需确认） */
  unknown?: boolean
}

/**
 * 整条命令（可能包含多条子命令）的审计结果
 */
export interface CommandRiskAssessment {
  /** 最终风险等级（所有子命令的最高等级） */
  level: RiskLevel
  /** 每条子命令的审计详情 */
  calls: CallRiskAssessment[]
  /** 是否成功解析（false 表示走 Fail-Closed 保守路径） */
  parsed: boolean
  /** 解析失败原因（parsed=false 时） */
  parseError?: string
  /** 是否包含未识别子命令（relaxed 下仍需确认） */
  hasUnknown?: boolean
}

/**
 * 系统路径黑名单条目（跨平台）
 *
 * 这些路径无论命令如何都被 blocked，不可被工作区降级：
 * - 系统根目录、系统目录
 * - 关键系统文件
 *
 * 注意：read-only 命令（cat、ls）对这些路径的读取是 safe，
 * 黑名单只对写操作（rm、mv、>、chmod 等）生效。
 */
export interface SystemPathPattern {
  /** 匹配正则 */
  pattern: RegExp
  /** 人类可读描述（用于设置页只读展示） */
  description: string
}

export const SYSTEM_PATH_PATTERNS: readonly SystemPathPattern[] = [
  // Unix 系统根
  { pattern: /^\/$/, description: '/ (文件系统根)' },
  // 系统配置
  { pattern: /^\/etc(\/|$)/, description: '/etc 及其子目录' },
  { pattern: /^\/private\/etc(\/|$)/, description: '/private/etc 及其子目录（macOS）' },
  // 内核虚拟 / 设备
  { pattern: /^\/dev(\/|$)/, description: '/dev 及其子目录' },
  { pattern: /^\/proc(\/|$)/, description: '/proc 及其子目录' },
  { pattern: /^\/sys(\/|$)/, description: '/sys 及其子目录' },
  // 引导 / root 家目录
  { pattern: /^\/boot(\/|$)/, description: '/boot 及其子目录' },
  { pattern: /^\/root(\/|$)/, description: '/root 及其子目录' },
  // macOS 系统目录（非 ~/Library）
  { pattern: /^\/System(\/|$)/, description: '/System 及其子目录（macOS）' },
  { pattern: /^\/Library(\/|$)/, description: '/Library 及其子目录（macOS）' },
  // Windows 系统路径
  { pattern: /^[a-zA-Z]:\\$/, description: '盘符根目录（如 C:\\）' },
  { pattern: /^[a-zA-Z]:\\Windows(\/|\\|$)/i, description: 'Windows\\ 及其子目录（任意盘符）' },
  { pattern: /^[a-zA-Z]:\\Program Files(\/|\\|$)/i, description: 'Program Files\\ 及其子目录（任意盘符）' },
  { pattern: /^[a-zA-Z]:\\Program Files \(x86\)(\/|\\|$)/i, description: 'Program Files (x86)\\ 及其子目录（任意盘符）' },
]

/**
 * 保护文件名（在工作区根目录下）
 *
 * 这些是用户的人格/配置文件，Agent 误删会很麻烦，
 * 写/删操作走 moderate 需确认。
 */
export const PROTECTED_WORKSPACE_FILES = new Set([
  'IDENTITY.md',
  'SOUL.md',
  'USER.md',
  'HEARTBEAT.md',
  'CONTACTS.md',
])

/**
 * 工作区「自由区」目录名（读写删免确认）。
 *
 * 真相源；workspace-guard.ts / file.ts 内仍保留各自的路径判定逻辑
 * （isScratchPath / isChartsPath），此处仅作为展示与未来重构的锚点。
 */
export const WORKSPACE_FREE_DIRS = ['scratch', 'charts'] as const

/**
 * 保护目录（在工作区内）
 */
export const PROTECTED_WORKSPACE_DIRS = new Set([
  'templates',
])
