import { v4 as uuidv4 } from 'uuid'
import type { BastionConfig, BastionSyncResult } from '@shared/types'
import type { ConfigService, SshSession, SessionGroup, JumpHostConfig } from './config.service'
import { createLogger } from '../utils/logger'

const log = createLogger('Bastion')

interface JumpServerAsset {
  id: string
  name: string
  address: string
  platform: { name: string }
  protocols: Array<{ name: string; port: number }>
  category: string
  type: string
  comment?: string
  is_active: boolean
  org_name?: string
}

interface JumpServerAuthResponse {
  token: string
  keyword?: string
  date_expired?: string
  user?: { id: string; name: string; username: string }
}

export class BastionService {
  constructor(private configService: ConfigService) {}

  private withTlsOverride<T>(ignoreSsl: boolean, fn: () => Promise<T>): Promise<T> {
    if (!ignoreSsl) return fn()
    const prev = process.env.NODE_TLS_REJECT_UNAUTHORIZED
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
    return fn().finally(() => {
      if (prev === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = prev
    })
  }

  async testConnection(config: BastionConfig): Promise<{ success: boolean; message: string; assetCount?: number }> {
    return this.withTlsOverride(config.rejectUnauthorized === false, async () => {
    try {
      const token = await this.authenticate(config.url, config.username, config.password)
      const firstPage = await this.fetchAssetsPage(config.url, token, 1, 0)
      const sshCount = this.countSshAssets(firstPage.results)
      const totalHint = firstPage.count !== undefined
        ? `（共 ${firstPage.count} 个资产，其中 ${sshCount} 个支持 SSH）`
        : `（找到 ${sshCount} 个 SSH 资产）`

      return { success: true, message: `连接成功${totalHint}`, assetCount: firstPage.count ?? sshCount }
    } catch (error: any) {
      const msg = this.formatError(error)
      log.error('Test connection failed:', msg)
      return { success: false, message: msg }
    }
    })
  }

  async syncAssets(config: BastionConfig): Promise<BastionSyncResult> {
    return this.withTlsOverride(config.rejectUnauthorized === false, async () => {
    try {
      const token = await this.authenticate(config.url, config.username, config.password)

      const allAssets = await this.fetchAllAssets(config.url, token)
      const sshAssets = allAssets.filter(a => a.is_active && a.protocols?.some(p => p.name === 'ssh'))

      if (sshAssets.length === 0) {
        return { success: true, added: 0, updated: 0, removed: 0, total: 0, groupId: '', groupName: '' }
      }

      const hostname = this.extractHostname(config.url)
      const groupName = `JumpServer (${hostname})`

      const groups: SessionGroup[] = this.configService.get('sessionGroups') || []
      const sessions: SshSession[] = this.configService.get('sshSessions') || []

      let group = groups.find(g => g.name === groupName)
      if (!group) {
        group = { id: uuidv4(), name: groupName, sortOrder: groups.length }
        groups.push(group)
      }

      if (config.autoJumpHost) {
        group.jumpHost = {
          host: hostname,
          port: config.jumpHostPort || 2222,
          username: config.username,
          authType: 'password',
          password: config.password
        } as JumpHostConfig
      }

      const groupSessions = sessions.filter(s => s.groupId === group!.id)

      let added = 0
      let updated = 0

      for (const asset of sshAssets) {
        const sshProto = asset.protocols.find(p => p.name === 'ssh')
        const port = sshProto?.port || 22

        const existing = groupSessions.find(s => s.host === asset.address)

        if (existing) {
          existing.name = asset.name
          existing.port = port
          updated++
        } else {
          const newSession: SshSession = {
            id: uuidv4(),
            name: asset.name,
            host: asset.address,
            port,
            username: '',
            authType: 'password',
            groupId: group.id,
            sortOrder: sessions.length
          }
          sessions.push(newSession)
          added++
        }
      }

      const assetAddresses = new Set(sshAssets.map(a => a.address))
      const removed = groupSessions.filter(s => !assetAddresses.has(s.host)).length

      this.configService.set('sessionGroups', groups)
      this.configService.set('sshSessions', sessions)

      log.info(`Sync completed: added=${added}, updated=${updated}, removed=${removed}, total=${sshAssets.length}`)
      return { success: true, added, updated, removed, total: sshAssets.length, groupId: group.id, groupName }
    } catch (error: any) {
      const msg = this.formatError(error)
      log.error('Sync failed:', msg)
      return { success: false, error: msg, added: 0, updated: 0, removed: 0, total: 0, groupId: '', groupName: '' }
    }
    })
  }

  private async authenticate(baseUrl: string, username: string, password: string): Promise<string> {
    const url = `${this.normalizeUrl(baseUrl)}/api/v1/authentication/auth/`
    const resp = await this.httpPost<JumpServerAuthResponse>(url, { username, password })
    if (!resp.token) {
      throw new Error('认证失败：未返回 token（可能需要 MFA 验证）')
    }
    return resp.token
  }

  private async fetchAssetsPage(baseUrl: string, token: string, limit: number, offset: number): Promise<{ count?: number; results: JumpServerAsset[] }> {
    const url = `${this.normalizeUrl(baseUrl)}/api/v1/perms/users/self/assets/?limit=${limit}&offset=${offset}`
    return this.httpGet(url, token)
  }

  private async fetchAllAssets(baseUrl: string, token: string): Promise<JumpServerAsset[]> {
    const pageSize = 100
    const maxPages = 100
    const all: JumpServerAsset[] = []
    let offset = 0

    for (let page = 0; page < maxPages; page++) {
      const resp = await this.fetchAssetsPage(baseUrl, token, pageSize, offset)
      if (!resp.results?.length) break
      all.push(...resp.results)

      if (resp.count !== undefined && all.length >= resp.count) break
      if (resp.results.length < pageSize) break
      offset += pageSize
    }

    return all
  }

  private countSshAssets(assets: JumpServerAsset[]): number {
    return assets.filter(a => a.is_active && a.protocols?.some(p => p.name === 'ssh')).length
  }

  private async httpGet<T>(url: string, token: string): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 15000)
    try {
      const resp = await fetch(url, {
        signal: controller.signal,
        headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' }
      })
      if (!resp.ok) {
        const body = await resp.text().catch(() => '')
        throw new Error(`HTTP ${resp.status}: ${body || resp.statusText}`)
      }
      return await resp.json() as T
    } finally {
      clearTimeout(timer)
    }
  }

  private async httpPost<T>(url: string, body: Record<string, unknown>): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 15000)
    try {
      const resp = await fetch(url, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify(body)
      })
      if (!resp.ok) {
        const text = await resp.text().catch(() => '')
        throw new Error(`HTTP ${resp.status}: ${text || resp.statusText}`)
      }
      return await resp.json() as T
    } finally {
      clearTimeout(timer)
    }
  }

  private normalizeUrl(url: string): string {
    return url.replace(/\/+$/, '')
  }

  private extractHostname(url: string): string {
    try {
      return new URL(url).hostname
    } catch {
      return url.replace(/^https?:\/\//, '').split(/[:/]/)[0]
    }
  }

  private formatError(error: any): string {
    if (error?.name === 'AbortError') return '连接超时'
    const causeCode = error?.cause?.code
    const causeMsg = error?.cause?.message || ''
    if (causeCode === 'ECONNREFUSED') return '连接被拒绝，请检查地址'
    if (causeCode === 'ENOTFOUND') return 'DNS 解析失败，请检查地址'
    if (causeCode === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' || causeCode === 'SELF_SIGNED_CERT_IN_CHAIN' ||
        causeCode === 'DEPTH_ZERO_SELF_SIGNED_CERT' || causeCode === 'ERR_TLS_CERT_ALTNAME_INVALID' ||
        causeMsg.includes('self-signed') || /certificate.*verif/i.test(causeMsg)) {
      return 'SSL 证书验证失败（可能是自签名证书），请在下方开启「忽略 SSL 证书错误」'
    }
    const msg = error?.message || String(error)
    if (msg.includes('fetch failed')) return `连接失败：${causeMsg || causeCode || '请检查地址是否正确'}`
    if (msg.includes('401')) return '认证失败，请检查用户名和密码'
    if (msg.includes('403')) return '权限不足'
    return msg
  }
}
