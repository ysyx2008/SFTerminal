/**
 * 确认弹窗「信任命令 → 加入用户规则库」的资格判定
 *
 * 仅对：解析成功、恰好一条未知子命令、非 blocked、非内置命令。
 * 间接执行 / 复合管道 / 已有规则 → 不提供入口。
 */
import type { RiskLevel } from '@shared/types/agent'
import type { CommandRiskAssessment } from './types'
import { ARGV_COMMAND_RULES, basenameCommand } from './whitelist'

/** 确认卡片上的「加入规则」要约（默认中风险） */
export interface TrustCommandOffer {
  cmd: string
  /** 写入用户规则时的 writesTo 默认值 */
  writesTo: boolean
  /** 固定 moderate：少确认，不是当只读放行 */
  baseLevel: 'moderate'
}

export function resolveTrustCommandOffer(
  assessment: CommandRiskAssessment,
  riskLevel: RiskLevel,
): TrustCommandOffer | null {
  if (!assessment.parsed || riskLevel === 'blocked') return null

  const commandCalls = assessment.calls.filter(
    c => typeof c.cmd === 'string' && c.cmd.trim().length > 0,
  )
  if (commandCalls.length !== 1) return null

  const call = commandCalls[0]
  if (!call.unknown || call.level === 'blocked') return null

  // filter 已保证 cmd 非空
  const cmd = basenameCommand(call.cmd as string).toLowerCase()
  if (!cmd || cmd === '.' || cmd === '..') return null
  // 双保险：未知标记应已排除内置；仍显式拒绝覆盖内置
  if (ARGV_COMMAND_RULES[cmd]) return null

  return {
    cmd,
    writesTo: call.inferredWritesTo === true,
    baseLevel: 'moderate',
  }
}
