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
  content: `## Word 文档格式转换指引

### 语义结构分析
将内容转为正式文档（尤其是公文、报告）时，必须先通读全文，根据语义判断文档结构，再分配 Markdown 标题层级。切勿机械地按段落位置套用格式。

**标题识别**：
- 文档标题不一定是第一段。第一段可能是"附件1"、"附件："、发文字号、密级、紧急程度、"议案一"等辅助信息
- 真正的标题通常是概括全文主题的短句（如"关于加强安全生产工作的通知"），只有它才应标记为 # 一级标题
- 标题前的辅助文字应作为普通段落或用 <p align="center"> / <p> 处理，不要标记为标题

**层级分配**：
- 一级标题(#) = 文档标题（全文仅一个）
- 二级标题(##) = 大节标题（如"一、总体要求"）
- 三级标题(###) = 小节标题
- 根据内容语义和层次逻辑分配级别，不要把所有加粗文字都当标题

**公文常见结构**（标题可能不在第一段的情况）：
- 附件类：附件编号 → 标题 → 正文
- 带文号：发文字号 → 标题 → 主送机关 → 正文
- 带密级：密级/紧急程度 → 标题 → 正文`,
  
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

