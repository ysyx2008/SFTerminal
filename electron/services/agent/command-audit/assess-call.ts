/**
 * 单条 AuditedCall 风险评估（shell 通道 AST 解析后归一化调用）
 */
import type { RiskLevel } from '@shared/types/agent'
import { getScratchPath } from '../tools/file'
import type { AuditContext, AuditedCall, AuditedRedirect, CallRiskAssessment } from './types'
import { assessCommandFlags, getArgvCommandRule } from './whitelist'
import { adjustRiskByPathZones } from './workspace-guard'
import { maxRisk } from './risk-level'
import { checkIndirectionGuard, dangerousByGuard } from './indirection-guard'

function collectWritePaths(call: AuditedCall, extraPaths: string[]): string[] {
  const fromRedirects = call.redirects
    .filter(r => r.isWrite && r.target)
    .map(r => r.target!)
  return [...call.paths, ...fromRedirects, ...extraPaths]
}

function assessUnknownCall(
  call: AuditedCall,
  ctx: AuditContext,
  extraWritePaths: string[],
): CallRiskAssessment {
  const cwd = ctx.cwd ?? getScratchPath()
  const allPaths = collectWritePaths(call, extraWritePaths)
  const hasWriteRedirect = call.redirects.some(r => r.isWrite) || extraWritePaths.length > 0

  if (call.dynamicPaths) {
    return {
      level: 'dangerous',
      commandLevel: 'dangerous',
      unknown: true,
      reasons: ['未识别命令且含动态参数，无法静态审计（Fail-Closed）'],
    }
  }

  if (hasWriteRedirect && allPaths.length > 0) {
    // 未识别命令默认按写命令处理（cmdWritesTo=true 语义）
    const pathAdjust = adjustRiskByPathZones('dangerous', allPaths, allPaths, true, cwd)
    return {
      level: maxRisk('dangerous', pathAdjust.level),
      commandLevel: 'dangerous',
      unknown: true,
      reasons: [
        `未识别命令：${call.cmd}`,
        ...pathAdjust.reasons,
      ],
      pathZones: pathAdjust.zones,
    }
  }

  return {
    level: 'moderate',
    commandLevel: 'moderate',
    unknown: true,
    reasons: [`未识别命令：${call.cmd}（relaxed 模式需确认）`],
  }
}

/**
 * 评估单条已归一化的命令调用
 */
export function assessAuditedCall(
  call: AuditedCall,
  ctx: AuditContext = {},
  extraWritePaths: string[] = [],
): CallRiskAssessment {
  // 间接执行守卫：解释器内联 / 包装器 / 调度器 / 结构性 flag 规则
  // 通道无关，命中标 dangerous（strict/relaxed 弹确认，free 放行）。
  // blocked 级别留给路径守卫（写系统路径等绝对禁止场景）。
  const guardReason = checkIndirectionGuard(call)
  if (guardReason) {
    return dangerousByGuard(guardReason)
  }

  const cwd = ctx.cwd ?? getScratchPath()
  const rule = getArgvCommandRule(call.cmd)

  if (!rule) {
    return assessUnknownCall(call, ctx, extraWritePaths)
  }

  if (call.dynamicPaths && rule.writesTo) {
    return {
      level: 'dangerous',
      commandLevel: 'dangerous',
      reasons: ['包含动态路径参数，无法静态审计（Fail-Closed）'],
    }
  }

  const hasWriteRedirect = call.redirects.some(r => r.isWrite)
  const writes = rule.writesTo || hasWriteRedirect
  // allPaths：命令参数 + 写重定向（用于 userData 检查，读+写都查）
  const allPaths = collectWritePaths(call, extraWritePaths)
  // writePaths：真正的写路径（命令写时含参数路径；只读时仅写重定向目标）
  const redirectPaths = call.redirects
    .filter(r => r.isWrite && r.target)
    .map(r => r.target!)
  const writePaths = rule.writesTo
    ? [...call.paths, ...redirectPaths, ...extraWritePaths]
    : [...redirectPaths, ...extraWritePaths]
  const commandLevel = assessCommandFlags(rule, call.flags)
  const reasons: string[] = []

  if (commandLevel === 'moderate' && rule.baseLevel === 'safe') {
    reasons.push('包含未识别的参数 flag，保守标记为中危')
  }

  const pathAdjust = adjustRiskByPathZones(
    commandLevel,
    allPaths,
    writePaths,
    writes,
    cwd,
  )
  reasons.push(...pathAdjust.reasons)

  let level: RiskLevel
  if (pathAdjust.level === 'blocked') {
    level = 'blocked'
  } else if (writes && writePaths.length > 0) {
    level = pathAdjust.level
  } else {
    level = commandLevel
  }

  return {
    level,
    commandLevel,
    reasons: reasons.length ? reasons : [`${call.source}:${call.cmd}`],
    pathZones: pathAdjust.zones,
  }
}

/** 写重定向路径的全局风险（与具体命令解耦） */
export function assessRedirectPaths(
  redirects: AuditedRedirect[],
  ctx: AuditContext = {},
): CallRiskAssessment | null {
  const writePaths = redirects.filter(r => r.isWrite && r.target).map(r => r.target!)
  if (writePaths.length === 0) return null

  const cwd = ctx.cwd ?? getScratchPath()
  const pathAdjust = adjustRiskByPathZones('moderate', writePaths, writePaths, true, cwd)
  return {
    level: pathAdjust.level,
    commandLevel: 'moderate',
    reasons: pathAdjust.reasons.length
      ? pathAdjust.reasons
      : ['shell 写重定向目标路径需审计'],
    pathZones: pathAdjust.zones,
  }
}

/** 从多条子命令评估聚合 hasUnknown */
export function aggregateHasUnknown(calls: CallRiskAssessment[]): boolean {
  return calls.some(c => c.unknown === true)
}
