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
  '**何时出现**：Word / Excel / Markdown / PPT 等文件类工具推送预览后自动展开。尚无文件产出时面板不会出现（正常，无手动展开入口）。',
  '',
  '**计数**：面板 tab 数 = 文件类 artifact 数。`generate_chart` / `render_echarts_option` 只在对话流，不增加 tab。',
  '',
  '**不含**：图表、普通 message、exec 输出。',
  '',
  '描述面板**当前状态**时，先调用 `list_workbench_artifacts` 获取真值。',
  '',
  '用户可能从 Markdown 产出物中选中片段引用回对话。',
].join('\n')

/** 桌面 App 内独立助手 tab；排除 IM / Web 远程等带 remote 标记的会话 */
export function shouldInjectAgentPrompt(tab: WorkbenchAgentPromptTab): boolean {
  return tab.type === 'assistant' && !tab.isRemote && !tab.remoteChannel
}
