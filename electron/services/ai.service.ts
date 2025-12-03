import { ConfigService } from './config.service'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { SocksProxyAgent } from 'socks-proxy-agent'

export interface AiMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface AiProfile {
  id: string
  name: string
  apiUrl: string
  apiKey: string
  model: string
  proxy?: string
}

export class AiService {
  private configService: ConfigService
  private currentAbortController: AbortController | null = null

  constructor() {
    this.configService = new ConfigService()
  }

  /**
   * 中止当前请求
   */
  abort(): void {
    if (this.currentAbortController) {
      this.currentAbortController.abort()
      this.currentAbortController = null
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

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${profile.apiKey}`
    }

    try {
      // 使用 Node.js 原生 fetch（Electron 支持）
      const fetchOptions: RequestInit = {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody)
      }

      // 注意：原生 fetch 不直接支持代理，需要使用 node-fetch 或其他方案
      // 这里简化处理，生产环境可能需要更复杂的代理处理
      const response = await fetch(profile.apiUrl, fetchOptions)

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`AI API 请求失败: ${response.status} - ${errorText}`)
      }

      const data = (await response.json()) as {
        choices?: { message?: { content?: string } }[]
        error?: { message?: string }
      }

      if (data.error) {
        throw new Error(`AI API 错误: ${data.error.message}`)
      }

      return data.choices?.[0]?.message?.content || ''
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`AI 请求失败: ${error.message}`)
      }
      throw error
    }
  }

  /**
   * 发送聊天请求（流式）
   */
  async chatStream(
    messages: AiMessage[],
    onChunk: (chunk: string) => void,
    onDone: () => void,
    onError: (error: string) => void,
    profileId?: string
  ): Promise<void> {
    // 中止之前的请求
    this.abort()
    
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

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${profile.apiKey}`
    }

    // 创建 AbortController
    this.currentAbortController = new AbortController()

    try {
      const response = await fetch(profile.apiUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
        signal: this.currentAbortController.signal
      })

      if (!response.ok) {
        const errorText = await response.text()
        onError(`AI API 请求失败: ${response.status} - ${errorText}`)
        return
      }

      const reader = response.body?.getReader()
      if (!reader) {
        onError('无法读取响应流')
        return
      }

      const decoder = new TextDecoder()

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        const chunk = decoder.decode(value)
        const lines = chunk.split('\n').filter(line => line.trim())

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6)
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
      }

      onDone()
    } catch (error) {
      // 如果是中止请求，不算错误
      if (error instanceof Error && error.name === 'AbortError') {
        onDone()
        return
      }
      if (error instanceof Error) {
        onError(`AI 请求失败: ${error.message}`)
      } else {
        onError('AI 请求失败: 未知错误')
      }
    } finally {
      this.currentAbortController = null
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

