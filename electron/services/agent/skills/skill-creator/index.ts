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
    '',
    '## 技能 API Key 管理',
    '部分技能需要第三方 API Key（如股票数据、天气、翻译等）：',
    '- 查看哪些 key 已配置 → `skill_list_env(skill_id)`',
    '- 配置 key（用户告知了值）→ `skill_set_env(skill_id, env_name, value)`',
    '- 配置 key（用户未告知，弹安全输入框）→ `skill_set_env(skill_id, env_name)`（不传 value）',
    '- 删除 key（如泄露需轮换）→ `skill_delete_env(skill_id, env_name)`',
    '- 执行技能脚本时注入 key → `exec(command, skill_id=xxx)`（自动注入，不暴露明文）',
    '',
    '**重要**：执行需要 API Key 的技能脚本时，必须用 `exec(..., skill_id="xxx")` 而非 `execute_command`，',
    '这样 key 才能自动注入到子进程，而不需要用户手动设置环境变量。',
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
