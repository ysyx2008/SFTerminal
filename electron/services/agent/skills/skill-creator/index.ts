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
  id: 'skill-manager',
  name: '技能管理与市场',
  description: '管理用户技能和技能市场。支持创建、更新、删除用户技能，以及搜索、预览、安装SailFish官方和ClawHub社区技能',
  tools: skillCreatorTools,

  content: [
    '## 安全规则（必须遵守）',
    '所有技能的安装、删除、更新**必须且只能**通过 `skill_*` 系列工具完成。',
    '安装工具（`skill_market_install` / `skill_install_local`）内置安全扫描和用户确认，无需额外步骤。',
    '',
    '**严禁使用 `run_command`、`execute_command` 或任何 shell 命令直接操作用户技能目录**',
    '',
    '**正确做法**：',
    '- 从市场安装 → `skill_market_install`（内置安全扫描）',
    '- 从本地 ZIP/目录安装 → `skill_install_local`（内置安全扫描）',
    '- 主动检视技能内容 → `skill_preview`',
    '- 创建新技能 → `skill_create`',
    '- 更新技能 → `skill_update`',
    '- 删除技能 → `skill_delete`',
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
