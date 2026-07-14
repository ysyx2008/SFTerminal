/**
 * 本地秘书待办技能
 * 结构化 TODO.json，供心跳提醒与关切截止检查使用。
 */
import { registerSkill } from '../registry'
import type { Skill } from '../types'
import { todoTools, todoSkillContent } from './tools'
import { createLogger } from '../../../../utils/logger'

const log = createLogger('TodoSkill')

const todoSkill: Skill = {
  id: 'todo',
  name: '本地待办',
  description:
    '管理用户本地秘书待办（工作空间 TODO.json）：创建、更新、完成、删除与列表筛选。用于提醒用户做事；跨会话持久化。日历 CalDAV VTODO 请用 calendar 技能的 calendar_todo_*；需要 Agent 自己定期执行请用关切（watch）。',
  tools: todoTools,
  content: todoSkillContent,

  async init() {
    log.info('Initialized')
  },

  async cleanup() {
    log.info('Cleaned up')
  },
}

try {
  registerSkill(todoSkill)
} catch (error) {
  log.error('Failed to register:', error)
}

export { todoSkill }
export { executeTodoTool } from './executor'
