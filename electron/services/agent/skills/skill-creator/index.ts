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
    '## 技能凭证管理（市场技能 & 自定义技能通用）',
    '**任何技能**（含用户自己创建的自定义技能）需要 API Key、密码、Token 等凭证时，',
    '都应使用 `skill_set_env` 加密存储，**不得在脚本里硬编码、不得让用户手动 export 环境变量**。',
    '',
    '操作速查：',
    '- 查看哪些 key 已配置 → `skill_list_env(skill_id)`',
    '- 配置 key（用户已告知值）→ `skill_set_env(skill_id, env_name, value)`',
    '- 配置 key（敏感凭证，弹安全输入框）→ `skill_set_env(skill_id, env_name)`（不传 value，前端弹密码框，凭证不经过对话）',
    '- 删除 key（泄露需轮换）→ `skill_delete_env(skill_id, env_name)`',
    '- 执行技能脚本时自动注入 key → `exec(command, skill_id=xxx)`',
    '',
    '**自定义技能开发规范**：',
    '- 技能脚本需要凭证时，从环境变量读取（如 `os.environ["SF_API_KEY"]`），**不要在脚本里硬编码**',
    '- 技能安装/设置完成后，立即用 `skill_set_env` 把凭证存好，再用 `skill_list_env` 确认配置齐全',
    '- 判断凭证敏感度：Partner ID / API URL 等非私密信息可以直接传 value；密码/Token/check word 等',
    '  敏感凭证应省略 value，让前端弹安全输入框，确保不经过 AI 对话',
    '',
    '**重要**：执行需要凭证的技能脚本时，必须用 `exec(..., skill_id="xxx")` 而非 `execute_command`，',
    '这样凭证才能自动注入到子进程环境变量，而不需要用户手动操作。',
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
