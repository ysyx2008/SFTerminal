/**
 * Agent 共享类型定义
 * 前后端通用，IPC 安全（不含不可序列化的字段如函数回调）
 */

/** 终端/执行环境类型：本地终端、SSH 远程终端、纯助手模式（无终端） */
export type TerminalType = 'local' | 'ssh' | 'assistant'

/** Agent 执行模式：strict=所有命令需确认，relaxed=仅危险命令需确认，free=全自动 */
export type ExecutionMode = 'strict' | 'relaxed' | 'free'

/** 远程访问渠道 */
export type RemoteChannel = 'desktop' | 'web' | 'dingtalk' | 'feishu' | 'slack' | 'telegram' | 'wecom' | 'wechat'

export type RiskLevel = 'safe' | 'moderate' | 'dangerous' | 'blocked'

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
  type: 'thinking' | 'tool_call' | 'tool_result' | 'message' | 'error' | 'confirm' | 'streaming' | 'user_supplement' | 'waiting' | 'asking' | 'waiting_password' | 'waiting_input' | 'plan_created' | 'plan_updated' | 'plan_archived' | 'user_task' | 'final_result'
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
   */
  effectiveContextLength?: number
  /**
   * 本次 API 调用实际使用的模型 Profile 名称（用户自定义名）。
   * 当发生视觉模型自动切换时，此值为切换后的 profile.name。
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
}
