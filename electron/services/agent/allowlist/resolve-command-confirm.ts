/**
 * 命令类工具：持久化「始终允许」命中 + 确认决策
 */
import type { RiskLevel } from '@shared/types/agent'
import type { AgentConfig } from '../types'
import type { ToolExecutorConfig, ToolResult } from '../tools/types'
import { commandNeedsConfirm } from '../command-audit/confirm-policy'
import type { CommandRiskAssessment } from '../command-audit/types'
import { t } from '../i18n'
import { checkPersistedAllowlist } from './check-persisted'

export type CommandConfirmDecision =
  | { proceed: true; userApproved: boolean }
  | { proceed: false; result: ToolResult }

export async function resolveCommandToolConfirmation(
  toolName: string,
  toolArgs: Record<string, unknown>,
  assessment: CommandRiskAssessment,
  config: AgentConfig,
  toolCallId: string,
  riskLevel: RiskLevel,
  executor: ToolExecutorConfig,
  reassess: () => Promise<RiskLevel> | RiskLevel,
): Promise<CommandConfirmDecision> {
  const needConfirm = commandNeedsConfirm(assessment, config.executionMode)
  if (!needConfirm) {
    return { proceed: true, userApproved: false }
  }

  const persisted = await checkPersistedAllowlist(toolName, toolArgs, reassess)
  if (persisted.action === 'block') {
    return {
      proceed: false,
      result: {
        success: false,
        output: '',
        error: t('hint.security_blocked'),
      },
    }
  }
  if (persisted.action === 'allow') {
    return { proceed: true, userApproved: true }
  }

  const approved = await executor.waitForConfirmation(
    toolCallId,
    toolName,
    toolArgs,
    riskLevel,
  )
  if (!approved) {
    return {
      proceed: false,
      result: {
        success: false,
        output: '',
        error: t('error.user_rejected_command'),
      },
    }
  }
  return { proceed: true, userApproved: true }
}
