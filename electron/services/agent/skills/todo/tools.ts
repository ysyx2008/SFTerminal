/**
 * 本地秘书待办技能 - 工具定义
 * 与日历 CalDAV VTODO（calendar_todo_*）无关。
 */
import type { ToolDefinition, ToolDefinitionWithMeta } from '../../tools'

const listMeta = {
  parallelizable: true,
  phase: 'idle' as const,
  contextBudget: { toolResult: 'clearable' as const },
}

export const todoTools: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'todo_list',
      description: `列出用户本地秘书待办（工作空间 TODO.json，不是日历 VTODO）。

默认排除已完成/已取消；传 include_done=true 可包含。
支持按 status / priority / dueDate / tags 过滤，并按 due / created / priority / updated 排序。`,
      parameters: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: ['pending', 'in_progress', 'completed', 'cancelled', 'all'],
            description: '按状态过滤；默认活跃（pending+in_progress）；all=全部'
          },
          priority: {
            type: 'string',
            enum: ['low', 'normal', 'high', 'urgent'],
            description: '按优先级过滤'
          },
          due_before: {
            type: 'string',
            description: '只返回截止日期不晚于此（ISO 8601）的待办'
          },
          due_after: {
            type: 'string',
            description: '只返回截止日期不早于此（ISO 8601）的待办'
          },
          tag: {
            type: 'string',
            description: '按标签过滤（精确匹配某一 tag）'
          },
          include_done: {
            type: 'boolean',
            description: '是否包含 completed/cancelled（默认 false；status=all 时亦包含）'
          },
          sort_by: {
            type: 'string',
            enum: ['due', 'created', 'priority', 'updated'],
            description: '排序字段，默认 due'
          },
          sort_order: {
            type: 'string',
            enum: ['asc', 'desc'],
            description: '排序方向，默认 asc'
          }
        }
      }
    },
    _meta: listMeta
  } as ToolDefinitionWithMeta,
  {
    type: 'function',
    function: {
      name: 'todo_create',
      description: `创建本地秘书待办。自动生成 id/createdAt/updatedAt；默认 status=pending。
createdAt 不可由调用方指定。日历里的 VTODO 请用 calendar_todo_create。`,
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '待办标题（必填）' },
          description: { type: 'string', description: '详细说明' },
          priority: {
            type: 'string',
            enum: ['low', 'normal', 'high', 'urgent'],
            description: '可选优先级'
          },
          due_date: {
            type: 'string',
            description: '截止日期（ISO 8601）'
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: '分类标签'
          },
          status: {
            type: 'string',
            enum: ['pending', 'in_progress', 'completed', 'cancelled'],
            description: '初始状态，默认 pending'
          }
        },
        required: ['title']
      }
    },
    _meta: {
      phase: 'idle',
      contextBudget: { toolResult: 'protected' },
      parallelizable: false,
    }
  } as ToolDefinitionWithMeta,
  {
    type: 'function',
    function: {
      name: 'todo_update',
      description: `更新本地待办。可改 title/description/priority/due_date/tags/status。
进入 completed 自动写 completedAt；离开 completed 清空 completedAt。createdAt 不可改。`,
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '待办 ID（从 todo_list 获取）' },
          title: { type: 'string', description: '新标题' },
          description: { type: 'string', description: '新描述；传空字符串可清空' },
          priority: {
            type: 'string',
            enum: ['low', 'normal', 'high', 'urgent', ''],
            description: '新优先级；传空字符串清空'
          },
          due_date: {
            type: 'string',
            description: '新截止日期；传空字符串清空'
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: '新标签列表；传空数组清空'
          },
          status: {
            type: 'string',
            enum: ['pending', 'in_progress', 'completed', 'cancelled'],
            description: '新状态'
          },
          clear_description: {
            type: 'boolean',
            description: '为 true 时清空 description'
          },
          clear_priority: {
            type: 'boolean',
            description: '为 true 时清空 priority'
          },
          clear_due_date: {
            type: 'boolean',
            description: '为 true 时清空 dueDate'
          },
          clear_tags: {
            type: 'boolean',
            description: '为 true 时清空 tags'
          }
        },
        required: ['id']
      }
    },
    _meta: {
      phase: 'idle',
      contextBudget: { toolResult: 'protected' },
      parallelizable: false,
    }
  } as ToolDefinitionWithMeta,
  {
    type: 'function',
    function: {
      name: 'todo_complete',
      description: `快捷将本地待办标记为 completed（自动写 completedAt）。也可用 todo_update 设 status。`,
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '待办 ID' }
        },
        required: ['id']
      }
    },
    _meta: {
      phase: 'idle',
      contextBudget: { toolResult: 'protected' },
      parallelizable: false,
    }
  } as ToolDefinitionWithMeta,
  {
    type: 'function',
    function: {
      name: 'todo_delete',
      description: `彻底删除本地待办（不可恢复）。取消请用 todo_update 设 status=cancelled。`,
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '待办 ID' }
        },
        required: ['id']
      }
    },
    _meta: {
      phase: 'idle',
      contextBudget: { toolResult: 'protected' },
      parallelizable: false,
    }
  } as ToolDefinitionWithMeta,
]

export const todoSkillContent = `## 本地待办（todo 技能）

数据在工作空间 \`TODO.json\`，**勿直接改文件**，一律用 \`todo_*\` 工具。

- 与日历 CalDAV VTODO 不同：日历待办用 \`calendar_todo_*\`
- 心跳会注入当前待办摘要；正式列表用 \`todo_list\`
- 提醒用户做事 → \`todo_create\`；自己定期执行 → 用关切（watch）`
