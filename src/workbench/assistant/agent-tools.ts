/**
 * assistant 工作台贡献给 Agent 的内置工具（由 getAgentTools assistant 模式注册）
 */

export const LIST_WORKBENCH_ARTIFACTS = 'list_workbench_artifacts'

export const ASSISTANT_WORKBENCH_AGENT_TOOLS = [
  {
    type: 'function',
    function: {
      name: LIST_WORKBENCH_ARTIFACTS,
      description: `查询当前独立助手工作台右侧产出物面板的**实时状态**。

返回 panelVisible（面板是否展开）、artifacts（文件类产出物 tab 列表：title / renderer / filePath）、activeArtifactId。

对话流中的 chart 不会出现在 artifacts 里。向用户描述「面板里现在有什么」前应优先调用本工具，勿凭推断作答。`,
      parameters: {
        type: 'object',
        properties: {},
        required: []
      }
    },
    _meta: {
      supportedModes: ['assistant'],
      parallelizable: true,
      contextBudget: { toolResult: 'clearable' },
      streamDisplay: { titleKey: 'workbench.list_artifacts' }
    }
  }
] as const
