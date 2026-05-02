/**
 * Agent 工具定义
 */
import type { ToolDefinition } from '../ai.service'
import type { McpService } from '../mcp.service'
import type { PluginRegistry } from '../plugin/registry'
import { getSkillsSummary } from './skills/registry'
import { getUserSkillService } from '../user-skill.service'
import { getConfigService } from '../config.service'
import { isConfigured as isWebSearchConfigured } from '../web-search/index'
import type { AgentExecutionPhase } from './types'
import { t } from './i18n'
import { getStreamPlaceholder } from './tool-metadata'

// 重新导出 ToolDefinition 类型供技能模块使用
export type { ToolDefinition }

import type { TerminalType, RemoteChannel } from '@shared/types'

/** @deprecated Use TerminalType from @shared/types */
export type AgentMode = TerminalType

/**
 * 流式预卡片展示配置
 *
 * pre-card 和执行器 addStep 都通过 formatStreamPreCardFromMeta /
 * formatToolCallPrefixFromMeta 消费这些字段，对齐变成代码级机械保证
 *（详见 tool-metadata.ts）。
 *
 * 两种模式：
 * - 「声明式」（推荐）：填 titleKey + titleField + progressFields，覆盖绝大多数场景
 * - 「自定义渲染」：极少数复杂工具（如 dispatch_agents 要根据子任务数量构造文案）
 *   填 customRender，本字段优先级最高，命中后忽略 title* 字段
 *
 * 两种模式都支持 progressFields 共同的字符数尾缀。
 */
export interface ToolStreamDisplay {
  /**
   * 标题前缀的 i18n 键，或根据 args 动态返回 i18n 键的函数。
   * 复杂工具（如 write_text_file 按 mode 切换标题）写函数；简单工具直接写 string。
   */
  titleKey?: string | ((args: Record<string, unknown>) => string)
  /**
   * args 里取哪个字段作为副标题（path / command / query 等）。
   * AI 还没流到此字段时会用占位符兜底，避免长字段流式期间卡片不出现。
   * 不指定则只显示标题前缀（如 get_terminal_context 这类无参工具）。
   */
  titleField?: string
  /**
   * 哪些字段累计字符数尾缀（如 content / markdown / old_text）。
   * 用于让 AI 流式输出长字段时用户能看到字符数在跳动。
   */
  progressFields?: string[]
  /**
   * 自定义渲染函数（可选），返回**前缀**（不含字符数尾缀）。
   * 命中后忽略 titleKey/titleField，但 progressFields / customProgress 仍生效（统一加在末尾）。
   * 返回 null 表示当前 args 还不足以构造（如 dispatch_agents 的 tasks 数组还没到），
   * 让调用方保留上一次缓存内容，避免"闪一下又消失"。
   */
  customRender?: (args: Record<string, unknown>) => string | null
  /**
   * 自定义字符数计算（可选），用于 progressFields 表达不了的嵌套字段累计场景
   *（如 dispatch_agents 的 tasks[].prompt + tasks[].description）。
   * 返回 0 或 < 100 时不显示尾缀；progressFields 与 customProgress 同时存在时会累加。
   */
  customProgress?: (args: Record<string, unknown>) => number
}

/**
 * 工具元数据
 *
 * 这里是 Agent 基类决策时**唯一**应该读到的"具体工具差异"。
 * 任何"基类按工具名 switch / 硬编码工具名集合"的代码都应改为读这里的字段，
 * 见 SPEC.md「工具元数据驱动模型」。
 */
export interface ToolMeta {
  /** 支持的运行模式（不指定则支持所有模式） */
  supportedModes?: AgentMode[]

  /** 流式预卡片展示配置（不指定则用通用兜底「调用: {toolName}」） */
  streamDisplay?: ToolStreamDisplay

  /** 是否可与其他工具并行执行（默认 false：串行执行；副作用工具默认安全） */
  parallelizable?: boolean

  /** 执行此工具时的 Agent 执行阶段（默认 'executing_command'） */
  phase?: AgentExecutionPhase

  /**
   * 工具白名单 / 幂等键的字段子集（默认全 args 参与生成 key）。
   * 例如 execute_command 只取 ['command']，让"同一条命令"的不同上下文共享白名单。
   */
  idempotencyKey?: string[]

  /** 生命周期标志：影响 Agent 全局状态判断 */
  lifecycle?: {
    /** 调用此工具表示 onboarding 引导完成（如 personality_craft） */
    marksOnboardingComplete?: boolean
    /** 此工具的 tool_call 后会阻塞等待用户输入（如 ask_user） */
    blocksUntilUserInput?: boolean
  }

  /**
   * 参数角色：用于历史摘要等场景"知道哪个字段是重点"
   */
  argRole?: {
    /**
     * 此 args 的"主命令"字段，单行历史摘要显示这个字段的值。
     * 如 execute_command/exec 的 'command'。
     */
    summaryLine?: string
  }

  /**
   * 上下文压缩时的预算策略。不指定 → 默认为 'clearable'（可清理），
   * 让 Agent 在上下文紧张时优先清理这类工具的旧结果。
   */
  contextBudget?: {
    /** 工具结果的处理：'clearable'（可清理） / 'protected'（保护，永不清理） */
    toolResult?: 'clearable' | 'protected'
  }
}

/**
 * 带元数据的工具定义
 *
 * 注：发送给 LLM 之前 `getAgentTools()` 会把 `_meta` 字段剥掉（见本文件末尾的 cleanTools）。
 */
