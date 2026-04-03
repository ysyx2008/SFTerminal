/**
 * Word 技能模块
 * 提供会话式 Word 文档创建和编辑能力
 */

import { registerSkill } from '../registry'
import type { Skill } from '../types'
import { wordTools } from './tools'
import { closeAllSessions } from './session'
import { createLogger } from '../../../../utils/logger'

const log = createLogger('WordSkill')

const wordSkill: Skill = {
  id: 'word',
  name: 'Word 文档处理',
  description: 'Word 文档创建和编辑，支持段落/标题/列表/表格/样式管理。',
  tools: wordTools,
  content: [
    '## Word 文档格式转换指引',
    '',
    '### 文档标题 vs 章节标题',
    'Word 中"文档标题"（Title 样式）和"一级标题"（Heading 1）是两种不同的样式。Markdown 没有文档标题的概念，因此用 YAML front matter 来指定：',
    '',
    '```',
    '---',
    'title: 关于加强安全生产工作的通知',
    '---',
    '',
    '正文内容...',
    '```',
    '',
    'front matter 中的 title 会渲染为 Word 的 Title 样式（公文格式中为小标宋体二号居中）。',
    'Markdown 的 # 仍然映射为 Heading 1，## 映射为 Heading 2，以此类推，不受影响。',
    '没有 front matter 时行为不变（向后兼容）。',
    '',
    '### 语义结构分析（重要）',
    '将内容转为正式文档（尤其是公文、报告）时，必须先通读全文，根据语义判断文档结构。切勿机械地按段落位置套用格式。',
    '',
    '**标题识别**：',
    '- 文档标题不一定是第一段。第一段可能是"附件1"、发文字号、密级等辅助信息',
    '- 真正的文档标题通常是概括全文主题的短句，应放在 front matter 的 title 中',
    '- 标题前后的辅助文字（如"附件1"、主送机关）用 <p> 或 <p align="center"> 处理',
    '',
    '**层级分配**：',
    '- front matter title = 文档标题（全文仅一个，Title 样式）',
    '- # = 大节标题 / Heading 1（适用于技术文档等章节标题）',
    '- ## = 小节标题 / Heading 2',
    '- 公文的大节标题（一、二、三、）通常由编号规则自动识别，不需要用 # 标记',
    '',
    '**公文常见结构**（标题可能不在第一段的情况）：',
    '- 附件类：附件编号 → 文档标题 → 正文',
    '- 带文号：发文字号 → 文档标题 → 主送机关 → 正文',
    '- 带密级：密级/紧急程度 → 文档标题 → 正文',
  ].join('\n'),
  
  async init() {
    // docx 库会在执行时动态 import，这里不需要预加载
    log.info('Initialized')
  },
  
  async cleanup() {
    // 关闭所有打开的 Word 文档
    await closeAllSessions()
    log.info('Cleaned up')
  }
}

// 注册技能
registerSkill(wordSkill)

export { wordSkill }

