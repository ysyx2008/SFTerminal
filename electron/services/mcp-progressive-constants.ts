/**
 * MCP 渐进披露常量（service / agent 共用，避免双向依赖）
 * @see electron/services/MCP_SPEC.md
 */

/** skill_id 前缀：`mcp:<serverId>` */
export const MCP_SKILL_ID_PREFIX = 'mcp:'

/** @deprecated 已改为「有已连接 MCP 即 defer」；保留供旧测试/引用兼容 */
export const MCP_PRELOAD_THRESHOLD = 10

export function toMcpSkillId(serverId: string): string {
  return `${MCP_SKILL_ID_PREFIX}${serverId}`
}

/** 若为 `mcp:…` 则返回 serverId，否则 null */
export function parseMcpSkillId(skillId: string): string | null {
  const id = skillId.trim()
  if (!id.startsWith(MCP_SKILL_ID_PREFIX)) return null
  const serverId = id.slice(MCP_SKILL_ID_PREFIX.length).trim()
  return serverId || null
}
