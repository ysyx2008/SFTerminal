/**
 * 独立助手欢迎区使用示例（单一数据源）
 *
 * 解决"用户不知道软件能干啥"的核心痛点：把欢迎区从干瘪的纯文本列表，
 * 升级为带图标的可交互能力卡片网格。
 *
 * 数据职责：
 *   - 这里只定义结构化元数据（id / icon / category）
 *   - 文案（title / subtitle / prompt）通过 i18n key 取，多语言由 zh-CN.ts / en-US.ts 提供
 *
 * 当前消费方：
 *   - src/components/AiPanel.vue（独立助手欢迎区的场景网格）
 */

export type AssistantExampleCategory =
  | 'writing'    // 文档与写作
  | 'data'       // 数据与表格
  | 'file'       // 文件与查找
  | 'web'        // 网络与搜索
  | 'office'     // 办公协同
  | 'automation' // 自动化与关切
  | 'system'     // 系统与开发
  | 'memory'     // 智能对话

export interface AssistantExample {
  /** 与 i18n key 对应：t(`ai.agentWelcome.scenarios.${id}.title`) 等 */
  id: string
  /** emoji 图标 */
  icon: string
  /** 类别（用于色彩 tag 和洗牌时的"跨类约束"） */
  category: AssistantExampleCategory
}

/**
 * 完整 prompt 池（25 条 / 8 大类）
 * 顺序：与 plan 中按类别分组的顺序一致，便于维护
 */
export const ASSISTANT_EXAMPLES: AssistantExample[] = [
  // 文档与写作（5）
  { id: 'workSummary',    icon: '📝', category: 'writing' },
  { id: 'officialDoc',    icon: '🇨🇳', category: 'writing' },
  { id: 'regulationDoc',  icon: '📜', category: 'writing' },
  { id: 'polishWriting',  icon: '✍️', category: 'writing' },
  { id: 'translateSnippet', icon: '🌏', category: 'writing' },

  // 数据与表格（4）
  { id: 'excelSummary',   icon: '📊', category: 'data' },
  { id: 'dataAnalysis',   icon: '🧮', category: 'data' },
  { id: 'dataChart',      icon: '📈', category: 'data' },
  { id: 'kLineChart',     icon: '📉', category: 'data' },

  // 文件与查找（3）
  { id: 'findDuplicates', icon: '🧹', category: 'file' },
  { id: 'fileSearch',     icon: '🔎', category: 'file' },
  { id: 'desktopOrganize',icon: '📂', category: 'file' },

  // 网络与搜索（3）
  { id: 'webResearch',    icon: '🔍', category: 'web' },
  { id: 'webFetch',       icon: '🌐', category: 'web' },
  { id: 'parallelResearch', icon: '🧠', category: 'web' },

  // 办公协同（4）
  { id: 'emailReview',    icon: '📧', category: 'office' },
  { id: 'calendarCheck',  icon: '📅', category: 'office' },
  { id: 'feishuDoc',      icon: '🪶', category: 'office' },
  { id: 'browserAuto',    icon: '🖱️', category: 'office' },
  { id: 'deckFromReport', icon: '📽️', category: 'office' },

  // 自动化与关切（3）
  { id: 'watchEmail',     icon: '⏰', category: 'automation' },
  { id: 'watchFolder',    icon: '👁️', category: 'automation' },
  { id: 'watchWebpage',   icon: '🔔', category: 'automation' },

  // 系统与开发（3）
  { id: 'systemCheck',    icon: '💻', category: 'system' },
  { id: 'gitHistory',     icon: '🌿', category: 'system' },
  { id: 'portCheck',      icon: '🔌', category: 'system' },

  // 智能对话（2）
  { id: 'recallHistory',  icon: '💭', category: 'memory' },
  { id: 'knowledgeQa',    icon: '📚', category: 'memory' },
]

/**
 * 首屏精选 8 条
 *
 * 选取原则：
 *   1. 覆盖最广的代表性组合，让用户首次打开欢迎区一眼看到 8 个互不重叠的能力领域
 *   2. 优先放"视觉冲击力强 + 不需要用户提供材料就能跑"的能力（K 线图、图表、公文）
 *   3. fileSearch 这种"低视觉冲击力"的能力放在洗牌池里轮换出现，首屏让位给更有"哇"感的演示
 *
 * 涵盖：Word 周报 / 中文公文（独家） / 图表 / K 线图（视觉冲击）/ 网搜 / 邮件 / 系统操作 / 自动化关切
 */
export const FEATURED_IDS: readonly string[] = [
  'workSummary',
  'officialDoc',
  'dataChart',
  'kLineChart',
  'webResearch',
  'emailReview',
  'systemCheck',
  'watchEmail',
] as const

/**
 * 显示张数（首屏 + 每次"换一批"）
 */
export const DISPLAY_COUNT = 8

/**
 * 至少跨多少大类（避免洗出来 8 张全是同一类）
 */
const MIN_CATEGORIES = 4

/**
 * 取首屏精选示例（按 FEATURED_IDS 顺序）。
 * 返回找到的 example 对象数组；ID 找不到的会被过滤（防止 i18n key 同步失败时崩溃）。
 */
export function getFeaturedExamples(): AssistantExample[] {
  const map = new Map(ASSISTANT_EXAMPLES.map(e => [e.id, e]))
  return FEATURED_IDS
    .map(id => map.get(id))
    .filter((e): e is AssistantExample => !!e)
}

/**
 * 从 prompt 池里随机抽 8 条（"换一批"按钮调用）。
 *
 * 约束：
 *   1. 不与 `excludeIds` 重复（避免点"换一批"出现一模一样的内容）
 *   2. 至少跨 MIN_CATEGORIES 大类（避免同质化，比如全是"写作"类）
 *
 * 实现策略：Fisher-Yates 洗牌后取前 8；如果跨类不足，再做一次最多 5 次的微调。
 * 5 次仍达不到约束就放弃约束（25 条池子里跨类不足的概率极低，兜底）。
 */
export function shuffleExamples(excludeIds: readonly string[] = []): AssistantExample[] {
  const excluded = new Set(excludeIds)
  const candidates = ASSISTANT_EXAMPLES.filter(e => !excluded.has(e.id))
  // 边界：池子被 excludeIds 排除得太狠，回退到全池
  const pool = candidates.length >= DISPLAY_COUNT ? candidates : ASSISTANT_EXAMPLES.slice()

  for (let attempt = 0; attempt < 5; attempt++) {
    const shuffled = fisherYatesShuffle(pool.slice())
    const picked = shuffled.slice(0, DISPLAY_COUNT)
    const cats = new Set(picked.map(e => e.category))
    if (cats.size >= MIN_CATEGORIES) {
      return picked
    }
  }

  // 兜底：直接返回最后一次洗牌结果
  return fisherYatesShuffle(pool.slice()).slice(0, DISPLAY_COUNT)
}

function fisherYatesShuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr
}
