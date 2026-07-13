/** 独立助手工作台产出物面板快照（list_workbench_artifacts 返回） */
export interface WorkbenchArtifactItem {
  id: string
  title: string
  renderer: string
  filePath: string | null
  updatedAt: number
}

export interface WorkbenchArtifactSnapshot {
  workbenchKind: 'assistant'
  tabId: string
  panelVisible: boolean
  activeArtifactId: string | null
  artifacts: WorkbenchArtifactItem[]
}
