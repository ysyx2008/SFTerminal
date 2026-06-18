/**
 * 终端工作台工具定义模块
 *
 * 工具（execute_command 等）由 getAgentTools(mode='local'/'ssh') 直接注入，
 * 不再通过技能系统加载。本模块仅保留工具定义的导出供 tools.ts import 复用。
 *
 * 提示词内容（操作规范、SSH 指引）已迁移至：
 *   src/workbench/local/prompt.ts
 *   src/workbench/ssh/prompt.ts
 */

export { getAllTerminalTools } from './tools'