export interface ToolDefinitionWithMeta extends ToolDefinition {
  _meta?: ToolMeta
}

// ============================================================================
// streamDisplay customRender 辅助函数
// ============================================================================

/**
 * write_text_file / write_remote_text_file 的预卡片标题渲染。
 * 按 mode 切换 6 种文案；path 未到时占位符兜底；不含字符数尾缀（progressFields 单独负责）。
 */
function writeTextFilePrefix(args: Record<string, unknown>): string {
  const path = typeof args.path === 'string' ? args.path : getStreamPlaceholder()
  const mode = typeof args.mode === 'string' ? args.mode : 'create'
  const insertAtLine = typeof args.insert_at_line === 'number' ? args.insert_at_line : undefined
  const startLine = typeof args.start_line === 'number' ? args.start_line : undefined
  const endLine = typeof args.end_line === 'number' ? args.end_line : undefined
  const replaceAll = typeof args.replace_all === 'boolean' ? args.replace_all : true
  switch (mode) {
    case 'overwrite': return `${t('file.overwrite')}: ${path}`
    case 'append': return `${t('file.append')}: ${path}`
    case 'insert':
      return insertAtLine !== undefined
        ? `${t('file.insert_at_line', { line: insertAtLine })}: ${path}`
        : `${t('file.create')}: ${path}`
    case 'replace_lines':
      return startLine !== undefined && endLine !== undefined
        ? `${t('file.replace_lines', { start: startLine, end: endLine })}: ${path}`
        : `${t('file.create')}: ${path}`
    case 'regex_replace':
      return `${t('file.regex_replace', { scope: replaceAll ? t('file.regex_scope_all') : t('file.regex_scope_first') })}: ${path}`
    case 'create':
    default:
      return `${t('file.create')}: ${path}`
  }
}

/**
 * dispatch_agents 的预卡片渲染。
 * 内容格式必须与 tools/sub-agent.ts 执行器 addStep 的 content 对齐：
 *   "并行执行 {N} 个子任务（{typeLabel}）"
 * tasks 数组还没到或为空时返回 null（上层调用方保留缓存）。
 *
 * 注：执行器目前硬编码中文（typeLabel 用英文 agent_type 值），此处同样硬编码以
 * 保证接管时的字节级一致；将来两边一起 i18n 化时统一改。
 */
function dispatchAgentsPrefix(args: Record<string, unknown>): string | null {
  const rawTasks = Array.isArray(args.tasks) ? (args.tasks as unknown[]) : []
  if (rawTasks.length === 0) return null

  const globalType = typeof args.agent_type === 'string' ? args.agent_type : 'explore'
  let typeLabel = globalType
  for (const task of rawTasks) {
    if (!task || typeof task !== 'object') continue
    const tType = (task as { agent_type?: unknown }).agent_type
    const resolved = typeof tType === 'string' ? tType : globalType
    if (resolved !== typeLabel) {
      typeLabel = 'mixed'
      break
    }
  }
  return `并行执行 ${rawTasks.length} 个子任务（${typeLabel}）`
}

/**
 * read_file 的预卡片标题切换：info_only=true 时显示"读取文件 (仅查询信息)"，否则"读取文件"。
 * 提到顶层避免每次 getAgentTools 调用都生成新的函数引用（影响 toEqual 比较与 prompt cache）。
 */
function readFileTitleKey(args: Record<string, unknown>): string {
  return (args as { info_only?: unknown }).info_only === true
    ? 'file.reading_info_only'
    : 'file.reading'
}

/**
 * dispatch_agents 的字符数累计：tasks[].prompt + tasks[].description 嵌套字段。
 * 用 customProgress 暴露给 formatStreamPreCardFromMeta，让用户看到子任务指令在持续增长。
 */
function dispatchAgentsCharCount(args: Record<string, unknown>): number {
  const rawTasks = Array.isArray(args.tasks) ? (args.tasks as unknown[]) : []
  let chars = 0
  for (const task of rawTasks) {
    if (!task || typeof task !== 'object') continue
    const rec = task as { prompt?: unknown; description?: unknown }
    if (typeof rec.prompt === 'string') chars += rec.prompt.length
    if (typeof rec.description === 'string') chars += rec.description.length
  }
  return chars
}

/**
 * 动态构建 skill 工具定义（合并 load_skill + unload_skill）
 */
function buildSkillTool(): ToolDefinitionWithMeta {
  const disabledIds = new Set(getConfigService().get('disabledBuiltinSkills') || [])
  const skills = getSkillsSummary().filter(s => !disabledIds.has(s.id))
  const skillsCompact = skills.length > 0
    ? skills.map(s => `- ${s.id}: ${s.description}`).join('\n')
    : '暂无'
  const skillIds = skills.map(s => `"${s.id}"`).join(', ') || '暂无'

  return {
    type: 'function',
    function: {
      name: 'skill',
      description: `加载或卸载技能管理模块。加载后会话内持续有效。涉及相关领域时先加载再执行。

⚠️ 创建/更新/删除/安装技能 → 必须先 load skill-manager，严禁用 write_text_file 直接写 SKILL.md

可用技能：
${skillsCompact}`,
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['load', 'unload'],
            description: '操作类型：load（加载）或 unload（卸载）'
          },
          skill_id: {
            type: 'string',
            description: `技能 ID，可选值: ${skillIds}`
          }
        },
        required: ['action', 'skill_id']
      }
    },
    _meta: { parallelizable: true }
  }
}

/**
 * 动态构建 load_user_skill 工具定义
 * 用于加载用户自定义的技能（SKILL.md 文件）
 */
