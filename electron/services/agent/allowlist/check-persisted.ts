/**
 * 持久化「始终允许」命中检查（命令类工具用）
 *
 * exec / execute_command 按 command 互通命中。
 */
import type { RiskLevel } from '@shared/types/agent'
import { buildAllowlistKey, buildAllowlistKeyCandidates } from './key'
import { getUserAllowlist, type AllowlistCheckResult } from './user-allowlist'

export async function checkPersistedAllowlist(
  toolName: string,
  toolArgs: Record<string, unknown>,
  reassess: () => Promise<RiskLevel> | RiskLevel,
): Promise<AllowlistCheckResult & { key: string }> {
  const primary = buildAllowlistKey(toolName, toolArgs)
  const candidates = buildAllowlistKeyCandidates(toolName, toolArgs)
  const allowlist = getUserAllowlist()

  for (const key of candidates) {
    const result = await allowlist.check(key, reassess)
    if (result.hit) {
      return { ...result, key }
    }
  }
  return { hit: false, key: primary }
}
