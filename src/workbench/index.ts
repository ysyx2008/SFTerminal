export {
  getWorkbenchDescriptor,
  listWorkbenchDescriptors,
  registerWorkbench,
  resolveWorkbenchRenderer,
  resolveWorkbenchKind,
  isWorkbenchAvailable,
} from './registry'
export type { WorkbenchDescriptor, WorkbenchKind, RegionSpec, WorkbenchAgentPromptTab } from './types'
export {
  resolveWorkbenchAgentPrompt,
} from './resolve-workbench-agent-prompt'
export { AGENT_PROMPT as ASSISTANT_WORKBENCH_AGENT_PROMPT } from './assistant/prompt'
export { descriptor as assistantWorkbenchDescriptor } from './assistant/descriptor'
export { useAssistantArtifactStore, useCanvasStore } from '@sailfish/workbench-assistant/artifact/store'
export { bootstrapWorkbenchCapabilities } from './bootstrap'
