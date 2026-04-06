/**
 * 阿里云 DashScope（通义千问）TTS Provider
 *
 * 非流式：POST /api/v1/services/aigc/multimodal-generation/generation
 * 响应包含 output.audio.url（WAV 文件链接，24h 有效）
 * 下载该 URL 得到最终音频。
 */

import * as https from 'https'
import * as http from 'http'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { SocksProxyAgent } from 'socks-proxy-agent'
import type { TtsProvider, TtsSynthesizeOptions, TtsSynthesizeResult, TtsVoice } from './types'
import type { TtsSettings } from '@shared/types'
import { createLogger } from '../../utils/logger'

const log = createLogger('TTS:DashScope')

let settingsGetter: (() => TtsSettings) | null = null
let proxyGetter: (() => { enabled: boolean; url: string } | undefined) | null = null

export function setDashScopeSettingsGetter(getter: () => TtsSettings): void {
  settingsGetter = getter
}

export function setDashScopeProxyGetter(getter: () => { enabled: boolean; url: string } | undefined): void {
  proxyGetter = getter
}

export class DashScopeTtsProvider implements TtsProvider {
  readonly id = 'dashscope-tts'
  readonly name = 'DashScope TTS (通义千问)'

  async synthesize(text: string, options: TtsSynthesizeOptions, signal?: AbortSignal): Promise<TtsSynthesizeResult> {
    if (!settingsGetter) throw new Error('TTS settings getter not configured')
    const settings = settingsGetter()
    const { apiUrl, apiKey } = settings

    if (!apiUrl) throw new Error('DashScope TTS: API URL not configured')
    if (!apiKey) throw new Error('DashScope TTS: API Key not configured')

    const body = JSON.stringify({
      model: options.model || settings.model || 'qwen3-tts-flash',
      input: {
        text,
        voice: options.voice || settings.voice || 'Cherry',
      },
    })

    const responseBody = await this.doRequest(apiUrl, apiKey, body, signal)

    let parsed: {
      status_code?: number
      code?: string
      message?: string
      output?: { audio?: { url?: string; data?: string } }
    }
    try {
      parsed = JSON.parse(responseBody)
    } catch {
      throw new Error('DashScope TTS: Invalid JSON response')
    }

    if (parsed.status_code && parsed.status_code >= 400) {
      throw new Error(`DashScope TTS error (${parsed.code || parsed.status_code}): ${parsed.message || 'unknown'}`)
    }

    const audioUrl = parsed.output?.audio?.url
    if (!audioUrl) {
      throw new Error('DashScope TTS: No audio URL in response')
    }

    const audio = await this.downloadAudio(audioUrl, signal)
    return { audio, format: 'wav' }
  }

  async getVoices(): Promise<TtsVoice[]> {
    return [
      { id: 'Cherry', name: '芊悦 (Cherry)', language: 'zh,en' },
      { id: 'Ethan', name: '晨煦 (Ethan)', language: 'zh,en' },
      { id: 'Nofish', name: '不吃鱼 (Nofish)', language: 'zh,en' },
      { id: 'Ryan', name: '甜茶 (Ryan)', language: 'zh,en' },
      { id: 'Katerina', name: '卡捷琳娜 (Katerina)', language: 'zh,en' },
      { id: 'Elias', name: '墨讲师 (Elias)', language: 'zh,en' },
    ]
  }

  private doRequest(apiUrl: string, apiKey: string, body: string, signal?: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(new Error('TTS request aborted')); return }

      const url = new URL(apiUrl)
      const isHttps = url.protocol === 'https:'
      const transport = isHttps ? https : http

      const requestOptions: https.RequestOptions = {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'Authorization': `Bearer ${apiKey}`,
        },
        agent: getProxyAgent(),
      }

      const req = transport.request(requestOptions, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf-8')
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`DashScope TTS HTTP ${res.statusCode}: ${text.slice(0, 200)}`))
            return
          }
          resolve(text)
        })
        res.on('error', reject)
      })

      req.on('error', (err) => { if (!signal?.aborted) reject(err) })
      req.setTimeout(30_000, () => req.destroy(new Error('DashScope TTS request timeout')))

      if (signal) {
        const onAbort = () => { req.destroy(new Error('TTS request aborted')); reject(new Error('TTS request aborted')) }
        if (signal.aborted) { onAbort(); return }
        signal.addEventListener('abort', onAbort, { once: true })
      }

      req.write(body)
      req.end()
    })
  }

  private downloadAudio(audioUrl: string, signal?: AbortSignal): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(new Error('TTS request aborted')); return }

      const url = new URL(audioUrl)
      const isHttps = url.protocol === 'https:'
      const transport = isHttps ? https : http

      const agent = getProxyAgent()
      const getOptions = agent ? { agent } : undefined
      const req = transport.get(audioUrl, getOptions || {}, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          this.downloadAudio(res.headers.location, signal).then(resolve, reject)
          return
        }
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`DashScope TTS: Failed to download audio (${res.statusCode})`))
          return
        }
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => resolve(Buffer.concat(chunks)))
        res.on('error', reject)
      })

      req.on('error', (err) => { if (!signal?.aborted) reject(err) })
      req.setTimeout(30_000, () => req.destroy(new Error('DashScope TTS: Audio download timeout')))

      if (signal) {
        const onAbort = () => { req.destroy(new Error('TTS request aborted')); reject(new Error('TTS request aborted')) }
        if (signal.aborted) { onAbort(); return }
        signal.addEventListener('abort', onAbort, { once: true })
      }
    })
  }
}

function getProxyAgent(): https.Agent | undefined {
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
