/**
 * 联络（companion）工作台 → Agent system prompt 片段
 *
 * 联络只含聊天区，没有产出物面板等界面能力，因此**当前不注入任何工作台 UI prompt**
 * （descriptor.agentPrompt 为 undefined）。
 *
 * 此文件是联络工作台 prompt 的归属地：后续若联络长出专属界面能力，
 * 在此导出片段并写入 companion/descriptor.ts 的 agentPrompt。
 */

export const COMPANION_WORKBENCH_AGENT_PROMPT: string | undefined = undefined
