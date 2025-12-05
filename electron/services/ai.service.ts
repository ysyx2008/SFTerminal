import { ConfigService } from './config.service'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { SocksProxyAgent } from 'socks-proxy-agent'
import * as https from 'https'
import * as http from 'http'

export interface AiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  tool_call_id?: string  // 用于 tool 角色的消息
  tool_calls?: ToolCall[]  // 用于 assistant 角色的工具调用
}

// Tool Calling 相关类型
export interface ToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: {
      type: 'object'
      properties: Record<string, {
        type: string
        description: string
        enum?: string[]
      }>
      required?: string[]
    }
  }
}

export interface ToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string  // JSON 字符串
  }
}

export interface ChatWithToolsResult {
  content?: string
  tool_calls?: ToolCall[]
  finish_reason?: 'stop' | 'tool_calls' | 'length'
}

export interface AiProfile {
  id: string
  name: string
  apiUrl: string
  apiKey: string
  model: string
  proxy?: string
  contextLength?: number  // 模型上下文长度（tokens），默认 8000
}

export class AiService {
  private configService: ConfigService
  // 使用 Map 存储多个请求的 AbortController，支持多个终端同时请求
  private abortControllers: Map<string, AbortController> = new Map()

  constructor() {
    this.configService = new ConfigService()
  }

  /**
   * 中止指定请求，如果不传 requestId 则中止所有请求
   */
  abort(requestId?: string): void {
    if (requestId) {
      const controller = this.abortControllers.get(requestId)
      if (controller) {
        controller.abort()
        this.abortControllers.delete(requestId)
      }
    } else {
      // 中止所有请求
      this.abortControllers.forEach(controller => controller.abort())
      this.abortControllers.clear()
    }
  }

  /**
   * 获取代理 Agent
   */
  private getProxyAgent(proxyUrl: string): HttpsProxyAgent<string> | SocksProxyAgent | undefined {
    if (!proxyUrl) return undefined

    if (proxyUrl.startsWith('socks')) {
      return new SocksProxyAgent(proxyUrl)
    } else {
      return new HttpsProxyAgent(proxyUrl)
    }
  }

  /**
   * 获取当前 AI Profile
   */
  private async getCurrentProfile(profileId?: string): Promise<AiProfile | null> {
    const profiles = this.configService.getAiProfiles()
    if (profiles.length === 0) return null

    if (profileId) {
      return profiles.find(p => p.id === profileId) || null
    }

    const activeId = this.configService.getActiveAiProfile()
    if (activeId) {
      return profiles.find(p => p.id === activeId) || profiles[0]
    }

    return profiles[0]
  }

  /**
   * 发送聊天请求（非流式）
   */
  async chat(messages: AiMessage[], profileId?: string): Promise<string> {
    const profile = await this.getCurrentProfile(profileId)
    if (!profile) {
      throw new Error('未配置 AI 模型，请先在设置中添加 AI 配置')
    }

    const requestBody = {
      model: profile.model,
      messages,
      temperature: 0.7,
      max_tokens: 2048
    }

    try {
      const data = await this.makeRequest<{
        choices?: { message?: { content?: string } }[]
        error?: { message?: string; code?: string; type?: string }
      }>(profile, requestBody)

      if (data.error) {
        // 检测上下文超限错误
        const errorMsg = data.error.message?.toLowerCase() || ''
        const errorCode = data.error.code?.toLowerCase() || ''
        
        if (errorMsg.includes('context_length') || 
            errorMsg.includes('maximum context') ||
            (errorMsg.includes('token') && errorMsg.includes('limit')) ||
            errorCode.includes('context_length')) {
          throw new Error(`上下文超出模型限制。请清除部分对话历史后重试。`)
        }
        
        throw new Error(`AI API 错误: ${data.error.message}`)
      }

      return data.choices?.[0]?.message?.content || ''
    } catch (error) {
      if (error instanceof Error) {
        if (error.message.includes('上下文超出')) {
          throw error
        }
        const msg = error.message.toLowerCase()
        if (msg.includes('context_length') || 
            msg.includes('maximum context') ||
            (msg.includes('token') && msg.includes('limit'))) {
          throw new Error(`上下文超出模型限制。请清除部分对话历史后重试。`)
        }
        throw new Error(`AI 请求失败: ${error.message}`)
      }
      throw error
    }
  }

