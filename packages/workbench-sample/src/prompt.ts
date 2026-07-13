/**
 * 样例业务工作台 → Agent prompt（岗位专用说明 + 工具用法）
 */
export const SAMPLE_WORKBENCH_AGENT_PROMPT = [
  '# 样例业务工作台（sample）',
  '',
  '这是 OEM / 业务条线的**最小工作台模板**：同款对话区（AiPanel），岗位差异只改 descriptor。',
  '- 本段为岗位专用说明（system prompt 的 workbench 章节）',
  '- 技能 / MCP 在 descriptor.skills / mcpServers 声明，由 bootstrap 装配',
].join('\n')
