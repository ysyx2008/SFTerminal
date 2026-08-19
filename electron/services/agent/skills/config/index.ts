/**
 * 旗鱼配置管理技能
 * 提供应用配置读写和 IM 渠道连接能力
 */

import { registerSkill } from '../registry'
import type { Skill } from '../types'
import { configTools } from './tools'
import { createLogger } from '../../../../utils/logger'

const log = createLogger('ConfigSkill')

const configSkill: Skill = {
  id: 'config',
  name: '旗鱼配置管理',
  description: '读取和修改旗鱼应用配置（界面语言、主题、终端设置、Agent 性格、IM/邮件账号连接凭证等），管理邮箱/日历账户（添加、删除、验证连接），测试 IM 连接，为旗鱼添加/更新/删除 AI 模型配置（config_ai_profile；列表能看见名称、模型名、地址、是否已填 Key，不回显 Key），以及添加/更新/删除 MCP 连接器（config_mcp_server_add/update/delete；保存启用后会自动连接，无需重启）。适用于用户要求调整设置、添加 AI 模型、配置邮箱/日历、检查集成状态、配置 IM 机器人、接入 MCP 工具服务等场景。不负责用户自定义技能的 API Key（加载 skill-manager 技能，用 skill_set_env 工具处理）。',
  tools: configTools,

  async init() {
    log.info('Initialized')
  },

  async cleanup() {
    log.info('Cleaned up')
  }
}

try {
  registerSkill(configSkill)
} catch (error) {
  log.error('Failed to register:', error)
}

export { configSkill }
export { executeConfigTool } from './executor'
