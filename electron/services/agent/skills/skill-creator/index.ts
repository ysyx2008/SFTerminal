/**
 * 用户技能创建技能模块
 * 提供创建、管理用户技能的能力
 */

import { registerSkill } from '../registry'
import type { Skill } from '../types'
import { skillCreatorTools } from './tools'
import { createLogger } from '../../../../utils/logger'

const log = createLogger('SkillCreator')

const skillCreatorSkill: Skill = {
  id: 'skill-creator',
  name: '技能管理与市场',
  description: '管理用户技能和技能市场。支持创建、更新、删除用户技能，以及搜索、预览、安装SailFish官方和ClawHub社区技能',
  tools: skillCreatorTools,

  content: [
    '## 安全规则（必须遵守）',
    '所有技能的安装、删除、更新**必须且只能**通过 `skill_*` 系列工具完成，该工具会对技能进行安全扫描以及用户确认。',
    '',
    '**严禁使用 `run_command`、`execute_command` 或任何 shell 命令直接操作用户技能目录，或以任何方式绕过安全扫描和用户确认流程**',
    '',
    '**正确做法**：',
    '- 安装前审查 → `skill_preview`（支持市场和本地来源）',
    '- 从市场安装 → `skill_market_install`',
    '- 从本地 ZIP/目录安装 → `skill_install_local`',
    '- 创建新技能 → `skill_create`',
    '- 更新技能 → `skill_update`',
    '- 删除技能 → `skill_delete`',
    '',
    '这些工具内置了路径安全检查、内容安全扫描和用户确认流程，直接操作文件系统会绕过所有安全机制。',
  ].join('\n'),

  async init() {
    log.info('Initialized')
  },
  
  async cleanup() {
    log.info('Cleaned up')
  }
}

// 注册技能
try {
  registerSkill(skillCreatorSkill)
} catch (error) {
  log.error('Failed to register:', error)
}

export { skillCreatorSkill }
export { executeSkillCreatorTool } from './executor'