  /**
   * 发送 HTTP 请求（支持代理）
   */
  private makeRequest<T>(profile: AiProfile, body: object, signal?: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
      const url = new URL(profile.apiUrl)
      const isHttps = url.protocol === 'https:'
      const httpModule = isHttps ? https : http

      const options: https.RequestOptions = {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${profile.apiKey}`
        }
      }

      // 应用代理
      if (profile.proxy) {
        options.agent = this.getProxyAgent(profile.proxy)
      }

      const req = httpModule.request(options, (res) => {
        let data = ''
        res.on('data', (chunk) => {
          data += chunk
        })
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(JSON.parse(data))
            } catch {
              reject(new Error(`响应解析失败: ${data}`))
            }
          } else {
            reject(new Error(`AI API 请求失败: ${res.statusCode} - ${data}`))
          }
        })
      })

      req.on('error', (err) => {
        reject(new Error(`请求错误: ${err.message}`))
      })

      // 支持中止请求
      if (signal) {
        signal.addEventListener('abort', () => {
          req.destroy()
          reject(new Error('请求已中止'))
        })
      }

      req.write(JSON.stringify(body))
      req.end()
    })
  }

  /**
   * 发送聊天请求（流式，支持代理）
   * @param requestId 请求 ID，用于支持多个终端同时请求
   */
  async chatStream(
    messages: AiMessage[],
    onChunk: (chunk: string) => void,
    onDone: () => void,
    onError: (error: string) => void,
    profileId?: string,
    requestId?: string
  ): Promise<void> {
    const profile = await this.getCurrentProfile(profileId)
    if (!profile) {
      onError('未配置 AI 模型，请先在设置中添加 AI 配置')
      return
    }

    const requestBody = {
      model: profile.model,
      messages,
      temperature: 0.7,
      max_tokens: 2048,
      stream: true
    }

    // 创建 AbortController，使用 requestId 或生成一个唯一 ID
    const reqId = requestId || `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
    const abortController = new AbortController()
    this.abortControllers.set(reqId, abortController)

    try {
      const url = new URL(profile.apiUrl)
      const isHttps = url.protocol === 'https:'
      const httpModule = isHttps ? https : http

      const options: https.RequestOptions = {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${profile.apiKey}`
        }
      }

      // 应用代理
      if (profile.proxy) {
        options.agent = this.getProxyAgent(profile.proxy)
      }

      const req = httpModule.request(options, (res) => {
        if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
          let errorData = ''
          res.on('data', (chunk) => { errorData += chunk })
          res.on('end', () => {
            // 检测上下文超限错误
            const errorLower = errorData.toLowerCase()
            if (errorLower.includes('context_length') || 
                errorLower.includes('maximum context') ||
                (errorLower.includes('token') && errorLower.includes('limit')) ||
                errorLower.includes('too many tokens')) {
              onError(`上下文超出模型限制。请清除部分对话历史后重试。`)
            } else {
              onError(`AI API 请求失败: ${res.statusCode} - ${errorData}`)
            }
          })
          return
        }

        let buffer = ''

        res.on('data', (chunk: Buffer) => {
          buffer += chunk.toString()
          const lines = buffer.split('\n')
          // 保留最后一个可能不完整的行
          buffer = lines.pop() || ''

          for (const line of lines) {
            const trimmedLine = line.trim()
            if (!trimmedLine) continue

            if (trimmedLine.startsWith('data: ')) {
              const data = trimmedLine.slice(6)
              if (data === '[DONE]') {
                onDone()
                return
              }

              try {
                const parsed = JSON.parse(data) as {
                  choices?: { delta?: { content?: string } }[]
                }
                const content = parsed.choices?.[0]?.delta?.content
                if (content) {
                  onChunk(content)
                }
              } catch {
                // 忽略解析错误
              }
            }
          }
        })

        res.on('end', () => {
          onDone()
        })

        res.on('error', (err) => {
          onError(`响应错误: ${err.message}`)
        })
      })

      req.on('error', (err) => {
        if (err.message === '请求已中止') {
          onDone()
          return
        }
        onError(`请求错误: ${err.message}`)
      })

      // 支持中止请求
      abortController.signal.addEventListener('abort', () => {
        req.destroy()
      })

      req.write(JSON.stringify(requestBody))
      req.end()
    } catch (error) {
      if (error instanceof Error) {
        onError(`AI 请求失败: ${error.message}`)
      } else {
        onError('AI 请求失败: 未知错误')
      }
    }
  }

  /**
   * 发送带工具调用的聊天请求（非流式）
   * 用于 Agent 模式，支持 function calling
   */
  async chatWithTools(
    messages: AiMessage[],
    tools: ToolDefinition[],
    profileId?: string
  ): Promise<ChatWithToolsResult> {
    const profile = await this.getCurrentProfile(profileId)
    if (!profile) {
      throw new Error('未配置 AI 模型，请先在设置中添加 AI 配置')
    }

    // 转换消息格式，处理 tool_calls
    const formattedMessages = messages.map(msg => {
      if (msg.role === 'tool') {
        return {
          role: 'tool' as const,
          content: msg.content,
          tool_call_id: msg.tool_call_id
        }
      }
      if (msg.role === 'assistant' && msg.tool_calls) {
        return {
          role: 'assistant' as const,
          content: msg.content || null,
          tool_calls: msg.tool_calls
        }
      }
      return {
        role: msg.role,
        content: msg.content
      }
    })

    const requestBody = {
      model: profile.model,
      messages: formattedMessages,
      tools: tools.length > 0 ? tools : undefined,
      tool_choice: tools.length > 0 ? 'auto' : undefined,
      temperature: 0.7,
      max_tokens: 4096
    }

    try {
      const data = await this.makeRequest<{
        choices?: {
          message?: {
            content?: string | null
            tool_calls?: ToolCall[]
          }
          finish_reason?: string
        }[]
        error?: { message?: string; code?: string; type?: string }
      }>(profile, requestBody)

      if (data.error) {
        // 检测上下文超限错误
        const errorMsg = data.error.message?.toLowerCase() || ''
        const errorCode = data.error.code?.toLowerCase() || ''
        const errorType = data.error.type?.toLowerCase() || ''
        
        if (errorMsg.includes('context_length') || 
            errorMsg.includes('maximum context') ||
            errorMsg.includes('token') && errorMsg.includes('limit') ||
            errorMsg.includes('too many tokens') ||
            errorMsg.includes('too long') ||
            errorCode.includes('context_length') ||
            errorType.includes('context_length')) {
          throw new Error(`上下文超出模型限制。请清除部分对话历史后重试。\n原始错误: ${data.error.message}`)
        }
        
        throw new Error(`AI API 错误: ${data.error.message}`)
      }

      const choice = data.choices?.[0]
      if (!choice) {
        throw new Error('AI 返回结果为空')
      }

      return {
        content: choice.message?.content || undefined,
        tool_calls: choice.message?.tool_calls,
        finish_reason: choice.finish_reason as ChatWithToolsResult['finish_reason']
      }
    } catch (error) {
      if (error instanceof Error) {
        // 如果已经是格式化的错误，直接抛出
        if (error.message.includes('上下文超出')) {
          throw error
        }
        // 再次检测错误消息中的上下文超限
        const msg = error.message.toLowerCase()
        if (msg.includes('context_length') || 
            msg.includes('maximum context') ||
            (msg.includes('token') && msg.includes('limit'))) {
          throw new Error(`上下文超出模型限制。请清除部分对话历史后重试。`)
        }
        throw new Error(`AI 请求失败: ${error.message}`)
      }
      throw error
    }
  }

  /**
   * 带工具的聊天（流式）
   * 用于 Agent 模式，支持 function calling 和流式输出
   */
  async chatWithToolsStream(
    messages: AiMessage[],
    tools: ToolDefinition[],
    onChunk: (chunk: string) => void,
    onToolCall: (toolCalls: ToolCall[]) => void,
    onDone: (result: ChatWithToolsResult) => void,
    onError: (error: string) => void,
    profileId?: string
  ): Promise<void> {
    const profile = await this.getCurrentProfile(profileId)
    if (!profile) {
      onError('未配置 AI 模型，请先在设置中添加 AI 配置')
      return
    }

    // 转换消息格式
    const formattedMessages = messages.map(msg => {
      if (msg.role === 'tool') {
        return {
          role: 'tool' as const,
          content: msg.content,
          tool_call_id: msg.tool_call_id
        }
      }
      if (msg.role === 'assistant' && msg.tool_calls) {
        return {
          role: 'assistant' as const,
          content: msg.content || null,
          tool_calls: msg.tool_calls
        }
      }
      return {
        role: msg.role,
        content: msg.content
      }
    })

    const requestBody = {
      model: profile.model,
      messages: formattedMessages,
      tools: tools.length > 0 ? tools : undefined,
      tool_choice: tools.length > 0 ? 'auto' : undefined,
      temperature: 0.7,
      max_tokens: 4096,
      stream: true
    }

    try {
      const url = new URL(profile.apiUrl)
      const isHttps = url.protocol === 'https:'
      const httpModule = isHttps ? https : http

      const options: https.RequestOptions = {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${profile.apiKey}`
        }
      }

      if (profile.proxy) {
        options.agent = this.getProxyAgent(profile.proxy)
      }

      let content = ''
      let toolCalls: ToolCall[] = []
      let finishReason: string | undefined

      const req = httpModule.request(options, (res) => {
        let buffer = ''

        res.on('data', (chunk: Buffer) => {
          buffer += chunk.toString()
          const lines = buffer.split('\n')
          buffer = lines.pop() || ''

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const data = line.slice(6).trim()
              if (data === '[DONE]') {
                onDone({
                  content: content || undefined,
                  tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
                  finish_reason: finishReason as ChatWithToolsResult['finish_reason']
                })
                return
              }

              try {
                const json = JSON.parse(data)
                const delta = json.choices?.[0]?.delta
                const reason = json.choices?.[0]?.finish_reason

                if (reason) {
                  finishReason = reason
                }

                if (delta?.content) {
                  content += delta.content
                  onChunk(delta.content)
                }

                // 处理 tool_calls 流式更新
                if (delta?.tool_calls) {
                  for (const tc of delta.tool_calls) {
                    const index = tc.index ?? 0
                    if (!toolCalls[index]) {
                      toolCalls[index] = {
                        id: tc.id || '',
                        type: 'function',
                        function: {
                          name: tc.function?.name || '',
                          arguments: tc.function?.arguments || ''
                        }
                      }
                    } else {
                      if (tc.function?.arguments) {
                        toolCalls[index].function.arguments += tc.function.arguments
                      }
                    }
                  }
                }
              } catch {
                // 忽略解析错误
              }
            }
          }
        })

        res.on('end', () => {
          // 如果有工具调用，通知一次
          if (toolCalls.length > 0) {
            onToolCall(toolCalls)
          }
          onDone({
            content: content || undefined,
            tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
            finish_reason: finishReason as ChatWithToolsResult['finish_reason']
          })
        })

        res.on('error', (err) => {
          onError(`请求错误: ${err.message}`)
        })
      })