function buildLoadUserSkillTool(): ToolDefinitionWithMeta {
  const userSkillService = getUserSkillService()
  const skills = userSkillService.getEnabledSkills()
  const skillsList = skills.length > 0
    ? skills.map(s => {
        const desc = s.description ? ` - ${s.description}` : ''
        return `- **${s.id}**: ${s.name}${desc}`
      }).join('\n')
    : '- 暂无用户技能'

  return {
    type: 'function',
    function: {
      name: 'load_user_skill',
      description: `加载用户自定义技能（SKILL.md 操作指南）。与 skill 不同：skill 加载工具函数，本工具加载知识/流程指导。

**可用用户技能**：
${skillsList}`,
      parameters: {
        type: 'object',
        properties: {
          skill_id: {
            type: 'string',
            description: `用户技能 ID，可选值: ${skills.map(s => `"${s.id}"`).join(', ') || '暂无'}`
          }
        },
        required: ['skill_id']
      }
    },
    _meta: { parallelizable: true }
  }
}

/**
 * 动态构建 web_search 工具定义（仅在已配置时返回）
 */
function buildWebSearchTool(): ToolDefinitionWithMeta[] {
  if (!isWebSearchConfigured()) return []
  return [{
    type: 'function',
    function: {
      name: 'web_search',
      description: `搜索互联网获取实时信息。需要查找最新资料、验证事实、获取在线内容时使用。返回搜索结果列表（标题、URL、摘要）。`,
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: '搜索查询词'
          },
          max_results: {
            type: 'number',
            description: '最大结果数（默认 5，最大 10）'
          }
        },
        required: ['query']
      }
    },
    _meta: {
      parallelizable: true,
      contextBudget: { toolResult: 'clearable' },
      // 流式预卡片：标题用 i18n（zh: 网页搜索 / en: Web search），副标题取 query
      streamDisplay: { titleKey: 'web.search', titleField: 'query' }
    }
  }]
}

/**
 * 工具获取选项
 */
export interface GetAgentToolsOptions {
  /** Agent 运行模式，用于过滤不适用的工具 */
  mode?: AgentMode
  /** 请求来源通道（用于条件性加载 IM 专属工具） */
  remoteChannel?: RemoteChannel
  /** 是否包含上下文管理工具（用量超过阈值时启用，节省 token） */
  includeContextTools?: boolean
}

/**
 * 获取可用工具定义
 * @param mcpService 可选的 MCP 服务，用于动态加载 MCP 工具
 * @param options 可选配置，如终端类型
 * @param pluginRegistry 可选的插件注册表，用于加载插件工具
 */
