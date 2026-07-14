/**
 * 本地秘书待办（todo 技能）共享类型
 * 存储：`{userData}/agent-workspace/TODO.json`
 */

export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled'

export type TodoPriority = 'low' | 'normal' | 'high' | 'urgent'

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
}

export interface TodoStoreData {
  version: 1
  todos: TodoItem[]
  /** store 级修改时间戳 */
  updatedAt: number
}