      req.on('error', (err) => {
        onError(`请求失败: ${err.message}`)
      })

      req.write(JSON.stringify(requestBody))
      req.end()
    } catch (error) {
      if (error instanceof Error) {
        onError(`AI 请求失败: ${error.message}`)
      } else {
        onError('AI 请求失败')
      }
    }
  }

  /**
   * 生成命令解释的 prompt
   */
  static getExplainCommandPrompt(command: string): AiMessage[] {
    return [
      {
        role: 'system',
        content:
          '你是一个专业的 Linux/Unix 系统管理员助手。用户会给你一个命令，请用中文简洁地解释这个命令的作用、参数含义，以及可能的注意事项。'
      },
      {
        role: 'user',
        content: `请解释这个命令：\n\`\`\`\n${command}\n\`\`\``
      }
    ]
  }

  /**
   * 生成错误诊断的 prompt
   */
  static getDiagnoseErrorPrompt(error: string, context?: string): AiMessage[] {
    return [
      {
        role: 'system',
        content:
          '你是一个专业的运维工程师助手。用户会给你一个错误信息，请用中文分析错误原因，并提供可能的解决方案。'
      },
      {
        role: 'user',
        content: `请分析这个错误并提供解决方案：\n\`\`\`\n${error}\n\`\`\`${context ? `\n\n上下文信息：\n${context}` : ''}`
      }
    ]
  }

  /**
   * 生成自然语言转命令的 prompt
   */
  static getNaturalToCommandPrompt(description: string, os?: string): AiMessage[] {
    return [
      {
        role: 'system',
        content: `你是一个专业的命令行助手。用户会用自然语言描述他想做的事情，请生成对应的命令。${os ? `当前操作系统是 ${os}。` : ''}请只返回命令本身，如果有多个命令请用换行分隔，不需要额外解释。`
      },
      {
        role: 'user',
        content: description
      }
    ]
  }
}

