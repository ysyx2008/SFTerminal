export { getWorkbenchDescriptor, resolveWorkbenchRenderer } from './registry'
export type { WorkbenchDescriptor, WorkbenchKind, RegionSpec } from './types'
export {
  resolveWorkbenchAgentPrompt,
  type WorkbenchAgentPromptTab
} from './resolve-workbench-agent-prompt'
export { AGENT_PROMPT as ASSISTANT_WORKBENCH_AGENT_PROMPT } from './assistant/prompt'
export { descriptor as assistantWorkbenchDescriptor } from './assistant/descriptor'
export { useAssistantArtifactStore, useCanvasStore } from './assistant/artifact/store'
