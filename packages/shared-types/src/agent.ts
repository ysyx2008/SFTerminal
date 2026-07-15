/**
 * Agent 共享类型定义
 * 前后端通用，IPC 安全（不含不可序列化的字段如函数回调）
 */

/** 终端/执行环境类型：本地终端、SSH 远程终端、纯助手模式（无终端） */
export type TerminalType = 'local' | 'ssh' | 'assistant'

/**
 * 会话类别——对应 Agent 的存在方式（互斥）：
 * - task：直接接受指令干活，可并行、可隔离（普通 tab）
 * - companion：与用户的对话，一条长期关系线，多渠道汇流（联络 `__companion__`）
 * - watch：关切——用户配置的一次性任务，逐次失忆、独立历史树（`__watch__`）
 * - wakeup：唤醒/心跳——Agent 的内心独白与自主循环，需要历史记忆辅助决策（`__wakeup__`）
 * 详见 docs/conversation-refactor-design.md 与 project-architecture.mdc。
 */
export type ConversationKind = 'task' | 'companion' | 'watch' | 'wakeup'

/** 联络常驻 Agent key（一条长期关系线，全渠道汇流） */
export const COMPANION_AGENT_KEY = '__companion__'
/** 关切（Watch）常驻 Agent key（逐次独立任务，独立历史树） */
export const WATCH_AGENT_KEY = '__watch__'
/** 唤醒常驻 Agent key（心跳/内心独白，跨执行保留记忆辅助决策） */
export const WAKEUP_AGENT_KEY = '__wakeup__'

/**
 * 从 agentKey 推断会话类别。常驻命名 Agent 用固定 key，其余皆为普通任务。
 * 这是 kind 的唯一推断口径——历史记录缺 `kind` 字段时按此补默认（向后兼容）。
 */
export function inferConversationKind(agentKey?: string): ConversationKind {
  if (agentKey === COMPANION_AGENT_KEY) return 'companion'
  if (agentKey === WAKEUP_AGENT_KEY) return 'wakeup'
  if (agentKey === WATCH_AGENT_KEY) return 'watch'
  return 'task'
}

/** Agent 执行模式：strict=所有命令需确认，relaxed=仅危险命令需确认，free=全自动 */
export type ExecutionMode = 'strict' | 'relaxed' | 'free'

/** 远程访问渠道 */
export type RemoteChannel = 'desktop' | 'web' | 'dingtalk' | 'feishu' | 'slack' | 'telegram' | 'wecom' | 'wechat'

export type RiskLevel = 'safe' | 'moderate' | 'dangerous' | 'blocked'

/**
 * 命令风险策略（按 executionMode 分档 + 若干开关）
 *
 * Fail-Closed 兜底（parseFail / unknownCmd / indirection / dynamicPath）：
 * - 可选值限定 moderate / dangerous / blocked（safe 不允许）
 * - free 模式跟随 relaxed 配置
 *
 * 注意：Windows 原生 shell（PowerShell/CMD）走 legacyAssess，不套 Fail-Closed 档位。
 * blocked 是硬墙--任何 executionMode 下都会拒绝执行，慎用。
 */
export interface CommandRiskPolicy {
  /** strict 模式下解析失败的等级（默认 dangerous） */
  strictParseFail: RiskLevel
  /** strict 模式下未知命令的等级（默认 dangerous） */
  strictUnknownCmd: RiskLevel
  /** strict 模式下间接执行（node -e / python -c 等）的等级（默认 dangerous） */
  strictIndirection: RiskLevel
  /** strict 模式下动态路径无法静态审计时的等级（默认 dangerous） */
  strictDynamicPath: RiskLevel
  /** relaxed 模式下解析失败的等级（默认 moderate） */
  relaxedParseFail: RiskLevel
  /** relaxed 模式下未知命令的等级（默认 moderate） */
  relaxedUnknownCmd: RiskLevel
  /** relaxed 模式下间接执行的等级（默认 moderate） */
  relaxedIndirection: RiskLevel
  /** relaxed 模式下动态路径的等级（默认 moderate） */
  relaxedDynamicPath: RiskLevel
  /**
   * relaxed 模式下是否也对 moderate 弹确认（默认 false）。
   * true 时行为更接近「半严格」：safe 放行，moderate+ 确认。
   */
  relaxedConfirmModerate: boolean
  /**
   * 工作区外写操作是否升级确认（默认 false）。
   * true 时：safe 命令写到工作区外升为 moderate（需确认）。
   */
  outsideWritesUpgrade: boolean
  /**
   * 额外自由区目录（绝对路径），读写删免确认，语义同 scratch/charts。
   */
  extraFreeDirs: string[]
  /**
   * 子 Agent 是否自动阻止 dangerous（默认 true）。
   * false 时仅阻止 blocked；dangerous 仍可由主确认策略处理（子 Agent 本身无确认 UI，
   * 故 false 等于允许子 Agent 执行 dangerous——仅高信任场景开启）。
   */
  subAgentBlockDangerous: boolean
}

