/**
 * 样例工作台声明的假 MCP / skills。
 *
 * - skills：声明依赖核心仓已有 skill id（bootstrap 只日志，不二次注册）
 * - mcp：默认 enabled=false，避免启动时真连失败刷屏；单测会测 enabled 路径
 */
import type { McpServerConfig } from '@sailfish/shared-types'

export const SAMPLE_WORKBENCH_SKILLS = ['excel'] as const

/** 假 MCP：占位配置；OEM 换成真实 command/url 后把 enabled 设为 true */
export const SAMPLE_FAKE_MCP: McpServerConfig = {
  id: 'sample-fake-mcp',
  name: 'Sample Fake MCP',
  enabled: false,
  transport: 'stdio',
  command: 'echo',
  args: ['sample-fake-mcp-placeholder'],
}
