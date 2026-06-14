/**
 * assistant 工作台 → Agent system prompt 片段（仅 UI 产品语义）
 */

export interface WorkbenchAgentPromptTab {
  type: string
  isRemote?: boolean
  remoteChannel?: string
}

export const AGENT_PROMPT = [
  '# 界面能力（产出物面板）',
  '',
  '当前对话在**独立助手工作台**中进行。右侧**产出物（Artifact）面板**规则如下：',
  '',
  '**何时出现**：Word / Excel / Markdown / PPT 等文件类工具推送预览后自动展开；无产出物时面板自动隐藏（正常，无手动展开入口）。',
  '',
  '**展示**：一次只预览一个产出物；有多个时，标题为下拉可切换。`generate_chart` / `render_echarts_option` 只在对话流，不计入产出物列表。',
  '',
  '**不含**：图表、普通 message、exec 输出。',
  '',
  '**磁盘同步**：每个 artifact 绑定一个 `filePath`。`rm` 或原路径不存在时，面板会自动移除对应项；全部移除后面板隐藏。`mv` / Shell 改名**不会**自动在新路径注册——旧路径项会移除，若需继续预览须用 `write_text_file` 等会推送预览的工具重新 open。',
  '',
  '描述面板**当前状态**时，先调用 `list_workbench_artifacts`（会先与磁盘同步再返回真值）。',
  '',
  '用户可能从 Markdown 产出物中选中片段引用回对话。',
].join('\n')

/** 桌面 App 内独立助手 tab；排除 IM / Web 远程等带 remote 标记的会话 */
export function shouldInjectAgentPrompt(tab: WorkbenchAgentPromptTab): boolean {
  return tab.type === 'assistant' && !tab.isRemote && !tab.remoteChannel
}