/** CommandRiskPolicy 各档位字段允许的取值（不含 safe） */
export const COMMAND_RISK_POLICY_ALLOWED_LEVELS: readonly RiskLevel[] = ['moderate', 'dangerous', 'blocked'] as const

/** CommandRiskPolicy 默认值 */
export const DEFAULT_COMMAND_RISK_POLICY: CommandRiskPolicy = {
  strictParseFail: 'dangerous',
  strictUnknownCmd: 'dangerous',
  strictIndirection: 'dangerous',
  strictDynamicPath: 'dangerous',
  relaxedParseFail: 'moderate',
  relaxedUnknownCmd: 'moderate',
  relaxedIndirection: 'moderate',
  relaxedDynamicPath: 'moderate',
  relaxedConfirmModerate: false,
  outsideWritesUpgrade: false,
  extraFreeDirs: [],
  subAgentBlockDangerous: true,
}

/** API 调用的 token 用量（由 LLM provider 返回的精确值） */
export interface TokenUsage {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  cache_hit_tokens?: number
  cache_miss_tokens?: number
}

export type PlanStepStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped'

export interface StepProgress {
  value: number
  current?: number
  total?: number
  eta?: string
  speed?: string
  isIndeterminate: boolean
  statusText?: string
}

export interface AgentPlanStep {
  id: string
  title: string
  description?: string
  status: PlanStepStatus
  result?: string
  startedAt?: number
  completedAt?: number
  progress?: StepProgress
  terminalId?: string
  terminalName?: string
  hostId?: string
  isParallel?: boolean
}

export interface AgentPlan {
  id: string
  title: string
  steps: AgentPlanStep[]
  paused?: boolean
  createdAt: number
  updatedAt: number
}

/** 用户消息附带的文件附件元信息（仅用于 UI 展示，不含文件内容） */
export interface AttachmentInfo {
  filename: string
  /** 文件完整路径（供 Agent 直接访问） */
  filePath?: string
  fileSize: number
  fileType: string
  /** PDF/文档总页数 */
  totalPages?: number
  /** 已渲染为预览图片的页数 */
  previewPages?: number
}

/** 子 Agent 类型（与 sub-agent.ts 中 SUB_AGENT_TYPES 注册表对应） */
export type SubAgentTypeName = 'read' | 'write'

/** 子 Agent 任务描述（dispatch_agents 工具参数） */
export interface SubAgentTask {
  id: string
  description: string
  prompt: string
  /** Agent 类型：read(只读分析/调研) / write(可修改文件)，默认 read */
  agentType?: SubAgentTypeName
}

/** 子 Agent 单步工具调用记录 */
export interface SubAgentToolStep {
  tool: string
  args?: string
  status: 'running' | 'completed' | 'failed'
  result?: string
}

/** Web 搜索结果条目（供 UI 展开渲染） */
export interface WebSearchResultItem {
  title: string
  url: string
  snippet?: string
  /** 提取的正文（部分 Provider 支持，展示时会截断） */
  content?: string
}

/** 子 Agent 执行结果（通过 AgentStep.subAgents 推送进度） */
export interface SubAgentResult {
  id: string
  description: string
  /** 主 Agent 下达的具体任务指令 */
  prompt?: string
  status: 'pending' | 'running' | 'completed' | 'failed'
  result?: string
  error?: string
  tokensUsed?: TokenUsage
  /** 子 Agent 工具调用步骤（实时更新，提供执行过程透明度） */
  steps?: SubAgentToolStep[]
}

