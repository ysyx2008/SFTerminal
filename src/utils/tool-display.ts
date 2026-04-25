/**
 * tool_result 步骤的"是否在 UI 中显示"策略。
 *
 * 设计原则（与 SPEC「工具执行透明原则」对齐）：
 * - 后端永远 emit `tool_result` 并写入会话历史（不受 debugMode 影响，保证持久化完整）
 * - debugMode 只影响**前端是否渲染**这条 tool_result 步骤
 * - 关闭调试模式时，对于"成功且没有用户必看产出"的工具结果，整条 step 不渲染——
 *   让用户聚焦在"做了什么 + 异常 + 重要产出"上，避免被工具内部细节淹没
 *
 * 分类：
 * - ALWAYS_SHOW_RESULT_TOOLS: 写入/记忆/发送等"动作型"工具——无论模式如何都展示结果
 * - HIDE_RESULT_WHEN_SUCCESS_TOOLS: 信息检索 / 命令输出 / 终端查询——成功时在非调试模式下隐藏
 *
 * 失败的 tool_result（step.success === false）始终展示，让用户立刻看到错误。
 * 携带 images / webSearchResults / subAgents 等专用富内容字段的 step 也始终展示
 * （这些字段本身就是用户期望看到的产出）。
 *
 * 维护说明：新增工具时按用户视角填进对应集合；未登记的工具默认展示（保守策略），
 * 避免新工具因为没登记而意外被隐藏。
 */

/** A 类：用户必看的"动作型"工具结果——任何模式下都展示 */
export const ALWAYS_SHOW_RESULT_TOOLS = new Set<string>([
  // 写入/修改类
  'edit_file',
  'write_text_file',
  'write_remote_text_file',
  // 子 Agent / 计划 / 用户互动（多数有专用 step type，这里列出是为完备）
  'dispatch_agents',
  // 记忆类（用户应该看到记了什么）
  'remember_info',
  // 主动消息
  'send_file_to_chat',
  'send_image_to_chat',
])

/** B + C 类：信息检索 / 命令输出——成功时在非调试模式下不展示 */
export const HIDE_RESULT_WHEN_SUCCESS_TOOLS = new Set<string>([
  // B. 信息检索 / 终端查询类
  'read_file',
  'file_search',
  'search_knowledge',
  'get_knowledge_doc',
  'recall_task',
  'deep_recall',
  'search_history',
  'web_search',
  'load_skill',
  'unload_skill',
  'load_user_skill',
  'get_terminal_context',
  'check_terminal_status',
  'recall_compressed',
  'compress_context',
  'manage_memory',
  // C. 命令/输入类
  'execute_command',
  'exec',
  'send_input',
  'send_control_key',
])

/**
 * tool_result step 是否携带了富内容字段——这些字段本身就是用户期望看到的产出，
 * 整条 step 不能因为 debugMode 关闭而被隐藏。
 */
function hasRichPayload(step: {
  images?: unknown[]
  webSearchResults?: unknown[]
  subAgents?: unknown[]
}): boolean {
  if (step.images && step.images.length > 0) return true
  if (step.webSearchResults && step.webSearchResults.length > 0) return true
  if (step.subAgents && step.subAgents.length > 0) return true
  return false
}

/**
 * 判断 tool_result 步骤是否需要在 UI 中渲染。
 *
 * 仅适用于 step.type === 'tool_result' 的步骤；其它 step 类型应当无条件展示。
 *
 * @param step tool_result 步骤
 * @param debugMode 当前 UI 的调试模式开关
 */
export function shouldShowToolResultStep(
  step: {
    type: string
    toolName?: string
    success?: boolean
    images?: unknown[]
    webSearchResults?: unknown[]
    subAgents?: unknown[]
  },
  debugMode: boolean
): boolean {
  // 仅对 tool_result 应用过滤；其它 step 类型由调用方自行决定（默认展示）
  if (step.type !== 'tool_result') return true
  // 失败步骤始终展示
  if (step.success === false) return true
  // 调试模式：所有 tool_result 都展示
  if (debugMode) return true
  // 携带富内容字段的 step 始终展示（图片视觉、搜索结果、子 Agent 卡片）
  if (hasRichPayload(step)) return true
  // 未登记的工具保守展示
  if (!step.toolName) return true
  if (ALWAYS_SHOW_RESULT_TOOLS.has(step.toolName)) return true
  if (HIDE_RESULT_WHEN_SUCCESS_TOOLS.has(step.toolName)) return false
  return true
}
