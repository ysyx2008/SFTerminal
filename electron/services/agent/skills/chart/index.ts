/**
 * 图表生成技能
 * 提供数据可视化能力（柱/折/饼/散点/雷达/热力/K线），返回 SVG 矢量图
 */

import { registerSkill } from '../registry'
import type { Skill } from '../types'
import { chartTools, chartSkillContent } from './tools'
import { loadEcharts } from './ssr'
import { createLogger } from '../../../../utils/logger'

const log = createLogger('ChartSkill')

const chartSkill: Skill = {
  id: 'chart',
  name: '图表生成',
  description: '生成柱状/折线/饼/散点/雷达/热力/K线/地图等 9 种数据可视化图表，输出 SVG。K 线支持中式（红涨绿跌）和美式（绿涨红跌）。地图内置世界/中国省/各市 GeoJSON。适合金融分析、数据汇报、概念示意。',
  tools: chartTools,
  content: chartSkillContent,

  async init() {
    // 预加载 echarts，避免首次调用工具时阻塞
    try {
      await loadEcharts()
      log.info('Initialized (echarts preloaded)')
    } catch (err) {
      log.warn('Failed to preload echarts, will retry on first use:', err)
    }
  },

  async cleanup() {
    log.info('Cleaned up')
  }
}

try {
  registerSkill(chartSkill)
} catch (error) {
  log.error('Failed to register:', error)
}

export { chartSkill }
export { executeChartTool } from './executor'