/**
 * 「活图」载荷：让前端在对话气泡里实例化 ECharts，提供 tooltip / dataZoom / legend toggle
 * 等交互能力，并支持高 DPI 复制 / 任意倍率另存为。
 *
 * 与 `images` 是**并列两路**而不是替代关系：
 *   - chart skill 在 svg 模式下同时投递 `echartsOption`（活图）+ `images`（SVG 兜底）
 *   - 前端渲染优先级：`echartsOption` > `images`
 *   - `images` 兜底场景：旧历史记录、不支持 echarts 的视图（如 Awaken 关切面板）、
 *     钉钉/飞书 IM 渠道转发（IM 链路只用 `format='png'` 落盘的文件，不读这些 dataURL）
 *   - PNG 模式（AI 显式选 `format='png'`，意图是导出位图）下 chart skill 不投递 echartsOption——
 *     用户在气泡里看到的 PNG 与导出文件视觉一致更直观
 *
 * IPC 通过结构化克隆透传，注意 `option` 必须是纯 JSON 兼容对象（chart skill 的
 * `buildOption` 已经把所有主题颜色 inline 进去，无函数引用）。
 */
export interface EChartsStepPayload {
  /** 完整 ECharts option（v6+ 格式，已含 backgroundColor/color/textStyle 等主题） */
  option: Record<string, unknown>
  /** 后端建议的画布逻辑宽度（px），前端按容器实际宽度 resize，但保留宽高比 */
  width: number
  /** 后端建议的画布逻辑高度（px） */
  height: number
  /**
   * 渲染前需 registerMap 的内置地图 id（world / china / p{adcode}）。
   * GeoJSON 文件不进 IPC，前后端各自从 resources/chart-maps 加载。
   */
  registeredMaps?: string[]
}

export interface AgentStep {
  id: string
  type: 'thinking' | 'tool_call' | 'tool_result' | 'message' | 'error' | 'confirm' | 'streaming' | 'user_supplement' | 'waiting' | 'asking' | 'waiting_password' | 'waiting_input' | 'plan_created' | 'plan_updated' | 'plan_archived' | 'user_task' | 'final_result' | 'proactive_notice'
  content: string
  images?: string[]
  /**
   * 「活图」载荷。chart skill 在默认 svg 模式下注入；前端用 echarts 实例化得到
   * 可交互图表（tooltip / legend toggle / dataZoom 等）。同时 `images` 仍带 SVG
   * 兜底以兼容历史展示链路。详见 `EChartsStepPayload` 注释。
   */
  echartsOption?: EChartsStepPayload
  attachments?: AttachmentInfo[]
  toolName?: string
  /**
   * 关联的 tool_call ID。用于在同一批工具调用中精确配对 tool_call ↔ tool_result，
   * 避免按 toolName 配对时同名工具相互覆盖。
   * 仅 tool_call / tool_result 步骤需要；老历史数据可能缺失，此时退化为按 toolName 匹配。
   */
  toolCallId?: string
  toolArgs?: Record<string, unknown>
  toolResult?: string
  riskLevel?: RiskLevel
  timestamp: number
  isStreaming?: boolean
  plan?: AgentPlan
  progress?: StepProgress
  contextTokens?: number
  /**
   * 本次 API 调用实际使用的模型上下文窗口大小（tokens）。
   * 当发生视觉模型自动切换时，此值反映切换后模型的 contextLength，
   * 而非前端 activeAiProfile 的 contextLength。
   * 实时状态栏优先读 `AgentContextBar`；本字段仍写入 step 供历史落盘。
   */
  effectiveContextLength?: number
  /**
   * 本次 API 调用实际使用的模型 Profile 名称（用户自定义名）。
   * 当发生视觉模型自动切换时，此值为切换后的 profile.name。
   * 实时状态栏优先读 `AgentContextBar`；本字段仍写入 step 供历史落盘。
   */
  effectiveModel?: string
  /** 本次 API 调用的缓存命中率（0-100），由后端计算后推送 */
  cacheHitRate?: number
  /** Canvas 预览数据（仅 UI 消费，不发给 AI） */
  canvasData?: import('./canvas').CanvasData
  /** 并行子 Agent 状态（dispatch_agents 工具专用，实时更新） */
  subAgents?: SubAgentResult[]
  /** Web 搜索结果（web_search 工具专用，供 UI 可展开渲染） */
  webSearchResults?: WebSearchResultItem[]
  /**
   * 工具执行是否成功。仅 tool_call 步骤使用：
   *   undefined → 还在运行（或没有执行结果）
   *   true      → 成功
   *   false     → 失败（包括用户拒绝、超时、工具异常）
   * 用于 UI 侧将"左侧风险色竖条"切换为"执行结果色竖条"，避免把风险红色误解为执行失败。
   */
  success?: boolean
  /**
   * 此步骤是否对应"被用户拒绝执行"。仅由工具层在拒绝场景显式标记。
   * UI 用此字段（而不是 content 关键词）渲染"灰色 + 半透明"的拒绝样式，
   * 避免正文里出现"拒绝"二字的 message step 被误判为拒绝步骤而整体变灰。
   */
  rejected?: boolean
  /**
   * 临时 UI 占位标记。`startup` = run 开头「正在准备…/等待首 token」步骤，
   * 首条 message 或 tool_call 产出后由后端 removeStep，不应落盘或留在历史。
   */
  placeholder?: 'startup'
}

