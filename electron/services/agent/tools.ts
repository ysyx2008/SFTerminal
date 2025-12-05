/**
 * Agent 工具定义
 */
import type { ToolDefinition } from '../ai.service'

/**
 * 获取可用工具定义
 */
export function getAgentTools(): ToolDefinition[] {
  return [
    {
      type: 'function',
      function: {
        name: 'execute_command',
        description: '在当前终端执行 shell 命令。注意：不支持交互式命令（如vim/top/watch/tail -f），这些命令会被自动拒绝。',
        parameters: {
          type: 'object',
          properties: {
            command: {
              type: 'string',
              description: '要执行的 shell 命令（不能是交互式命令）'
            }
          },
          required: ['command']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'get_terminal_context',
        description: '获取终端最近的输出内容，用于了解当前终端状态和之前命令的执行结果。如果之前的命令超时或失败，可以调用此工具查看终端当前的实际输出。',
        parameters: {
          type: 'object',
          properties: {
            lines: {
              type: 'string',
              description: '要获取的行数，默认 50'
            }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'send_control_key',
        description: '向终端发送控制键，用于中断当前运行的命令或程序。当检测到命令卡住、超时、或需要退出交互式程序时使用。',
        parameters: {
          type: 'object',
          properties: {
            key: {
              type: 'string',
              enum: ['ctrl+c', 'ctrl+d', 'ctrl+z', 'enter', 'q'],
              description: 'ctrl+c: 中断当前命令; ctrl+d: 发送EOF/退出; ctrl+z: 暂停到后台; enter: 发送回车; q: 发送q键(退出less/more等)'
            }
          },
          required: ['key']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'read_file',
        description: '读取文件内容',
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: '文件路径（绝对路径或相对于当前目录）'
            }
          },
          required: ['path']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'write_file',
        description: '写入或创建文件',
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: '文件路径'
            },
            content: {
              type: 'string',
              description: '文件内容'
            }
          },
          required: ['path', 'content']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'remember_info',
        description: `记住用户项目的关键路径。只在发现用户自定义的、非常规的配置或日志路径时使用。不要记录系统默认路径（如/etc/nginx/）或动态信息。`,
        parameters: {
          type: 'object',
          properties: {
            info: {
              type: 'string',
              description: '用户项目的关键路径（如"项目配置在/data/myapp/config/"）'
            }
          },
          required: ['info']
        }
      }
    }
  ]
}
