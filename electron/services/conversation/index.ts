/**
 * Conversation 模块公共导出
 *
 * 重构进行中（见 docs/conversation-refactor-design.md）：
 * - ✅ 阶段 2a：`ConversationStore`（委托 HistoryService 的存储接缝）
 * - ✅ 阶段 2b：`Conversation` 聚合根（真实 transcript + taskMemory + cachePrefix），Agent 已委托
 * - 🔨 阶段 3：`ConversationManager` + `CONVERSATION_POLICY` 策略表（策略 + 查询接缝；
 *      所有权反转留待 Phase 4 与 Agent 去状态化一并做）
 *
 * 早期基于「AgentRecord 是单任务」误判的扁平模型脚手架（旧 conversation.ts/manager.ts/messages.ts）
 * 已删除，按真实模型重建。
 */
export { ConversationStore } from './storage'
export { Conversation } from './conversation'
export { ConversationManager } from './manager'
export { CONVERSATION_POLICY, conversationPolicy } from './policy'
export type { ConversationPolicy } from './policy'
export type { ConversationCreateOptions, ConversationDeps, CommitRunInput } from './conversation'
export {
  splitMessagesIntoTasks,
  splitStepsIntoTasks,
  stepRecordToStep,
  chunkStepsByUserTask
} from './messages'
export type { TaskIdFactory, MessageTask, StepTask } from './messages'
