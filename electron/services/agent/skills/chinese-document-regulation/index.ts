/**
 * 企业制度文件写作技能
 *
 * 提供"第X章 → 第X节 → 第X条 → （X）→ 1．" 四级编号体系的写作规范，
 * 以及 regulation 样式预设（含 multiLevelNumbering / numberingRules 自动编号配置）。
 * 引擎和工具仍在 word 技能中，本技能只贡献策略数据。
 *
 * 适用场景：写企业管理办法、规章制度、内控规程等正式制度文件时加载。
 */

import { registerSkill } from '../registry'
import type { Skill } from '../types'
import { registerStylePreset } from '../word/styles'
import { regulationPreset } from './presets'
import { createLogger } from '../../../../utils/logger'

const log = createLogger('ChineseDocumentRegulationSkill')

// 顶层注册样式预设
registerStylePreset('regulation', regulationPreset)

const chineseDocumentRegulationSkill: Skill = {
  id: 'chinese-document-regulation',
  name: '制度文件写作',
  description: '生成企业管理办法、规章制度、内控规程等制度文件时使用，提供"第X章/节/条/（X）/1．"四级编号体系的写作规范，并启用 regulation 样式预设（自动多级编号）。',
  tools: [],
  content: [
    '## 制度文件写作规范',
    '',
    '**适用范围**：企业管理办法、规章制度、内控规程、内部条例等正式制度文件。本技能加载后启用 `regulation` 样式预设。',
    '',
    '> 提示：写中文制度文件前请同时加载 `chinese-writing` 技能（GB/T 15834 标点 + GB/T 15835 数字），它是所有中文写作的基础规范。',
    '',
    '### 制度文件（regulation 样式）',
    '适用于企业管理办法、规章制度、内控规程等。使用"第X章→第X节→第X条→（X）"四级编号体系（参照立法技术规范）。',
    '',
    '### ⚠️ 写法铁律：章/节用 markdown 标题，**不要**写"第X章"纯文本',
    '',
    '章号、节号是**自动编号**——你只写主题词，"第一章/第二章/第一节"由样式自动加上。**严禁**自己写"第一章 总则"这种纯文本，理由：',
    '- 章/节用 `#` / `##` 直接对应 Heading1/Heading2，命中率 100%',
    '- 写纯文本"第X章"会走正则识别（`^第[一二三四五六七八九十百千万]+章`），稍微写歪（比如换成"第1章"、加粗、换行、用半角数字、写成"第一章 总则"两行）就漏匹配，整段掉成普通正文，全篇编号链路崩溃',
    '- 已经发生过的翻车：Agent 抄旧示例写"第一章　总则"，结果 Word 打开是一堆没编号的段落',
    '',
    '**条/款/项**保持纯文本"第X条" / "（X）" / "1." —— 它们是行内编号、不是独立标题段，由 `numberingRules` 识别（这个相对稳定，因为格式规整）。',
    '',
    '**Markdown 写法（请严格遵守）**：',
    '```',
    '---',
    'title: XX公司采购管理办法',
    '---',
    '',
    '# 总则',
    '',
    '第一条　为规范公司采购行为，加强采购管理，制定本办法。',
    '',
    '第二条　本办法适用于公司总部及各部门。',
    '',
    '# 组织架构与职责',
    '',
    '## 集中采购',
    '',
    '第三条　公司集中采购的范围包括：',
    '',
    '（一）办公设备及耗材；',
    '',
    '（二）信息技术服务；',
    '',
    '## 分散采购',
    '',
    '第四条　各部门可自行采购的范围：',
    '',
    '1．单笔金额不超过5万元的日常办公用品；',
    '',
    '# 附则',
    '',
    '第五条　本办法由综合管理部负责解释。',
    '',
    '第六条　本办法自发布之日起施行。',
    '```',
    '',
    '注意：`#` 后面**只写主题词**（"总则"、"组织架构与职责"、"附则"），**不要**写"第一章 总则"——前面那个"第一章"会由 Heading1 样式自动加上，你写了就重复了。`##` 同理。',
    '',
    '**自动编号（Word 原生多级列表）**：',
    '生成的 Word 使用原生多级自动编号，增删段落时序号自动调整：',
    '- `#` 主题词 → Heading 1（居中加粗）— Level 0，渲染为"第一章 主题词"',
    '- `##` 主题词 → Heading 2（居中加粗）— Level 1，每章重新编号，渲染为"第一节 主题词"',
    '- 第X条 纯文本 → Heading 3（缩进）— Level 2，跨章连续编号',
    '- （一）（二）纯文本 → Heading 4（缩进）— Level 3，每条重新编号',
    '- 1．2．纯文本 → 正文 — Level 4，每款重新编号',
    '',
    '**写法要求**：',
    '- 章/节**只写 `#` / `##` + 主题词**，编号由样式自动生成',
    '- 条/款/项写出编号文本（"第一条"、"（一）"、"1．"），转换时自动替换为 Word 原生编号',
    '- 在 Word 中手动新增段落时，从样式面板选择"标题 1~4"即可自动分配编号',
    '- 支持自动生成目录（章→节→条→款）',
  ].join('\n'),

  async init() {
    log.info('Initialized')
  },

  async cleanup() {
    log.info('Cleaned up')
  }
}

try {
  registerSkill(chineseDocumentRegulationSkill)
} catch (error) {
  log.error('Failed to register:', error)
}

export { chineseDocumentRegulationSkill }
