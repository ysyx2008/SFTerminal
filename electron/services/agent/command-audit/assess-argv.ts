/**
 * argv 通道命令审计
 *
 * 流程：白名单 → flag 检查 → 路径分区（优先）→ Fail-Closed
 */
import type { RiskLevel } from '@shared/types/agent'
import { getScratchPath, getWorkspacePath } from '../tools/file'
import type {
  ArgvInput,
  AuditContext,
  AuditedCall,
  CommandRiskAssessment,
} from './types'
import { getArgvCommandRule, splitArgv } from './whitelist'
import { assessAuditedCall } from './assess-call'

function buildAuditedCall(input: ArgvInput): AuditedCall {
  const rule = getArgvCommandRule(input.cmd)
  const parsed = rule ? splitArgv(input.args, rule) : { flags: [], paths: input.args, otherArgs: [] }
  const raw = [input.cmd, ...input.args].join(' ')
  return {
    cmd: input.cmd,
    flags: parsed.flags,
    args: parsed.otherArgs,
    paths: parsed.paths,
    redirects: [],
    raw,
    source: 'argv',
  }
}

/**
 * 评估 argv 执行请求的风险
 */
export function assessArgvRisk(input: ArgvInput, ctx: AuditContext = {}): CommandRiskAssessment {
  const cwd = input.cwd ?? ctx.cwd ?? getScratchPath()
  const rule = getArgvCommandRule(input.cmd)

  if (!rule) {
    return {
      level: 'dangerous',
      parsed: true,
      calls: [{
        level: 'dangerous',
        commandLevel: 'dangerous',
        reasons: [`命令不在 argv 白名单：${input.cmd}`],
      }],
    }
  }

  const call = buildAuditedCall(input)
  const callAssessment = assessAuditedCall(call, { ...ctx, cwd })

  return {
    level: callAssessment.level,
    parsed: true,
    calls: [callAssessment],
  }
}

/** 构造默认审计上下文（assistant 模式） */
export function defaultAuditContext(cwd?: string): AuditContext {
  return {
    workspaceRoot: getWorkspacePath(),
    cwd: cwd ?? getScratchPath(),
    shell: 'unknown',
  }
}

/** 是否需要用户确认（与 executionMode 配合） */
export function argvNeedsConfirm(
  level: RiskLevel,
  executionMode: 'strict' | 'relaxed' | 'free',
): boolean {
  if (executionMode === 'strict') return true
  if (executionMode === 'free') return false
  return level === 'dangerous' || level === 'blocked'
}

/** blocked 级别不可执行 */
export function isArgvBlocked(level: RiskLevel): boolean {
  return level === 'blocked'
}
