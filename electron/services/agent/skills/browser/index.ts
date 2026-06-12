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
  description: '浏览器自动化。浏览器助手已连接时优先 attach（复用登录态）；launch 为 Playwright 独立窗口。双开时用 browser_launch 的 browser 指定 firefox/chromium。attach：不支持 screenshot；evaluate 仅属性链子集；wait 仅 delay。',
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