export function getAgentTools(mcpService?: McpService, options?: GetAgentToolsOptions, pluginRegistry?: PluginRegistry): ToolDefinition[] {
  // assistant 模式的轻量命令执行工具（child_process）
  // 终端模式的 execute_command 及终端交互工具由 terminal 技能提供
  const execTool: ToolDefinitionWithMeta | null = options?.mode === 'assistant'
    ? {
        type: 'function',
        function: {
          name: 'exec',
          description: `运行 shell 命令并返回输出（同步）。不支持交互式命令(vim/nano/tmux)。长时间命令通过 timeout 延长（默认 60s，最大 600s）。命令上限 800 字符。`,
          parameters: {
            type: 'object',
            properties: {
              command: {
                type: 'string',
                description: '要执行的 shell 命令（最长 800 字符）'
              },
              cwd: {
                type: 'string',
                description: '工作目录（可选，默认使用当前目录）'
              },
              timeout: {
                type: 'number',
                description: '超时秒数（默认 60，最大 600）。长时间命令（如构建、下载、sleep+check 轮询）应设置足够的 timeout'
              }
            },
            required: ['command']
          }
        },
        _meta: {
          // 命令本身就是这个工具的"主语"，幂等键只取 command（cwd / timeout 不影响"是否同一条命令"）
          idempotencyKey: ['command'],
          // 命令输出可重新执行得到，上下文紧张时优先清理
          contextBudget: { toolResult: 'clearable' },
          // 历史摘要中"主命令"是 command 字段（task-memory.extractDigest 用得到）
          argRole: { summaryLine: 'command' },
          // 流式预卡片：标题 + command 字段；命令文本本身在流式增长，不加字符数尾缀
          streamDisplay: { titleKey: 'status.executing', titleField: 'command' }
        }
      }
    : null

  // 内置工具（所有模式通用）
  // ⚠️ 顺序约定：子 Agent 通用工具排在最前（前 8 个），让父/子 Agent 的工具列表共享 byte-exact 前缀，
  // 最大化 prompt cache 命中（参考 sub-agent.ts 的 SUB_AGENT_TYPES）。
  // 改动顺序时请同步检查子 Agent 工具白名单。
  const builtinTools: ToolDefinition[] = [
    // ==================== 子 Agent 通用前缀（explore/edit/research 都用） ====================
    ...(execTool ? [execTool as ToolDefinition] : []),
    {
      type: 'function',
      function: {
        name: 'read_file',
        description: `读取本地文件。支持文本、PDF、Word(.doc/.docx)、图片(jpg/png/gif/bmp/webp/ico，自动注入视觉上下文)。自动检测二进制文件。大文件先用 info_only 查信息，再按行范围读取。仅本地文件，SSH 远程请用命令行。`,
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: '文件路径（绝对路径或相对于当前目录）'
            },
            info_only: {
              type: 'boolean',
              description: '仅获取文件信息（大小、行数等），不读取内容'
            },
            start_line: { type: 'number', description: '起始行号（从1开始）' },
            end_line: { type: 'number', description: '结束行号（包含）' },
            max_lines: { type: 'number', description: '从开头读取的最大行数' },
            tail_lines: { type: 'number', description: '从末尾读取的行数' }
          },
          required: ['path']
        }
      },
      _meta: {
        supportedModes: ['local', 'assistant'],
        parallelizable: true,
        contextBudget: { toolResult: 'clearable' },
        // 标题按 info_only 切换："读取文件" vs "读取文件 (仅查询信息)"，path 字段做副标题
        streamDisplay: { titleKey: readFileTitleKey, titleField: 'path' }
      }
    } as ToolDefinitionWithMeta,
    {
      type: 'function',
      function: {
        name: 'file_search',
        description: `快速搜索本地文件名（基于系统索引，毫秒级）。多个关键词用空格分隔表示文件名需同时包含所有关键词（AND 关系，不要求连续，不区分大小写）。例如 "员工 奖惩" 可命中 "员工奖惩管理.docx" 和 "2024员工奖惩明细.xlsx"。仅搜文件名不搜内容，搜内容请用 grep。仅本地，不支持 SSH。`,
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: '搜索关键词。多个关键词用空格分隔表示同时包含（AND，不要求顺序与连续），如 "员工 奖惩" 命中 "员工奖惩管理.docx"。也支持通配符 * ?'
            },
            path: {
              type: 'string',
              description: '限制搜索目录（可选，不指定则全盘搜索）'
            },
            type: {
              type: 'string',
              enum: ['file', 'dir', 'all'],
              description: '搜索类型：file（仅文件）、dir（仅目录）、all（全部，默认）'
            },
            limit: {
              type: 'number',
              description: '最大结果数量，默认 50'
            }
          },
          required: ['query']
        }
      },
      _meta: {
        supportedModes: ['local', 'assistant'],
        parallelizable: true,
        contextBudget: { toolResult: 'clearable' }
      }
    } as ToolDefinitionWithMeta,
    {
      type: 'function',
      function: {
        name: 'search_knowledge',
        description: '搜索用户的知识库文档。搜索结果已包含文档内容，直接使用即可。',
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: '简短的搜索词，1-3个核心关键词即可，避免堆砌'
            },
            limit: {
              type: 'integer',
              description: '返回结果数量（整数），默认 5，范围 1-20'
            }
          },
          required: ['query']
        }
      },
      _meta: { parallelizable: true, contextBudget: { toolResult: 'clearable' } }
    } as ToolDefinitionWithMeta,
    {
      type: 'function',
      function: {
        name: 'get_knowledge_doc',
        description: '按文档 ID 精确获取知识库中的完整文档内容。当用户通过 @docs 引用了特定文档时（消息中会显示 doc_id:xxx），使用此工具获取完整内容。',
        parameters: {
          type: 'object',
          properties: {
            doc_id: {
              type: 'string',
              description: '文档 ID，从用户消息中的 doc_id:xxx 获取'
            }
          },
          required: ['doc_id']
        }
      },
      _meta: { parallelizable: true, contextBudget: { toolResult: 'clearable' } }
    } as ToolDefinitionWithMeta,
    ...buildWebSearchTool(),
    // ==================== edit 子 Agent 额外允许的工具 ====================
    {
      type: 'function',
      function: {
        name: 'edit_file',
        description: `查找替换修改本地文件（修改首选工具）。使用前必须先 read_file 查看文件，old_text 必须从 read_file 输出中精确复制（不含行号前缀）。old_text 必须在文件中唯一匹配，匹配多处时提供更多上下文使其唯一。创建新文件请用 write_text_file。`,
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: '本地文件路径（绝对路径或相对于当前目录）'
            },
            old_text: {
              type: 'string',
              description: '要替换的原始文本，必须与文件内容完全匹配（包括空白和换行）'
            },
            new_text: {
              type: 'string',
              description: '替换后的新文本'
            },
            replace_all: {
              type: 'boolean',
              description: '替换所有匹配（默认 false，仅替换唯一匹配）'
            }
          },
          required: ['path', 'old_text', 'new_text']
        }
      },
      _meta: {
        supportedModes: ['local', 'assistant'],
        phase: 'writing_file',
        contextBudget: { toolResult: 'protected' },
        // 同 write_text_file：path 未到时占位符兜底，old_text + new_text 累计字符数尾缀
        streamDisplay: {
          titleKey: 'file.edit',
          titleField: 'path',
          progressFields: ['old_text', 'new_text']
        }
      }
    } as ToolDefinitionWithMeta,
    {
      type: 'function',
      function: {
        name: 'write_text_file',
        description: `写入或创建本地纯文本文件。部分修改请优先用 edit_file。大文件分段写入（先 create 再 append）。重要文件请先备份。`,
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: '本地文件路径（绝对路径或相对于当前目录）'
            },
            content: {
              type: 'string',
              description: '文件内容（覆盖/追加/插入/行替换模式必填）'
            },
            mode: {
              type: 'string',
              enum: ['create', 'overwrite', 'append', 'insert', 'replace_lines', 'regex_replace'],
              description: '写入模式（默认 create）'
            },
            insert_at_line: { type: 'number', description: 'insert: 插入行号（从1开始）' },
            start_line: { type: 'number', description: 'replace_lines: 起始行号' },
            end_line: { type: 'number', description: 'replace_lines: 结束行号' },
            pattern: { type: 'string', description: 'regex_replace: 正则表达式' },
            replacement: { type: 'string', description: 'regex_replace: 替换内容（支持 $1 $2）' },
            replace_all: { type: 'boolean', description: 'regex_replace: 替换全部（默认 true）' }
          },
          required: ['path']
        }
      },
      _meta: {
        supportedModes: ['local', 'assistant'],
        phase: 'writing_file',
        contextBudget: { toolResult: 'protected' },
        // 流式预卡片：mode 切换 6 种文案，path 占位符兜底，content 累计字符数尾缀。
        // customRender 只负责前缀，progressFields 在外层统一加尾缀。
        streamDisplay: {
          customRender: writeTextFilePrefix,
          progressFields: ['content']
        }
      }
    } as ToolDefinitionWithMeta,
    // ==================== 父 Agent 专用工具 ====================
    {
      type: 'function',
      function: {
        name: 'write_remote_text_file',
        description: `通过 SFTP 写入远程纯文本文件。大文件分段写入（先 create 再 append）。路径不支持 ~。局部修改请用命令行 sed/awk。`,
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: '远程文件路径'
            },
            content: {
              type: 'string',
              description: '文件内容'
            },
            mode: {
              type: 'string',
              enum: ['create', 'overwrite', 'append'],
              description: '写入模式：create（新建，默认）、overwrite（覆盖）、append（追加）'
            }
          },
          required: ['path', 'content']
        }
      },
      _meta: {
        supportedModes: ['ssh'],
        phase: 'writing_file',
        contextBudget: { toolResult: 'protected' },
        // 与 write_text_file 共享同一套预卡片渲染（mode 切换文案、path 占位符、字符数尾缀）
        streamDisplay: {
          customRender: writeTextFilePrefix,
          progressFields: ['content']
        }
      }
    } as ToolDefinitionWithMeta,
    {
      type: 'function',
      function: {
        name: 'remember_info',
        description: '将信息整合到持久知识文档中，未来交互时自动提供。适用于用户要求记住的偏好、配置、约定等长期有效的信息。',
        parameters: {
          type: 'object',
          properties: {
            info: {
              type: 'string',
              description: '要记住的信息，关键细节必须完整准确'
            }
          },
          required: ['info']
        }
      },
      _meta: { contextBudget: { toolResult: 'protected' } }
    } as ToolDefinitionWithMeta,
    {
      type: 'function',
      function: {
        name: 'ask_user',
        description: `向用户提问并等待回复。只在制定计划时提问，执行中优先用合理默认值。调用后暂停执行直到用户回复。`,
        parameters: {
          type: 'object',
          properties: {
            question: {
              type: 'string',
              description: '要向用户提出的问题，应清晰明确'
            },
            options: {
              type: 'array',
              items: { type: 'string' },
              description: '可选项列表（最多 10 个）'
            },
            allow_multiple: { type: 'boolean', description: '允许多选（默认 false）' },
            default_value: { type: 'string', description: '默认值' },
            timeout: { type: 'number', description: '超时秒数（默认 120，范围 30-600）' }
          },
          required: ['question']
        }
      },
      _meta: {
        contextBudget: { toolResult: 'protected' },
        // 此工具的 tool_call 后会阻塞等待用户输入（task-memory 据此识别"任务在等待确认"）
        lifecycle: { blocksUntilUserInput: true }
      }
    } as ToolDefinitionWithMeta,
    // ==================== Plan 工具（合并 create/update/clear） ====================
    {
      type: 'function',
      function: {
        name: 'plan',
        description: `管理任务执行计划。4+ 步骤且有依赖关系时使用，简单任务不需要。

**action**：
- create: 创建计划（需 title + steps）
- update: 更新步骤状态（需 step_index + status）
- pause: 暂停计划，停止自动推进，等待用户指示后再继续（可选 reason）
- resume: 恢复已暂停的计划，继续执行
- clear: 归档计划（可选 reason）`,
        parameters: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['create', 'update', 'pause', 'resume', 'clear'],
              description: '操作类型'
            },
            title: { type: 'string', description: 'create: 计划标题' },
            steps: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  title: { type: 'string', description: '步骤标题' },
                  description: { type: 'string', description: '步骤说明（可选）' }
                },
                required: ['title']
              },
              description: 'create: 步骤列表'
            },
            step_index: { type: 'number', description: 'update: 步骤索引（从 0 开始）' },
            status: {
              type: 'string',
              enum: ['pending', 'in_progress', 'completed', 'failed', 'skipped'],
              description: 'update: 步骤状态'
            },
            result: { type: 'string', description: 'update: 步骤结果说明（可选）' },
            reason: { type: 'string', description: 'pause/clear: 暂停或归档原因（可选）' }
          },
          required: ['action']
        }
      },
      _meta: { contextBudget: { toolResult: 'protected' } }
    } as ToolDefinitionWithMeta,
    buildSkillTool(),
    buildLoadUserSkillTool(),
    // ==================== 任务记忆工具（合并 recall_task/deep_recall） ====================
    {
      type: 'function',
      function: {
        name: 'recall',
        description: `回忆之前任务的信息。默认返回摘要（命令、路径、错误、关键发现），设 detail="full" 获取完整执行步骤。

上下文中的"任务历史"列表显示了所有可回忆的任务 ID。`,
        parameters: {
          type: 'object',
          properties: {
            task_id: {
              type: 'string',
              description: '任务 ID'
            },
            detail: {
              type: 'string',
              enum: ['summary', 'full'],
              description: '详细程度，默认 summary'
            },
            step_index: {
              type: 'number',
              description: 'detail=full 时可指定步骤索引（从 0 开始）'
            }
          },
          required: ['task_id']
        }
      },
      _meta: { parallelizable: true, contextBudget: { toolResult: 'clearable' } }
    } as ToolDefinitionWithMeta,
    // ==================== 历史搜索工具 ====================
    {
      type: 'function',
      function: {
        name: 'search_history',
        description: `搜索跨会话的历史对话记录（recall 只查当前会话）。支持两种模式：keyword（关键字匹配，默认）和 semantic（语义搜索，用自然语言描述要找什么）。keyword 模式需提供 keyword/start_date/end_date 至少一个；semantic 模式需提供 keyword 作为语义查询。detail: summary（默认）仅任务和结果，full 含工具调用记录。`,
        parameters: {
          type: 'object',
          properties: {
            keyword: { type: 'string', description: '搜索关键字或语义查询（semantic 模式下用自然语言描述）' },
            mode: {
              type: 'string',
              enum: ['keyword', 'semantic'],
              description: '搜索模式：keyword=关键字匹配（默认），semantic=向量语义搜索'
            },
            start_date: { type: 'string', description: '开始时间（YYYY-MM-DD 或 YYYY-MM-DD HH:mm）' },
            end_date: { type: 'string', description: '结束时间' },
            detail: {
              type: 'string',
              enum: ['summary', 'full'],
              description: '输出级别。summary=仅任务和结果；full=额外包含工具调用记录。默认 summary'
            },
            limit: {
              type: 'number',
              description: '返回结果数量，默认 10，最大 30'
            }
          },
          required: []
        }
      }
    },
    // ==================== 并行子 Agent ====================
    {
      type: 'function',
      function: {
        name: 'dispatch_agents',
        description: `将多个**独立子任务**分派给并行子 Agent 同时执行。适用于可拆分为互不依赖的子问题的场景（如同时分析多个文件、并行调研不同方向）。

⚠️ 使用条件：
- 子任务之间**无数据依赖**，可独立完成
- 子任务各自聚焦明确的小目标
- 2 个及以上子任务才有并行价值

Agent 类型：
- explore（默认）：只读分析，读文件/exec/搜索
- edit：可修改文件（edit_file/write_text_file）
- research：知识检索与归纳，侧重知识库和结构化输出

子 Agent 不能操作终端、不能向用户提问。`,
        parameters: {
          type: 'object',
          properties: {
            tasks: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  description: { type: 'string', description: '任务简述（一句话，用于进度展示）' },
                  prompt: { type: 'string', description: '详细任务指令（子 Agent 的完整上下文）' },
                  agent_type: { type: 'string', enum: ['explore', 'edit', 'research'], description: '此子任务的 Agent 类型（覆盖全局 agent_type）' }
                },
                required: ['description', 'prompt']
              },
              description: '子任务列表（2-10 个）'
            },
            agent_type: {
              type: 'string',
              enum: ['explore', 'edit', 'research'],
              description: '全局 Agent 类型（默认 explore）。每个子任务可单独指定 agent_type 覆盖'
            },
            max_concurrent: {
              type: 'number',
              description: '最大并发数（默认 5，范围 1-10）'
            }
          },
          required: ['tasks']
        }
      },
      _meta: {
        supportedModes: ['local', 'assistant'],
        contextBudget: { toolResult: 'protected' },
        // 流式预卡片：tasks 数组才能确定文案，customRender 处理 N + agent_type；
        // 字符数从 tasks[].prompt + tasks[].description 嵌套累加，用 customProgress
        streamDisplay: {
          customRender: dispatchAgentsPrefix,
          customProgress: dispatchAgentsCharCount
        }
      }
    } as ToolDefinitionWithMeta,
    // ==================== 分屏管理（仅终端 Agent 可用） ====================
    {
      type: 'function',
      function: {
        name: 'split_terminal',
        description: `在当前激活的终端 tab 上创建分屏。direction='horizontal' 表示左右分屏，'vertical' 表示上下分屏。仅对终端 tab 有效。

**新窗格连接到哪里**（通过可选 target 参数控制）：
- 不传 target：复用当前激活窗格的连接（与原行为一致——本地激活就开本地，SSH 激活就开同一会话的新连接）
- target="local"：强制新开本地终端
- target="ssh:<sessionId>"：连接到指定的已配置 SSH 会话（先调 list_ssh_sessions 获取 sessionId）
- 也支持对象形态：target={kind:"local"} / {kind:"inherit"} / {kind:"ssh", sessionId:"..."}

返回数据中 panes 数组列出所有窗格的 paneId / ptyId / terminalType。如果你想在新窗格里执行命令，给 execute_command（以及 send_input、send_control_key、check_terminal_status、get_terminal_context 等终端工具）传入 pane_id 参数，值=该窗格的 ptyId。

典型用法：
- 多机巡检：list_ssh_sessions 拿清单 → 给每台 split_terminal(direction, target="ssh:xxx") → 各窗格并行 execute_command
- 本地+远程对照：split_terminal("horizontal", "local") 在右边开本地终端`,
        parameters: {
          type: 'object',
          properties: {
            direction: {
              type: 'string',
              enum: ['horizontal', 'vertical'],
              description: '分屏方向：horizontal=左右、vertical=上下'
            },
            target: {
              type: 'string',
              description: '新窗格的连接源（可选）：不传或 "inherit" 复用激活窗格连接；"local" 新开本地终端；"ssh:<sessionId>" 连接到 list_ssh_sessions 返回的 SSH 会话'
            }
          },
          required: ['direction']
        }
      },
      _meta: {
        supportedModes: ['local', 'ssh'],
        contextBudget: { toolResult: 'clearable' }
      }
    } as ToolDefinitionWithMeta,
    {
      type: 'function',
      function: {
        name: 'close_pane',
        description: `关闭指定窗格。关闭后若只剩一个窗格，list_panes 的 mode 会切回 'single'。

pane_id 接受两种值（任选其一）：
- list_panes 返回的 paneId（布局节点 id）
- list_panes 返回的 ptyId（窗格 PTY 实例 id，**推荐**——分屏后保持不变，不会过期）

如果你拿着旧 list_panes 的结果，**优先传 ptyId** 更稳。失败时（节点不存在）会返回明确错误。

可以关闭包括"你当前正在操作的窗格"在内的任意窗格。如果关掉的就是当前操作焦点，工具会自动把"当前默认窗格"切到剩余的某个，后续 execute_command 默认在新焦点执行（无需显式传 pane_id）。唯一例外：剩最后一个窗格时不能关——那等于关闭整个 tab。`,
        parameters: {
          type: 'object',
          properties: {
            pane_id: {
              type: 'string',
              description: '要关闭的窗格标识符（list_panes 的 paneId 或 ptyId 任一种）'
            }
          },
          required: ['pane_id']
        }
      },
      _meta: {
        supportedModes: ['local', 'ssh'],
        contextBudget: { toolResult: 'clearable' }
      }
    } as ToolDefinitionWithMeta,
    {
      type: 'function',
      function: {
        name: 'focus_pane',
        description: `把激活焦点切到指定窗格。**会同时改变 Agent 的"当前默认操作窗格"**：调用之后 execute_command 等终端工具默认在该窗格执行，不必每次再传 pane_id。

适合"接下来一连串命令都要在同一个窗格跑"的场景——一次 focus_pane 切过去，后续命令简洁。如果只是想在某个窗格执行单条命令，直接给那条命令传 pane_id 更轻量。

pane_id 接受 list_panes 返回的 paneId 或 ptyId 任一种（推荐 ptyId，更稳）。`,
        parameters: {
          type: 'object',
          properties: {
            pane_id: {
              type: 'string',
              description: '要激活的窗格标识符（list_panes 的 paneId 或 ptyId 任一种）'
            }
          },
          required: ['pane_id']
        }
      },
      _meta: {
        supportedModes: ['local', 'ssh'],
        contextBudget: { toolResult: 'clearable' }
      }
    } as ToolDefinitionWithMeta,
    {
      type: 'function',
      function: {
        name: 'list_panes',
        description: `列出当前激活 tab 的所有窗格（含 pane_id、pty_id、label、是否激活、终端类型）。当 system prompt 中的窗格信息不够实时或刚做过分屏调整时使用。

返回的 ptyId 字段就是其他终端工具（execute_command 等）pane_id 参数所需的值——想在哪个窗格跑命令，就把那个窗格的 ptyId 传给工具的 pane_id 参数。`,
        parameters: {
          type: 'object',
          properties: {}
        }
      },
      _meta: {
        supportedModes: ['local', 'ssh'],
        parallelizable: true,
        contextBudget: { toolResult: 'clearable' }
      }
    } as ToolDefinitionWithMeta,
    {
      type: 'function',
      function: {
        name: 'list_ssh_sessions',
        description: `列出用户已配置好的 SSH 会话清单（不含密码 / 私钥等敏感字段），返回每个会话的 sessionId、name、host、port、username、group、lastUsedAt。

用途：当你想在新窗格里连接到某台已配置的服务器时，先调本工具拿 sessionId，再调 split_terminal(direction, target="ssh:<sessionId>") 即可在新窗格中打开对应的 SSH 连接。无需用户手工切换或输入凭证。

适用场景：
- 多机巡检 / 灰度对比（dev/staging/prod 平铺为多窗格）
- 跨主机故障排查
- 用户说"在 xxx 服务器上看一下..."时，对照本清单找到对应 sessionId`,
        parameters: {
          type: 'object',
          properties: {}
        }
      },
      _meta: {
        supportedModes: ['local', 'ssh'],
        parallelizable: true,
        contextBudget: { toolResult: 'clearable' }
      }
    } as ToolDefinitionWithMeta,

    // ==================== 发消息给用户 ====================
    {
      type: 'function',
      function: {
        name: 'talk_to_user',
        description: `向用户发送 IM 消息或应用内推送通知，不会直接展示在桌面对话中。用于后台主动触达用户（如关切触发、唤醒、定时提醒、后台任务完成通知等）。`,
        parameters: {
          type: 'object',
          properties: {
            message: {
              type: 'string',
              description: '要发送给用户的消息内容'
            },
            title: {
              type: 'string',
              description: '消息标题（可选，一般为你的名字，指定后以卡片形式发送）'
            }
          },
          required: ['message']
        }
      }
    }
  ]

  // 根据运行模式过滤工具
  let filteredTools: ToolDefinition[] = builtinTools
  if (options?.mode) {
    filteredTools = builtinTools.filter(tool => {
      const meta = (tool as ToolDefinitionWithMeta)._meta
      // 没有 _meta 或没有 supportedModes 的工具支持所有模式
      if (!meta?.supportedModes) return true
      // 检查当前模式是否在支持列表中
      return meta.supportedModes.includes(options.mode!)
    })
  }

  // IM 通道专属工具：所有 IM 平台均可发送文件和图片
  const imPlatformMeta: Record<string, { name: string; fileLimit: string; imageLimit: string }> = {
    dingtalk: { name: '钉钉', fileLimit: '20MB', imageLimit: '20MB' },
    feishu:   { name: '飞书', fileLimit: '30MB', imageLimit: '10MB' },
    slack:    { name: 'Slack', fileLimit: '1GB', imageLimit: '1GB' },
    telegram: { name: 'Telegram', fileLimit: '50MB', imageLimit: '10MB' },
    wecom:    { name: '企业微信', fileLimit: '20MB', imageLimit: '20MB' },
    wechat:   { name: '微信', fileLimit: '20MB', imageLimit: '20MB' },
  }
  const imMeta = options?.remoteChannel ? imPlatformMeta[options.remoteChannel] : undefined
  if (imMeta) {
    filteredTools.push({
      type: 'function',
      function: {
        name: 'send_to_chat',
        description: `发送本地文件或图片到当前${imMeta.name}聊天。图片会内联显示，其他文件作为附件发送。

**限制**：文件 ≤${imMeta.fileLimit}，图片 ≤${imMeta.imageLimit}，一次一个文件。`,
        parameters: {
          type: 'object',
          properties: {
            file_path: {
              type: 'string',
              description: '文件的绝对路径'
            },
            type: {
              type: 'string',
              enum: ['file', 'image'],
              description: '发送类型：image（图片，内联显示）或 file（文件，附件形式）。默认 file'
            },
            file_name: {
              type: 'string',
              description: 'type=file 时可选，自定义文件名'
            }
          },
          required: ['file_path']
        }
      },
      // 发送结果只是"已发送/失败"短消息，可清理；与其他动作型工具保持元数据一致性
      _meta: { contextBudget: { toolResult: 'clearable' } }
    } as ToolDefinitionWithMeta)
  }

  // 上下文管理工具：仅在用量超过阈值时注入，节省 token
  if (options?.includeContextTools) {
    filteredTools.push(...getContextManagementTools())
  }

  // 注意：保留 _meta 字段，让 Agent 基类能通过 getMetaByName 查到工具的元数据
  // （phase / parallelizable / streamDisplay 等运行时决策都依赖此元数据）。
  // 真正发给 LLM 之前由 stripToolMeta 在调用方剥离，避免浪费 token。
  // 添加插件工具
  if (pluginRegistry) {
    filteredTools.push(...pluginRegistry.getToolDefinitions())
  }

  // 如果有 MCP 服务，添加 MCP 工具
  if (mcpService) {
    const mcpTools = mcpService.getToolDefinitions()
    return [...filteredTools, ...mcpTools]
  }

  return filteredTools
}

