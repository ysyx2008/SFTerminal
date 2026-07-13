/**
 * @sailfish/workbench-assistant
 *
 * 助手工作台包：descriptor / prompt / agent-tools / AssistantWorkbench / artifact。
 * 对话经 `@sailfish/workbench-sdk/ai-panel`；产出物为本岗私货（非 SDK 公共壳）。
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

export {
  useAssistantArtifactStore,
  useCanvasStore,
  type ArtifactDiskSyncEvent,
} from './artifact/store'
export { useArtifactAgentBridge } from './artifact/composables/useArtifactAgentBridge'
export {
  registerArtifactDesktopHost,
  type ArtifactDesktopHost,
} from './artifact/host'
