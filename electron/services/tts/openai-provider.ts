/**
 * OpenAI 兼容 TTS Provider
 *
 * 调用 POST /v1/audio/speech（OpenAI 标准格式）。
 * 兼容所有实现了此接口的服务商（火山引擎、硅基流动、minimax 等），
 * 用户只需填不同的 API URL 和 Key。
 */

import * as https from 'https'
import * as http from 'http'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { SocksProxyAgent } from 'socks-proxy-agent'
import type { TtsProvider, TtsSynthesizeOptions, TtsSynthesizeResult, TtsVoice, TtsAudioFormat } from './types'
import type { TtsSettings } from '@shared/types'
import { createLogger } from '../../utils/logger'

const log = createLogger('TTS:OpenAI')

/** 外部注入的 getter，避免循环依赖 */
let settingsGetter: (() => TtsSettings) | null = null
let proxyGetter: (() => { enabled: boolean; url: string } | undefined) | null = null

export function setSettingsGetter(getter: () => TtsSettings): void {
  settingsGetter = getter
}

export function setProxyGetter(getter: () => { enabled: boolean; url: string } | undefined): void {
  proxyGetter = getter
}

export class OpenAICompatTtsProvider implements TtsProvider {
  readonly id = 'openai-compat'
  readonly name = 'OpenAI Compatible TTS'

  async synthesize(text: string, options: TtsSynthesizeOptions, signal?: AbortSignal): Promise<TtsSynthesizeResult> {
    if (!settingsGetter) throw new Error('TTS settings getter not configured')
    const settings = settingsGetter()
    const { apiUrl, apiKey } = settings

    if (!apiUrl) throw new Error('TTS API URL not configured')
    if (!apiKey) throw new Error('TTS API Key not configured')

    const format: TtsAudioFormat = options.responseFormat ?? 'mp3'

    const body = JSON.stringify({
      model: options.model || settings.model || 'tts-1',
      input: text,
      voice: options.voice || settings.voice || 'alloy',
      speed: options.speed ?? settings.speed ?? 1.0,
      response_format: format,
    })

    const audio = await this.doRequest(apiUrl, apiKey, body, signal)

    return { audio, format }
  }

  async getVoices(): Promise<TtsVoice[]> {
    return [
      { id: 'alloy', name: 'Alloy', language: 'en' },
      { id: 'ash', name: 'Ash', language: 'en' },
      { id: 'ballad', name: 'Ballad', language: 'en' },
      { id: 'coral', name: 'Coral', language: 'en' },
      { id: 'echo', name: 'Echo', language: 'en' },
      { id: 'fable', name: 'Fable', language: 'en' },
      { id: 'nova', name: 'Nova', language: 'en' },
      { id: 'onyx', name: 'Onyx', language: 'en' },
      { id: 'sage', name: 'Sage', language: 'en' },
      { id: 'shimmer', name: 'Shimmer', language: 'en' },
    ]
  }

  private doRequest(apiUrl: string, apiKey: string, body: string, signal?: AbortSignal): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error('TTS request aborted'))
        return
      }

      const url = new URL(apiUrl)
      const isHttps = url.protocol === 'https:'
      const transport = isHttps ? https : http

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(body)),
        'Authorization': `Bearer ${apiKey}`,
      }

      const requestOptions: https.RequestOptions = {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers,
        agent: this.getProxyAgent(),
      }

      const req = transport.request(requestOptions, (res) => {
        if (res.statusCode && res.statusCode >= 400) {
          const chunks: Buffer[] = []
          res.on('data', (chunk: Buffer) => chunks.push(chunk))
          res.on('end', () => {
            const errorBody = Buffer.concat(chunks).toString('utf-8')
            let errorMsg: string
            try {
              const parsed = JSON.parse(errorBody)
              errorMsg = parsed.error?.message || parsed.message || errorBody
            } catch {
              errorMsg = errorBody
            }
            reject(new Error(`TTS API error (${res.statusCode}): ${errorMsg}`))
          })
          return
        }

        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => {
          resolve(Buffer.concat(chunks))
        })
        res.on('error', reject)
      })

      req.on('error', (err) => {
        if (!signal?.aborted) reject(err)
      })

      req.setTimeout(30_000, () => {
        req.destroy(new Error('TTS request timeout'))
      })

      if (signal) {
        const onAbort = () => {
          req.destroy(new Error('TTS request aborted'))
          reject(new Error('TTS request aborted'))
        }
        if (signal.aborted) {
          onAbort()
          return
        }
        signal.addEventListener('abort', onAbort, { once: true })
      }

      req.write(body)
      req.end()
    })
  }

  private getProxyAgent(): https.Agent | undefined {
    try {
      const proxy = proxyGetter?.()
      if (proxy?.enabled && proxy.url) {
        if (proxy.url.startsWith('socks')) {
          return new SocksProxyAgent(proxy.url) as unknown as https.Agent
        }
        return new HttpsProxyAgent(proxy.url) as unknown as https.Agent
      }
    } catch (err) {
      log.warn('Failed to get proxy settings:', err)
    }
    return undefined
  }
}