/** Agent 启动阶段的临时占位步骤（等待首 token 前，不应落盘） */
export function isStartupPlaceholderStep(
  step: Pick<AgentStep, 'type' | 'isStreaming' | 'placeholder'>,
): boolean {
  if (step.placeholder === 'startup') return true
  return step.type === 'thinking' && step.isStreaming === true
}

/** 持久化时剔除 startup 占位 */
export function filterPersistableSteps<T extends AgentStep>(steps: T[]): T[] {
  return steps.filter(s => !isStartupPlaceholderStep(s))
}

/**
 * 会话级「上下文栏」快照（token / cache / 拟用或已确认模型）。
 * 与 step 解耦：删占位、重试、流式接替不会把状态栏打空或回退主模型。
 * 确认值以 API usage 为准；请求中途可暂挂上轮确认 token + 本轮拟用 model/limit。
 */
export interface AgentContextBar {
  contextTokens?: number
  cacheHitRate?: number
  effectiveContextLength?: number
  effectiveModel?: string
  /** 拟用 / 已确认的 AI profileId（换模型时用于清 Cache%） */
  profileId?: string
}

/** 从步骤流倒查最近一次带 contextTokens 的统计（历史加载 / 无 live 推送时回退） */
export function deriveContextBarFromSteps(
  steps: ReadonlyArray<Pick<AgentStep, 'contextTokens' | 'cacheHitRate' | 'effectiveContextLength' | 'effectiveModel'>>,
): AgentContextBar | undefined {
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i]
    if (step.contextTokens === undefined) continue
    const bar: AgentContextBar = { contextTokens: step.contextTokens }
    if (step.cacheHitRate !== undefined) bar.cacheHitRate = step.cacheHitRate
    if (step.effectiveContextLength !== undefined) bar.effectiveContextLength = step.effectiveContextLength
    if (step.effectiveModel !== undefined) bar.effectiveModel = step.effectiveModel
    return bar
  }
  return undefined
}

/**
 * 安全输入请求（IPC 安全版本，不含 resolve 回调）。
 *
 * Agent 通过 requestSecureInput 触发前端弹出安全输入框。用户输入的值
 * 经 IPC 直接写入加密存储，**不经过 LLM 上下文**，Agent 只收到"已设置/已取消"。
 */
export interface PendingSecureInput {
  agentId: string
  requestId: string
  /** 提示用户输入什么（如 "请输入 STOCK_API_KEY"） */
  prompt: string
  /** 技能 ID，用于存储时构建 credential key */
  skillId: string
  /** env 变量名（如 "STOCK_API_KEY"） */
  envName: string
  /** 可选：是否是更新（已配置过，本次覆盖） */
  isUpdate?: boolean
}

/**
 * 待确认的工具调用（IPC 安全版本，不含 resolve 回调）
 * 后端通过 PendingConfirmationInternal 扩展 resolve 字段
 */
export interface PendingConfirmation {
  agentId: string
  toolCallId: string
  toolName: string
  toolArgs: Record<string, unknown>
  riskLevel: RiskLevel
  /**
   * 可选的人类可读动作名（如 "覆盖生成 Word 文档"）。
   *
   * 用途：当同一个工具在不同场景下需要不同确认文案时（例如 word_from_markdown
   * 的"新建" vs "覆盖"），由具体工具在调用 waitForConfirmation 时按场景传入。
   * 前端有 displayName 时优先显示，否则回退到工具名映射表。
   */
  displayName?: string
  /**
   * 触发该风险等级的具体原因（人类可读，已按 locale 国际化）。
   *
   * 只包含「等级等于最终 riskLevel」的那些子命令的原因（去重后），
   * 让用户在确认卡片上看到"为什么是高风险"，而不必展示所有子命令的噪声。
   * 仅 exec 等命令类工具有值；其他工具（如文件写入）不传。
   */
  reasons?: string[]
  /**
   * 可将未知命令名加入用户命令规则库的要约（仅命令类确认）。
   * 出现时前端展示「加入规则并允许」；默认 moderate，不可覆盖内置。
   */
  trustCommandOffer?: {
    cmd: string
    writesTo: boolean
    baseLevel: 'moderate'
  }
}
