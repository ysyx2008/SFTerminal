/**
 * 技能（skill）工作台 → Agent system prompt 片段
 *
 * 技能工作台是纯前端能力档案面板，**没有对话锚点区、没有 Agent 实例运行**——
 * 它只是给用户看「秘书会什么」的视图。因此当前不注入任何工作台 UI prompt
 * （`resolveWorkbenchAgentPrompt` 对 kind='skill' 返回 undefined）。
 *
 * 此文件是技能工作台 prompt 的归属地：若未来技能 tab 长出对话能力（如对单个技能追问），
 * 在此导出片段，并在 `resolve-workbench-agent-prompt.ts` 接通。
 */

export const SKILL_WORKBENCH_AGENT_PROMPT: string | undefined = undefined