/**
 * 剥离 ToolDefinition 上的 `_meta` 字段，得到可以安全发给 LLM 的形态。
 *
 * Agent 内部工具列表（`getAgentTools()` 返回值）保留 `_meta` 用于运行时决策；
 * 在真正调用 AI Service 之前调用本函数清理，避免把内部元数据当作 token 发出去。
 */
export function stripToolMeta(tools: readonly ToolDefinition[]): ToolDefinition[] {
  return tools.map(tool => {
    const { _meta, ...clean } = tool as ToolDefinitionWithMeta
    void _meta
    return clean as ToolDefinition
  })
}

/**
 * 上下文管理工具定义（按需加载，用量超过阈值时才注入）
 */
function getContextManagementTools(): ToolDefinition[] {
  return [
    {
      type: 'function',
      function: {
        name: 'compress_context',
        description: `压缩较早的工具调用以释放上下文空间。内容归档保留，可通过 recall_compressed 找回。摘要应包含关键结果、路径、命令和发现。`,
        parameters: {
          type: 'object',
          properties: {
            summary: {
              type: 'string',
              description: '被压缩内容的摘要，应包含关键命令、结果、路径和发现'
            },
            keep_recent: {
              type: 'number',
              description: '保留最近多少组消息（assistant + tool 响应）不压缩，默认 4'
            }
          },
          required: ['summary']
        }
      },
      _meta: { contextBudget: { toolResult: 'protected' } }
    } as ToolDefinitionWithMeta,
    {
      type: 'function',
      function: {
        name: 'recall_compressed',
        description: `从压缩归档中取回原始消息。省略 archive_id 则列出所有可用归档。`,
        parameters: {
          type: 'object',
          properties: {
            archive_id: {
              type: 'string',
              description: '要取回的归档 ID（如 "ca-1"），省略则列出所有可用归档'
            }
          }
        }
      },
      _meta: { contextBudget: { toolResult: 'protected' } }
    } as ToolDefinitionWithMeta,
    {
      type: 'function',
      function: {
        name: 'manage_memory',
        description: `管理历史任务记忆。suggestions 设置压缩级别（0=完整 1=工具摘要 2=请求+回复 3=结构化摘要 4=一句话），discard 丢弃不需要的任务。`,
        parameters: {
          type: 'object',
          properties: {
            suggestions: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  task_id: { type: 'string', description: '任务 ID' },
                  level: { type: 'number', description: '压缩级别（0-4）' },
                  reason: { type: 'string', description: '设置该级别的简要原因' }
                },
                required: ['task_id', 'level']
              },
              description: '对历史任务的压缩级别建议'
            },
            discard: {
              type: 'array',
              items: { type: 'string' },
              description: '要完全丢弃的任务 ID 列表'
            }
          }
        }
      },
      _meta: { contextBudget: { toolResult: 'protected' } }
    } as ToolDefinitionWithMeta
  ]
}
