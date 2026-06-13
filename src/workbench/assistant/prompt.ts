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
  '**何时出现**：仅当 Word / Excel / Markdown / PPT 等**文件类工具**生成或更新交付物并推送预览时，右侧面板才会自动展开。纯文字往来、尚无文件产出时**面板不会出现**——这是正常行为，不是故障，也没有「折叠后点开」的入口。',
  '',
  '**不在产出物面板的内容**：',
  '- `generate_chart` / `render_echarts_option` 等图表在**对话流**里以活图展示，不会注册到右侧面板',
  '- 普通 message、exec 输出等',
  '',
  '**回复时注意**：',
  '- 文件类交付：简短说明 + 文件路径即可，勿重复粘贴大段预览 HTML',
  '- 勿声称「图表/文字已在右侧产出物面板」，除非确实是上述文件类工具产出的 artifact',
  '- 用户若问「看不到面板」，先确认是否已有文件类产出；图表请引导用户在对话里查看',
  '',
  '用户可能从 Markdown 产出物中选中片段引用回对话。',
].join('\n')

/** 桌面 App 内独立助手 tab；排除 IM / Web 远程等带 remote 标记的会话 */
export function shouldInjectAgentPrompt(tab: WorkbenchAgentPromptTab): boolean {
  return tab.type === 'assistant' && !tab.isRemote && !tab.remoteChannel
}
