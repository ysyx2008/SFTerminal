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
    '',
    '### 制度文件（regulation 样式）',
    '适用于企业管理办法、规章制度、内控规程等。使用"第X章→第X节→第X条→（X）"四级编号体系（参照立法技术规范）。',
    '',
    '**Markdown 写法示例**：',
    '```',
    '---',
    'title: XX公司采购管理办法',
    '---',
    '',
    '第一章　总则',
    '',
    '第一条　为规范公司采购行为，加强采购管理，制定本办法。',
    '',
    '第二条　本办法适用于公司总部及各部门。',
    '',
    '第二章　组织架构与职责',
    '',
    '第一节　集中采购',
    '',
    '第三条　公司集中采购的范围包括：',
    '',
    '（一）办公设备及耗材；',
    '',
    '（二）信息技术服务；',
    '',
    '第二节　分散采购',
    '',
    '第四条　各部门可自行采购的范围：',
    '',
    '1．单笔金额不超过5万元的日常办公用品；',
    '',
    '第三章　附则',
    '',
    '第五条　本办法由综合管理部负责解释。',
    '',
    '第六条　本办法自发布之日起施行。',
    '```',
    '',
    '**自动编号（Word 原生多级列表）**：',
    '生成的 Word 使用原生多级自动编号，增删段落时序号自动调整：',
    '- 第X章 → Heading 1（居中加粗）— Level 0',
    '- 第X节 → Heading 2（居中加粗）— Level 1，每章重新编号',
    '- 第X条 → Heading 3（缩进）— Level 2，跨章连续编号',
    '- （一）（二）→ Heading 4（缩进）— Level 3，每条重新编号',
    '- 1．2．→ 正文 — Level 4，每款重新编号',
    '',
    '**写法要求**：',
    '- Markdown 中仍需写出编号文本（如"第一章　总则"），转换时会自动替换为 Word 原生编号',
    '- 编号行直接写为普通段落，不要用 # 标记',
    '- 在 Word 中手动增加新段落时，直接从样式面板选择"标题 1~4"即可自动分配编号',
    '- 支持自动生成目录（章→节→条→款）',
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

