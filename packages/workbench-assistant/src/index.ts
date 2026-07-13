/**
 * @sailfish/workbench-assistant
 *
 * 助手工作台包：descriptor / prompt / agent-tools / AssistantWorkbench。
 * artifact 子系统与 AiPanel 仍在 desktop（P2 前）；Workbench 通过 `@/` 引用。
 */
export { descriptor } from './descriptor'
export { AGENT_PROMPT, shouldInjectAgentPrompt } from './prompt'
export type { WorkbenchAgentPromptTab } from './prompt'
export {
  ASSISTANT_WORKBENCH_AGENT_TOOLS,
  LIST_WORKBENCH_ARTIFACTS,
  MANAGE_WORKBENCH_ARTIFACTS,
} from './agent-tools'
export { default as AssistantWorkbench } from './AssistantWorkbench.vue'
