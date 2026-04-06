/**
 * 火山引擎（豆包）TTS Provider
 *
 * 调用 POST https://openspeech.bytedance.com/api/v1/tts
 * 认证：Bearer;{token}（注意分号分隔）
 * 响应：JSON { data: base64音频 }
 */

import * as https from 'https'
import * as http from 'http'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { SocksProxyAgent } from 'socks-proxy-agent'
import { v4 as uuidv4 } from 'uuid'
import type { TtsProvider, TtsSynthesizeOptions, TtsSynthesizeResult, TtsVoice, TtsAudioFormat } from './types'
import type { TtsSettings } from '@shared/types'
import { createLogger } from '../../utils/logger'

const log = createLogger('TTS:Volcengine')

let settingsGetter: (() => TtsSettings) | null = null
let proxyGetter: (() => { enabled: boolean; url: string } | undefined) | null = null

export function setVolcengineSettingsGetter(getter: () => TtsSettings): void {
  settingsGetter = getter
}

export function setVolcengineProxyGetter(getter: () => { enabled: boolean; url: string } | undefined): void {
  proxyGetter = getter
}

export class VolcengineTtsProvider implements TtsProvider {
  readonly id = 'volcengine-tts'
  readonly name = 'Volcengine TTS (豆包)'

  async synthesize(text: string, options: TtsSynthesizeOptions, signal?: AbortSignal): Promise<TtsSynthesizeResult> {
    if (!settingsGetter) throw new Error('TTS settings getter not configured')
    const settings = settingsGetter()
    const { apiUrl, apiKey } = settings

    if (!apiUrl) throw new Error('Volcengine TTS: API URL not configured')
    if (!apiKey) throw new Error('Volcengine TTS: Token not configured')

    const format: TtsAudioFormat = options.responseFormat ?? 'mp3'

    const appid = settings.model?.trim()
    if (!appid) throw new Error('Volcengine TTS: App ID not configured (fill in the "App ID" field)')

    const body = JSON.stringify({
      app: { appid, token: apiKey, cluster: 'volcano_tts' },
      user: { uid: 'sailfish' },
      audio: {
        voice_type: options.voice || settings.voice || 'zh_female_cancan_mars_bigtts',
        encoding: format === 'wav' ? 'wav' : 'mp3',
        speed_ratio: options.speed ?? settings.speed ?? 1.0,
      },
      request: {
        reqid: uuidv4(),
        text,
        text_type: 'plain',
        operation: 'query',
      },
    })

    const responseBody = await this.doRequest(apiUrl, apiKey, body, signal)

    let parsed: { data?: string; status_code?: number; status_text?: string; message?: string }
    try {
      parsed = JSON.parse(responseBody)
    } catch {
      throw new Error(`Volcengine TTS: Invalid JSON response`)
    }

    if (parsed.status_code && parsed.status_code !== 0) {
      throw new Error(`Volcengine TTS error (${parsed.status_code}): ${parsed.status_text || parsed.message || 'unknown'}`)
    }

    if (!parsed.data) {
      throw new Error('Volcengine TTS: No audio data in response')
    }

    const audio = Buffer.from(parsed.data, 'base64')
    return { audio, format: format === 'wav' ? 'wav' : 'mp3' }
  }

  async getVoices(): Promise<TtsVoice[]> {
    return [
      { id: 'zh_female_cancan_mars_bigtts', name: '灿灿 (Shiny)', language: 'zh' },
      { id: 'zh_male_xudong_conversation_wvae_bigtts', name: '快乐小东', language: 'zh' },
      { id: 'zh_female_qinqienvsheng_moon_bigtts', name: '亲切女声', language: 'zh' },
      { id: 'zh_female_peiqi_mars_bigtts', name: '佩奇猪', language: 'zh' },
    ]
  }

  private doRequest(apiUrl: string, token: string, body: string, signal?: AbortSignal): Promise<string> {
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
          'Authorization': `Bearer;${token}`,
        },
        agent: getProxyAgent(),
      }

      const req = transport.request(requestOptions, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf-8')
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`Volcengine TTS HTTP ${res.statusCode}: ${text.slice(0, 200)}`))
            return
          }
          resolve(text)
        })
        res.on('error', reject)
      })

      req.on('error', (err) => { if (!signal?.aborted) reject(err) })
      req.setTimeout(30_000, () => req.destroy(new Error('Volcengine TTS request timeout')))

      if (signal) {
        const onAbort = () => { req.destroy(new Error('TTS request aborted')); reject(new Error('TTS request aborted')) }
        if (signal.aborted) { onAbort(); return }
        signal.addEventListener('abort', onAbort, { once: true })
      }

      req.write(body)
      req.end()
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
