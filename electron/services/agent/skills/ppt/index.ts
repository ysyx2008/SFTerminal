/**
 * PPT 技能：约束版 Slide HTML → .pptx + Canvas 预览
 */

import { registerSkill } from '../registry'
import type { Skill } from '../types'
import { pptTools } from './tools'
import { createLogger } from '../../../../utils/logger'

const log = createLogger('PptSkill')

const pptSkillContent = [
  '## Slide HTML 契约（ppt_from_html）',
  '',
  '完整规则见模块内 `contracts/slide-html.md`。要点：',
  '',
    '- 每页：`<section class="slide" data-layout="..." data-theme="midnight" style="width:1600px;height:900px">`',
    '- **data-layout**：title | content | two-column | stat-callout | image-bleed | closing',
    '- **data-theme**：建议全书统一（如 midnight）；content 页用浅色底时会自动套主题浅色背景',
    '- 助手模式导出后 **Canvas iframe 可滚动预览全部页面**（右上角页码）',
  '- 图片：**绝对路径**；`load_skill("chart")` 后 `generate_chart` 用 `format:"png"` 再 `<img src="...">`',
  '',
  '## 设计（避免 AI 幻灯片审美）',
  '',
  '- 每页至少一个视觉元素（图、表、大数字），不要纯白 bullet 墙',
  '- 标题 36pt+、正文 14–16pt；正文左对齐',
  '- **不要在标题下加装饰线**',
  '- 深色背景用于 title/closing，浅色用于 content（三明治结构）',
  '',
  '## 推荐流程',
  '',
  '1. 完成调研或 `word_from_markdown` 报告',
  '2. 按页写 HTML（先 Canvas 预览语义，再导出）',
  '3. `ppt_from_html({ path: "汇报.pptx", html: "..." })`',
  '4. 同目录生成 `汇报.html`，助手右侧 Canvas 可翻页预览',
].join('\n')

const pptSkill: Skill = {
  id: 'ppt',
  name: '幻灯片 / PPT',
  description:
    '从约束版 Slide HTML 生成 .pptx 演示文稿，支持多版式与主题，助手模式 Canvas HTML 预览。',
  tools: pptTools,
  content: pptSkillContent,

  async init() {
    log.info('Initialized')
  },

  async cleanup() {
    log.info('Cleaned up')
  },
}

try {
  registerSkill(pptSkill)
} catch (error) {
  log.error('Failed to register:', error)
}

export { pptSkill }
export { executePptTool } from './executor'
