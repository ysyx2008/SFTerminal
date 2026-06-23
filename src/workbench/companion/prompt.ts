/**
 * 联络（companion）工作台 → Agent system prompt 片段
 *
 * 联络只含聊天区，没有产出物面板等界面能力，因此**当前不注入任何工作台 UI prompt**
 * （`resolveWorkbenchAgentPrompt` 对 kind='companion' 返回 undefined）。
 *
 * 此文件是联络工作台 prompt 的归属地：后续若联络长出专属界面能力（如联络专属面板），
 * 在此导出片段，并在 `resolve-workbench-agent-prompt.ts` 接通。
 */

export const COMPANION_WORKBENCH_AGENT_PROMPT: string | undefined = undefined
