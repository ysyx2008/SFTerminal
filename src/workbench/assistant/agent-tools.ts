/**
 * assistant 工作台贡献给 Agent 的内置工具（由 getAgentTools assistant 模式注册）
 */

export const LIST_WORKBENCH_ARTIFACTS = 'list_workbench_artifacts'
export const MANAGE_WORKBENCH_ARTIFACTS = 'manage_workbench_artifacts'

export const ASSISTANT_WORKBENCH_AGENT_TOOLS = [
  {
    type: 'function',
    function: {
      name: LIST_WORKBENCH_ARTIFACTS,
      description: `查询当前独立助手工作台右侧产出物面板的**实时状态**。

返回 panelVisible（面板是否展开）、artifacts（文件类产出物 tab 列表：title / renderer / filePath）、activeArtifactId。

调用时会先与磁盘同步（移除 filePath 已不存在的 tab），再返回快照。chart 不会出现在 artifacts 里。向用户描述「面板里现在有什么」前应优先调用本工具，勿凭推断作答。`,
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
  },
  {
    type: 'function',
    function: {
      name: MANAGE_WORKBENCH_ARTIFACTS,
      description: `维护右侧产出物面板：把已有本地文件打开进面板预览，或关闭面板里的某个产出物。

用途：用户想"重新打开/重新推送某个文件到面板"、把之前生成的结果再次展示、或清理面板时。

action='open'：打开 path 指向的文件到面板。仅支持可直接预览的文本文件（.md / .markdown / .html / .htm）；Word(.docx) 请用 word_open、Excel(.xlsx) 用 excel_open、PPT 用 ppt 工具。
action='close'：按 path 从面板移除对应产出物。

path 建议传绝对路径（相对路径按当前工作目录解析）。`,
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['open', 'close'],
            description: '打开文件到面板 或 从面板关闭'
          },
          path: {
            type: 'string',
            description: '本地文件绝对路径（相对路径按 cwd 解析）'
          },
          title: {
            type: 'string',
            description: '可选，面板 tab 显示标题，默认用文件名'
          }
        },
        required: ['action', 'path']
      }
    },
    _meta: {
      supportedModes: ['assistant'],
      streamDisplay: { titleKey: 'workbench.manage_artifacts' }
    }
  }
] as const
