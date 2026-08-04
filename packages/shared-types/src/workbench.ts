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
