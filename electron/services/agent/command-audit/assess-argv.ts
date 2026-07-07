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
import { commandNeedsConfirm } from './confirm-policy'

function buildAuditedCall(input: ArgvInput): AuditedCall {
  const rule = getArgvCommandRule(input.cmd)
  // 即使 rule 不存在（未知命令），也要拆出 flags —— 否则 indirection-guard
  // 拿不到 -c/-e/-exec 等 flag，会漏拦 bash -c / node -e 等已知模式。
  // 用一个通用规则：所有 - 开头的参数都是 flag，其余都是路径。
  const fallbackRule = rule ?? {
    cmd: input.cmd,
    baseLevel: 'moderate' as const,
    safeFlags: new Set<string>(),
    valueFlags: new Set<string>(),
    pathMode: 'all' as const,
    writesTo: false,
  }
  const parsed = splitArgv(input.args, fallbackRule)
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
    const call = buildAuditedCall(input)
    const callAssessment = assessAuditedCall(call, { ...ctx, cwd })
    return {
      level: callAssessment.level,
      parsed: true,
      hasUnknown: true,
      calls: [callAssessment],
    }
  }

  const call = buildAuditedCall(input)
  const callAssessment = assessAuditedCall(call, { ...ctx, cwd })

  return {
    level: callAssessment.level,
    parsed: true,
    hasUnknown: callAssessment.unknown ?? false,
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

/** 是否需要用户确认 */
export function argvNeedsConfirm(
  assessment: CommandRiskAssessment,
  executionMode: 'strict' | 'relaxed' | 'free',
): boolean {
  return commandNeedsConfirm(assessment, executionMode)
}

/** blocked 级别不可执行 */
export function isArgvBlocked(level: RiskLevel): boolean {
  return level === 'blocked'
}
