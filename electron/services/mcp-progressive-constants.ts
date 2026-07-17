/**
 * MCP 渐进披露阈值常量（service / agent 共用，避免双向依赖）
 * @see electron/services/MCP_SPEC.md
 */

/** 已连接工具数超过此值 → defer */
export const MCP_PRELOAD_THRESHOLD = 10
