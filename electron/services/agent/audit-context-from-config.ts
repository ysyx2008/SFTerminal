/**
 * 从 AgentConfig 构造 AuditContext
 *
 * 把 executionMode + commandRiskPolicy 透传到 command-audit 层，
 * 让 Fail-Closed 兜底（解析失败 / 未知命令）能按用户配置选档位。
 */
import type { AgentConfig } from './types'
import type { AuditContext } from './command-audit/types'
import { defaultAuditContext } from './command-audit'
import { getDefaultShellKind } from '../../utils/shell'

export function auditContextFromConfig(
  config: Pick<AgentConfig, 'executionMode' | 'commandRiskPolicy'>,
  cwd?: string,
): AuditContext {
  const ctx = defaultAuditContext(cwd)
  ctx.executionMode = config.executionMode
  if (config.commandRiskPolicy) {
    ctx.riskPolicy = config.commandRiskPolicy
  }
  const kind = getDefaultShellKind()
  if (kind === 'powershell') ctx.shell = 'powershell'
  else if (kind === 'cmd') ctx.shell = 'unknown'
  else ctx.shell = 'bash'
  return ctx
}
