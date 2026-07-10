/**
 * 单条 AuditedCall 风险评估（shell 通道 AST 解析后归一化调用）
 */
import type { RiskLevel } from '@shared/types/agent'
import { t } from '../i18n'
import { getScratchPath } from '../tools/file'
import type { AuditContext, AuditedCall, AuditedRedirect, CallRiskAssessment } from './types'
import { assessCommandFlags, getArgvCommandRule } from './whitelist'
import { adjustRiskByPathZones } from './workspace-guard'
import { maxRisk } from './risk-level'
import { checkIndirectionGuard, byGuard } from './indirection-guard'

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

  // 未识别命令默认 moderate（strict 确认，relaxed 放行）。
  // 只有写路径确实危险时才升级 dangerous/blocked。
  if (hasWriteRedirect && allPaths.length > 0) {
    // 未识别命令默认按写命令处理（cmdWritesTo=true 语义）
    const pathAdjust = adjustRiskByPathZones('moderate', allPaths, allPaths, true, cwd)
    return {
      level: pathAdjust.level,
      commandLevel: 'moderate',
      unknown: true,
      reasons: [
        t('risk.reason.unknown_cmd', { cmd: call.cmd }),
        ...pathAdjust.reasons,
      ],
      pathZones: pathAdjust.zones,
    }
  }

  if (call.dynamicPaths) {
    // 含动态参数但无静态路径可审计，无法静态审计，moderate。
    return {
      level: 'moderate',
      commandLevel: 'moderate',
      unknown: true,
      reasons: [t('risk.reason.unknown_dynamic')],
    }
  }

  return {
    level: 'moderate',
    commandLevel: 'moderate',
    unknown: true,
    reasons: [t('risk.reason.unknown_cmd_relaxed', { cmd: call.cmd })],
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
  // 通道无关，命中按 guard 返回的 level 标记（dangerous 或 moderate）。
  // blocked 级别留给路径守卫（写系统路径等绝对禁止场景）。
  const guardHit = checkIndirectionGuard(call)
  if (guardHit) {
    return byGuard(guardHit.level, guardHit.reason)
  }

  const cwd = ctx.cwd ?? getScratchPath()
  const rule = getArgvCommandRule(call.cmd)

  if (!rule) {
    return assessUnknownCall(call, ctx, extraWritePaths)
  }

  if (call.dynamicPaths && rule.writesTo) {
    // 动态路径无法静态审计，按命令本身的危险程度降级：
    // - rm/chmod/chown 等高危命令 -> dangerous（Fail-Closed）
    // - cp/mv/mkdir/touch/ln 等轻度写命令 -> moderate（与 relaxed 放行一致）
    const dynamicLevel: RiskLevel = rule.baseLevel === 'dangerous' ? 'dangerous' : 'moderate'
    return {
      level: dynamicLevel,
      commandLevel: dynamicLevel,
      reasons: [t('risk.reason.dynamic_path')],
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
    reasons.push(t('risk.reason.unknown_flag'))
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
    // free 区可降级为 safe；outside 等 moderate 不覆盖 rm 等命令级 dangerous
    level = pathAdjust.level === 'safe'
      ? 'safe'
      : maxRisk(commandLevel, pathAdjust.level)
  } else {
    level = commandLevel
  }

  return {
    level,
    commandLevel,
    reasons: reasons.length ? reasons : [t('risk.reason.audit_pass', { source: call.source, cmd: call.cmd })],
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
      : [t('risk.reason.shell_redirect_audit')],
    pathZones: pathAdjust.zones,
  }
}

/** 从多条子命令评估聚合 hasUnknown */
export function aggregateHasUnknown(calls: CallRiskAssessment[]): boolean {
  return calls.some(c => c.unknown === true)
}
