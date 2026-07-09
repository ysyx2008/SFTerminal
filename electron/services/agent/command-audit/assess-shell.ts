/**
 * shell 通道命令审计（PTY exec / execute_command）
 *
 * 流程：shell-ast 解析 → 拆子命令 → 白名单 + 路径分区 → Fail-Closed
 */
import type { RiskLevel } from '@shared/types/agent'
import { t } from '../i18n'
import { getScratchPath, getWorkspacePath } from '../tools/file'
import { assessAuditedCall, assessRedirectPaths, aggregateHasUnknown } from './assess-call'
import { extractAuditedCalls } from './extract-calls'
import { isWindowsNativeShellCommand } from './platform-detect'
import { maxRisk, maxRiskAll } from './risk-level'
import type { AuditContext, CommandRiskAssessment } from './types'

/** 构造默认审计上下文（assistant 模式） */
export function defaultAuditContext(cwd?: string): AuditContext {
  return {
    workspaceRoot: getWorkspacePath(),
    cwd: cwd ?? getScratchPath(),
    shell: 'unknown',
  }
}

/** 整串命令级 blocked 模式（AST 前后都跑，防 fork bomb 等） */
function assessFullStringBlocked(command: string): RiskLevel | null {
  const cmd = command.toLowerCase().trim()
  const blocked = [
    /rm\s+(-[rf]+\s+)*\/(?:\s|$)/,
    /rm\s+(-[rf]+\s+)*\/\*/,
    /:\(\)\{.*:\|:.*\}/,
    /mkfs\./,
    /dd\s+.*of=\/dev\/[sh]d[a-z]/,
    />\s*\/dev\/[sh]d[a-z]/,
    /chmod\s+777\s+\//,
    /chown\s+.*\s+\//,
    />\s*\/etc\/(passwd|shadow|sudoers)/,
    /\b(rd|rmdir)\b(?=.*\/s\b)(?=.*\b[a-z]:\\["']?(?:\s|$))/,
    /\bdel\b(?=.*\/s\b)(?=.*\b[a-z]:\\\*)/,
    /\bformat\s+[a-z]:/,
    /\bremove-item\b(?=.*-recurse)(?=.*\b[a-z]:\\["']?(?:\s|$))/,
  ]
  if (blocked.some(p => p.test(cmd))) return 'blocked'
  return null
}

/** 远程代码执行管道（整串兜底） */
function assessRemoteExecPipe(command: string): RiskLevel | null {
  const cmd = command.toLowerCase()
  if (/\bcurl\s+.*\|\s*(ba)?sh\b/.test(cmd)) return 'dangerous'
  if (/\bwget\s+.*-O\s*-?\s*\|\s*(ba)?sh\b/.test(cmd)) return 'dangerous'
  return null
}

export interface AssessShellOptions {
  /** 解析失败时的回退评估（Windows regex 等） */
  legacyAssess?: (command: string) => RiskLevel
}

/**
 * 评估 shell 字符串命令风险
 */
export async function assessShellRisk(
  command: string,
  ctx: AuditContext = defaultAuditContext(),
  opts: AssessShellOptions = {},
): Promise<CommandRiskAssessment> {
  const blocked = assessFullStringBlocked(command)
  if (blocked) {
    return {
      level: blocked,
      parsed: false,
      calls: [{ level: blocked, commandLevel: blocked, reasons: [t('risk.reason.blocked_whole')] }],
    }
  }

  const pipeRisk = assessRemoteExecPipe(command)
  if (pipeRisk) {
    return {
      level: pipeRisk,
      parsed: false,
      calls: [{ level: pipeRisk, commandLevel: pipeRisk, reasons: [t('risk.reason.remote_download_pipe')] }],
    }
  }

  if (isWindowsNativeShellCommand(command)) {
    const legacy = opts.legacyAssess ?? (() => 'dangerous' as RiskLevel)
    const level = legacy(command)
    return {
      level,
      parsed: false,
      calls: [{ level, commandLevel: level, reasons: [t('risk.reason.windows_native_shell')] }],
    }
  }

  try {
    const { calls, writeRedirects } = await extractAuditedCalls(command, ctx)

    if (calls.length === 0) {
      return {
        level: 'dangerous',
        parsed: true,
        calls: [{ level: 'dangerous', commandLevel: 'dangerous', reasons: [t('risk.reason.no_auditable_call')] }],
      }
    }

    const callAssessments = calls.map(c => assessAuditedCall(c, ctx))

    // writeRedirects 已按 pos 分配到各 call 内评估，无需再全局重复评估。
    // 仅对未关联到任何 call 的 orphan redirect 做兜底评估（罕见，如 redirect 在所有 call 之前）。
    const assignedRedirectTargets = new Set(
      calls.flatMap(c => c.redirects.filter(r => r.target).map(r => r.target!)),
    )
    const orphanRedirects = writeRedirects.filter(r => r.target && !assignedRedirectTargets.has(r.target))
    if (orphanRedirects.length > 0) {
      const orphanAssessment = assessRedirectPaths(orphanRedirects, ctx)
      if (orphanAssessment) {
        callAssessments.push(orphanAssessment)
      }
    }

    const level = maxRiskAll(callAssessments.map(a => a.level))
    const hasUnknown = aggregateHasUnknown(callAssessments)

    return {
      level,
      parsed: true,
      hasUnknown,
      calls: callAssessments,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const legacy = opts.legacyAssess ?? (() => 'dangerous' as RiskLevel)
    const level = maxRisk('dangerous', legacy(command))
    return {
      level,
      parsed: false,
      parseError: msg,
      calls: [{
        level,
        commandLevel: level,
        reasons: [t('risk.reason.parse_fail_closed', { msg })],
      }],
    }
  }
}

/** @deprecated 请用 commandNeedsConfirm(assessment, mode) */
export function shellNeedsConfirm(
  level: RiskLevel,
  executionMode: 'strict' | 'relaxed' | 'free',
): boolean {
  if (executionMode === 'strict') return true
  if (executionMode === 'free') return false
  return level === 'dangerous' || level === 'blocked'
}
