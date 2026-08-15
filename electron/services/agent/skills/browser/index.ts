/**
 * 浏览器技能模块
 * 提供浏览器自动化能力
 */

import { registerSkill } from '../registry'
import type { Skill } from '../types'
import { browserTools } from './tools'
import { closeAllSessions } from './session'
import { closeAllBridgeSessions } from './bridge-session'
import { createLogger } from '../../../../utils/logger'

const log = createLogger('BrowserSkill')

const browserSkill: Skill = {
  id: 'browser',
  name: '浏览器自动化',
  description: '浏览器自动化。两档：①吸附用户浏览器（复用登录态；脚本/截图/按元素等待受限）②独立窗口（完整 JS/截图/按元素等待）。读文章 browser_read_article；读整页/区域 browser_read_page；交互 browser_snapshot。',
  tools: browserTools,
  
  async init() {
    // playwright-core 会在执行时动态 import，这里不需要预加载
    log.info('Initialized')
  },
  
  async cleanup() {
    await closeAllSessions()
    closeAllBridgeSessions()
    log.info('Cleaned up')
  }
}

// 注册技能
registerSkill(browserSkill)

export { browserSkill }

