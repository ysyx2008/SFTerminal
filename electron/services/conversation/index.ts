/**
 * Conversation 模块公共导出
 *
 * 重构进行中（见 docs/conversation-refactor-design.md）：
 * - ✅ 阶段 2a：`ConversationStore`（委托 HistoryService 的存储接缝）
 * - 🔨 阶段 2b：`Conversation` 聚合根（真实 transcript + taskMemory + cachePrefix）——
 *      数据模型 + 序列化/切分/commit/cache 决策已落地并独立测试；Agent 委托接线为下一步。
 * - ⏳ 阶段 3：`ConversationManager` + 策略表
 *
 * 早期基于「AgentRecord 是单任务」误判的扁平模型脚手架（旧 conversation.ts/manager.ts/messages.ts）
 * 已删除，按真实模型重建。
 */
export { ConversationStore } from './storage'
export { Conversation } from './conversation'
export type { ConversationCreateOptions, ConversationDeps, CommitRunInput } from './conversation'
