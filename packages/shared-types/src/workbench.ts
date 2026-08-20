/** 独立助手工作台产出物面板快照（list_workbench_artifacts 返回） */
export interface WorkbenchArtifactItem {
  id: string
  title: string
  renderer: string
  filePath: string | null
  updatedAt: number
  /** 面板内是否有用户未保存的修改（人机双写：Agent 改盘前可据此判断冲突） */
  dirty: boolean
}

export interface WorkbenchArtifactSnapshot {
  workbenchKind: 'assistant'
  tabId: string
  panelVisible: boolean
  activeArtifactId: string | null
  artifacts: WorkbenchArtifactItem[]
}

/**
 * 产出物选区作用域：只进模型旁路，不上聊天气泡。
 * 行号不精确时 Agent 以 excerpt 内容锚定。
 */
export interface WorkbenchSelectionScope {
  label: string
  sourcePath: string | null
  sourceLinesAccurate: boolean
  startLine: number | null
  endLine: number | null
  excerpt: string
}

/**
 * 工作台 → Agent 的可扩展上下文袋。
 * 组装进 API 消息信封，不写入 user_task / user_supplement 展示正文。
 * 新增能力只加可选键，勿把脚手架拼进用户可见字符串。
 */
export interface WorkbenchContext {
  selectionScope?: WorkbenchSelectionScope
}
