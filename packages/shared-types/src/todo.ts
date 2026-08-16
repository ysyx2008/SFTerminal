/**
 * 本地秘书待办（todo 技能）共享类型
 * 存储：`{userData}/agent-workspace/TODO.json`
 */

export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled'

export type TodoPriority = 'low' | 'normal' | 'high' | 'urgent'

/** 事项日志：这件事上发生过什么，只追加 */
export type TodoJournalKind = 'scheduled' | 'progress'

export interface TodoJournalEntry {
  id: string
  kind: TodoJournalKind
  /** 记录写入时间，ISO 8601 */
  at: string
  /** scheduled：安排的时段 */
  start?: string
  end?: string
  /** scheduled：日历事件出处，便于日后对账 */
  calendarId?: string
  eventId?: string
  /** progress：进展说明 */
  note?: string
  /** 产生该记录的会话 */
  sessionId?: string
}

/** 出处：这条待办从哪来、相关材料在哪，只指路不复制 */
export type TodoSourceKind = 'conversation' | 'email' | 'file' | 'url'

export interface TodoSource {
  id: string
  kind: TodoSourceKind
  /** 写入时间，ISO 8601 */
  at: string
  /** 一句人话说明（Agent 显式带出处时填；conversation 类可空，展示时用会话标题兜底） */
  label?: string
  /** conversation */
  sessionId?: string
  agentKey?: string
  /** email：邮件标识 + 主题/发件人，够 Agent 再找回来即可 */
  messageId?: string
  subject?: string
  from?: string
  /** file：绝对路径；url：网址 */
  path?: string
  url?: string
}

export interface TodoItem {
  /** UUID，工具生成 */
  id: string
  /** 必填，简短描述 */
  title: string
  description?: string
  /** 默认 pending */
  status: TodoStatus
  /** 可选优先级 */
  priority?: TodoPriority
  /** ISO 8601；缺省 = 无截止 */
  dueDate?: string
  /** ISO 8601，工具填写，AI 不可改 */
  createdAt: string
  /** 每次修改自动更新 */
  updatedAt: string
  /** 进入 completed 时填写；离开 completed 时清空 */
  completedAt?: string
  tags?: string[]
  /** 这件事上发生过什么（安排时段 / 交办进展），只追加 */
  journal?: TodoJournalEntry[]
  /** 这条待办从哪来、相关材料在哪 */
  sources?: TodoSource[]
}

export interface TodoStoreData {
  version: 1
  todos: TodoItem[]
  /** store 级修改时间戳 */
  updatedAt: number
}
