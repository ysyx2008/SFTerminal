/**
 * 持久化「始终允许」命中检查（命令类工具用）
 */
import type { RiskLevel } from '@shared/types/agent'
import { buildAllowlistKey } from './key'
import { getUserAllowlist, type AllowlistCheckResult } from './user-allowlist'

export async function checkPersistedAllowlist(
  toolName: string,
  toolArgs: Record<string, unknown>,
  reassess: () => Promise<RiskLevel> | RiskLevel,
): Promise<AllowlistCheckResult & { key: string }> {
  const key = buildAllowlistKey(toolName, toolArgs)
  const result = await getUserAllowlist().check(key, reassess)
  return { ...result, key }
}
