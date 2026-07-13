/**
 * @sailfish/workbench-sdk
 *
 * 工作台 SDK：类型 / 注册表 / prompt 解析 / bootstrap / AiPanel 正式出口。
 * AiPanel 实现仍在 desktop（依赖未解耦）；岗位定制靠 descriptor.agentPrompt/skills/mcpServers。
 */
export type {
  WorkbenchKind,
  WorkbenchDescriptor,
  WorkbenchAgentPromptTab,
  RegionSpec,
  RegionRole,
  RegionSide,
} from './types'

export {
  registerWorkbench,
  getWorkbenchDescriptor,
  listWorkbenchDescriptors,
  clearWorkbenchRegistryForTests,
} from './registry-store'

export { resolveWorkbenchAgentPrompt } from './resolve-workbench-agent-prompt'
export { bootstrapWorkbenchCapabilities } from './bootstrap'
export type { WorkbenchBootstrapResult } from './bootstrap'

/** 同款对话请从 `@sailfish/workbench-sdk/ai-panel` 导入，避免主入口拉入 Vue 巨石 */
