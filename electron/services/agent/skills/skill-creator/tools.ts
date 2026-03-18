/**
 * 用户技能创建工具定义
 */

import type { ToolDefinition } from '../../tools'

export const skillCreatorTools: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'skill_create',
      description: `创建用户技能。将知识、操作指南或最佳实践保存为可复用的技能文件。

**使用场景**：
- 用户请求"把这个创建为技能"或"保存为我的技能"
- 将复杂操作流程文档化供后续使用
- 创建领域特定的操作指南

**技能格式**：技能使用 Markdown 格式，包含 YAML frontmatter 元数据。
技能创建后可通过 load_user_skill("技能ID") 加载使用。`,
      parameters: {
        type: 'object',
        properties: {
          skill_id: {
            type: 'string',
            description: '技能 ID（英文、数字、连字符，如 video-downloader）。用于目录命名和后续加载。'
          },
          name: {
            type: 'string',
            description: '技能名称（中文或英文，如"视频下载器"）。用于显示和识别。'
          },
          description: {
            type: 'string',
            description: '技能描述（一句话概括技能用途和适用场景）。帮助判断何时使用此技能。'
          },
          content: {
            type: 'string',
            description: '技能正文内容（Markdown 格式）。包含操作步骤、命令示例、最佳实践、故障排除等。'
          },
          version: {
            type: 'string',
            description: '版本号（可选，默认 "1.0"）'
          }
        },
        required: ['skill_id', 'name', 'description', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'skill_list',
      description: '列出所有用户技能。显示技能 ID、名称、描述、启用状态等信息。',
      parameters: {
        type: 'object',
        properties: {
          include_disabled: {
            type: 'boolean',
            description: '是否包含已禁用的技能，默认 true'
          }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'skill_delete',
      description: '删除用户技能。删除后技能文件将被移除，无法恢复。',
      parameters: {
        type: 'object',
        properties: {
          skill_id: {
            type: 'string',
            description: '要删除的技能 ID'
          }
        },
        required: ['skill_id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'skill_update',
      description: '更新用户技能内容。可更新名称、描述、正文内容等。',
      parameters: {
        type: 'object',
        properties: {
          skill_id: {
            type: 'string',
            description: '要更新的技能 ID'
          },
          name: {
            type: 'string',
            description: '新的技能名称（可选）'
          },
          description: {
            type: 'string',
            description: '新的技能描述（可选）'
          },
          content: {
            type: 'string',
            description: '新的技能正文内容（可选）'
          },
          version: {
            type: 'string',
            description: '新的版本号（可选）'
          }
        },
        required: ['skill_id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'skill_get_path',
      description: '获取用户技能目录路径。用于了解技能存储位置或手动编辑技能文件。',
      parameters: {
        type: 'object',
        properties: {}
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'skill_market_search',
      description: `搜索技能市场。同时搜索 SailFish 官方市场和 ClawHub 社区市场。

**使用场景**：
- 用户想找某个领域的技能（如"Docker"、"MySQL"、"部署"）
- 用户提到 ClawHub 或想安装社区技能
- 需要扩展 Agent 能力时主动搜索`,
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: '搜索关键词（支持中英文，如 "docker"、"数据库运维"、"git workflow"）'
          },
          source: {
            type: 'string',
            enum: ['all', 'sailfish', 'clawhub'],
            description: '搜索来源。默认 "all" 同时搜索两个市场'
          }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'skill_preview',
      description: `预览技能内容并执行安全扫描（不安装）。支持市场技能和本地技能。

用于在安装前主动检视技能内容，或应用户要求审查某技能。

此工具会：
1. 获取技能内容（市场技能下载、本地技能读取，均不安装）
2. 对所有文件（含脚本）执行静态安全扫描
3. 返回完整内容供审查

注意：安装工具（skill_market_install / skill_install_local）内部已自带安全扫描和确认流程，不要求必须先调用本工具。`,
      parameters: {
        type: 'object',
        properties: {
          skill_id: {
            type: 'string',
            description: '技能 ID 或本地路径。市场技能填 ID（如 "docker-operations"），本地技能填 .zip 文件路径或目录路径'
          },
          source: {
            type: 'string',
            enum: ['sailfish', 'clawhub', 'local'],
            description: '技能来源。SailFish 官方用 "sailfish"，ClawHub 社区用 "clawhub"，本地文件/目录用 "local"'
          }
        },
        required: ['skill_id', 'source']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'skill_market_install',
      description: `从技能市场安装技能到本地。内部自动执行安全扫描，含附属文件时要求用户确认。`,
      parameters: {
        type: 'object',
        properties: {
          skill_id: {
            type: 'string',
            description: '技能 ID'
          },
          source: {
            type: 'string',
            enum: ['sailfish', 'clawhub'],
            description: '技能来源'
          }
        },
        required: ['skill_id', 'source']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'skill_install_local',
      description: `从本地路径安装技能（ZIP 文件或目录）。内部自动执行安全扫描，含附属文件时要求用户确认。

⛔ **这是从本地路径安装技能的唯一正确方式**。严禁使用 run_command 或任何 shell 命令直接操作技能目录。`,
      parameters: {
        type: 'object',
        properties: {
          source_path: {
            type: 'string',
            description: '本地路径，可以是 .zip 文件路径或包含 SKILL.md 的目录路径'
          },
          skill_id: {
            type: 'string',
            description: '技能 ID（可选，默认从路径名推导）。只允许小写字母、数字、连字符。'
          }
        },
        required: ['source_path']
      }
    }
  }
]
