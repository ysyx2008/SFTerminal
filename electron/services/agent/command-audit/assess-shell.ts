/**
 * shell 通道命令审计（PTY exec / execute_command）
 *
 * 流程：shell-ast 解析 → 拆子命令 → 白名单 + 路径分区 → Fail-Closed
 */
import type { RiskLevel } from '@shared/types/agent'
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
      calls: [{ level: blocked, commandLevel: blocked, reasons: ['整串命令命中 blocked 规则'] }],
    }
  }

  const pipeRisk = assessRemoteExecPipe(command)
  if (pipeRisk) {
    return {
      level: pipeRisk,
      parsed: false,
      calls: [{ level: pipeRisk, commandLevel: pipeRisk, reasons: ['远程下载并管道执行 shell'] }],
    }
  }

  if (isWindowsNativeShellCommand(command)) {
    const legacy = opts.legacyAssess ?? (() => 'dangerous' as RiskLevel)
    const level = legacy(command)
    return {
      level,
      parsed: false,
      calls: [{ level, commandLevel: level, reasons: ['Windows 原生 shell，regex 审计'] }],
    }
  }

  try {
    const { calls, writeRedirects } = await extractAuditedCalls(command, ctx)

    if (calls.length === 0) {
      return {
        level: 'dangerous',
        parsed: true,
        calls: [{ level: 'dangerous', commandLevel: 'dangerous', reasons: ['未解析到可审计子命令'] }],
      }
    }

    const redirectAssessment = assessRedirectPaths(writeRedirects, ctx)
    const callAssessments = calls.map(c => assessAuditedCall(c, ctx))

    if (redirectAssessment) {
      callAssessments.push(redirectAssessment)
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
        reasons: [`shell 解析失败，Fail-Closed：${msg}`],
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
