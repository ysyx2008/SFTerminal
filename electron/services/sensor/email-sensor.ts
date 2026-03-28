/**
 * Email Sensor - 邮件感知器（多账户）
 *
 * 为每个已配置的邮箱账户建立独立的 IMAP IDLE 长连接，监听新邮件到达。
 * 账户列表由 main.ts 在 email:syncAccounts 时同步过来。
 *
 * 工作流程（每个账户独立）：
 *   1. 连接 IMAP 服务器并选中 INBOX
 *   2. 从磁盘加载上次已知的 lastSeenUid，仅获取之后到达的新邮件
 *   3. 进入 IDLE 模式，等待服务器推送新邮件通知
 *   4. 收到新邮件时，获取邮件头信息，匹配 Watch 过滤规则
 *   5. 匹配成功则产生 email 事件投入 EventBus
 *   6. 连接断开时自动重连（指数退避），重连后补漏断线期间到达的邮件
 *
 * 状态持久化：
 *   - 每个账户的 lastSeenUid 持久化到 {userData}/email-sensor-state.json
 *   - 重启后从磁盘恢复，只处理上次之后的新邮件，避免旧未读邮件重复上报
 */
import type { Sensor, SensorEvent, EventBus } from './types'
import { createLogger } from '../../utils/logger'
import * as fs from 'fs'
import * as path from 'path'

const log = createLogger('EmailSensor')

interface EmailFilter {
  from?: string
  subject?: string
  unseen?: boolean
}

interface EmailTarget {
  watchId: string
  filter?: EmailFilter
}

export interface EmailAccountInfo {
  accountId: string
  email: string
  provider: string
  imapHost: string
  imapPort: number
  rejectUnauthorized?: boolean
}

export type EmailCredentialGetter = (accountId: string) => Promise<string | null>

interface AccountConnection {
  account: EmailAccountInfo
  imapClient: any
  connected: boolean
  reconnectTimer: NodeJS.Timeout | null
  reconnectDelay: number
  idleRefreshTimer: NodeJS.Timeout | null
  lastSeenUid: number
}

const MAX_RECONNECT_DELAY_MS = 5 * 60 * 1000
const INITIAL_RECONNECT_DELAY_MS = 5 * 1000
const IDLE_TIMEOUT_MS = 25 * 60 * 1000

interface PersistedState {
  accounts: Record<string, { lastSeenUid: number }>
}

let ImapFlowClass: any = null

async function loadImapFlow(): Promise<any> {
  if (!ImapFlowClass) {
    const mod = await import('imapflow')
    ImapFlowClass = mod.ImapFlow
  }
  return ImapFlowClass
}

export class EmailSensor implements Sensor {
  readonly id = 'email'
  readonly name = 'Email (IMAP IDLE)'

  private _running = false
  private eventBus: EventBus
  private targets: Map<string, EmailTarget> = new Map()

  private accounts: EmailAccountInfo[] = []
  private getCredential: EmailCredentialGetter | null = null
  private connections: Map<string, AccountConnection> = new Map()
  private statePath: string | null = null
  private persistedUids: Record<string, number> = {}

  get running(): boolean {
    return this._running
  }

  get connected(): boolean {
    for (const conn of this.connections.values()) {
      if (conn.connected) return true
    }
    return false
  }

  constructor(eventBus: EventBus) {
    this.eventBus = eventBus
  }

  /** 设置状态持久化路径（应在 start() 前调用） */
  setStatePath(userDataPath: string): void {
    this.statePath = path.join(userDataPath, 'email-sensor-state.json')
    this.loadState()
  }

  private loadState(): void {
    if (!this.statePath) return
    try {
      if (fs.existsSync(this.statePath)) {
        const data: PersistedState = JSON.parse(fs.readFileSync(this.statePath, 'utf-8'))
        this.persistedUids = {}
        for (const [id, info] of Object.entries(data.accounts || {})) {
          if (typeof info.lastSeenUid === 'number' && info.lastSeenUid > 0) {
            this.persistedUids[id] = info.lastSeenUid
          }
        }
        log.info(`Loaded persisted state for ${Object.keys(this.persistedUids).length} account(s)`)
      }
    } catch (err) {
      log.warn('Failed to load persisted state:', err)
    }
  }

  /** 将当前 UID 水位持久化到磁盘（由 EventPool 排水成功后调用） */
  saveState(): void {
    if (!this.statePath) return
    try {
      const state: PersistedState = { accounts: {} }
      for (const conn of this.connections.values()) {
        if (conn.lastSeenUid > 0) {
          state.accounts[conn.account.accountId] = { lastSeenUid: conn.lastSeenUid }
        }
      }
      fs.writeFileSync(this.statePath, JSON.stringify(state, null, 2))
    } catch (err) {
      log.warn('Failed to save persisted state:', err)
    }
  }

  /**
   * 配置监控的邮箱账户列表。
   * 如果 Sensor 已运行，会热更新连接（停掉移除的、启动新增的）。
   */
  async configureAccounts(accounts: EmailAccountInfo[], getCredential: EmailCredentialGetter): Promise<void> {
    this.getCredential = getCredential

    const oldIds = new Set(this.accounts.map(a => a.accountId))
    const newIds = new Set(accounts.map(a => a.accountId))

    const removed = this.accounts.filter(a => !newIds.has(a.accountId))
    const added = accounts.filter(a => !oldIds.has(a.accountId))

    this.accounts = accounts

    if (this._running) {
      for (const acct of removed) {
        await this.stopAccount(acct.accountId)
      }
      for (const acct of added) {
        await this.startAccount(acct)
      }
    }

    for (const acct of removed) {
      delete this.persistedUids[acct.accountId]
    }
    if (removed.length > 0) this.saveState()

    log.info(`Configured ${accounts.length} account(s) (added=${added.length}, removed=${removed.length})`)
  }

  /** 保留旧 API 兼容（单账户） */
  configure(account: EmailAccountInfo, getCredentialFn: () => Promise<string | null>): void {
    this.configureAccounts([account], async () => getCredentialFn())
  }

  addTarget(watchId: string, filter?: EmailFilter): void {
    this.targets.set(watchId, { watchId, filter })
  }

  removeTarget(watchId: string): void {
    this.targets.delete(watchId)
  }

  getTargetCount(): number {
    return this.targets.size
  }

  shouldAutoStart(): boolean {
    return this.accounts.length > 0 && this.getCredential !== null
  }

  async start(): Promise<void> {
    if (this._running) return
    if (!this.accounts.length || !this.getCredential) {
      log.info('No accounts configured, skipping start')
      return
    }
    this._running = true

    for (const acct of this.accounts) {
      await this.startAccount(acct)
    }
  }

  async stop(): Promise<void> {
    if (!this._running) return
    this._running = false

    this.saveState()

    const stopTasks = Array.from(this.connections.keys()).map(id => this.stopAccount(id))
    await Promise.all(stopTasks)

    log.info('Stopped')
  }

  getAccountStatuses(): Array<{ accountId: string; email: string; connected: boolean }> {
    return this.accounts.map(a => ({
      accountId: a.accountId,
      email: a.email,
      connected: this.connections.get(a.accountId)?.connected ?? false
    }))
  }

  // ==================== 单账户连接管理 ====================

  private async startAccount(account: EmailAccountInfo): Promise<void> {
    if (this.connections.has(account.accountId)) return

    const conn: AccountConnection = {
      account,
      imapClient: null,
      connected: false,
      reconnectTimer: null,
      reconnectDelay: INITIAL_RECONNECT_DELAY_MS,
      idleRefreshTimer: null,
      lastSeenUid: this.persistedUids[account.accountId] || 0
    }
    this.connections.set(account.accountId, conn)

    if (conn.lastSeenUid > 0) {
      log.info(`${account.email}: Restored lastSeenUid=${conn.lastSeenUid} from persisted state`)
    }

    await this.connectAccount(conn)
  }

  private async stopAccount(accountId: string): Promise<void> {
    const conn = this.connections.get(accountId)
    if (!conn) return

    this.clearAccountTimers(conn)
    await this.disconnectAccount(conn)
    this.connections.delete(accountId)

    log.info(`Account ${conn.account.email} stopped`)
  }

  private async connectAccount(conn: AccountConnection): Promise<void> {
    if (!this.getCredential) return

    const credential = await this.getCredential(conn.account.accountId)
    if (!credential) {
      log.error(`No credential for ${conn.account.email}`)
      return
    }

    try {
      const ImapFlow = await loadImapFlow()

      conn.imapClient = new ImapFlow({
        host: conn.account.imapHost,
        port: conn.account.imapPort,
        secure: true,
        auth: {
          user: conn.account.email,
          pass: credential
        },
        logger: false,
        tls: {
          rejectUnauthorized: conn.account.rejectUnauthorized !== false
        }
      })

      conn.imapClient.on('close', () => {
        conn.connected = false
        log.info(`${conn.account.email}: IMAP connection closed`)
        if (this._running && this.connections.has(conn.account.accountId)) {
          this.scheduleReconnect(conn)
        }
      })

      conn.imapClient.on('error', (err: Error) => {
        log.error(`${conn.account.email}: IMAP error:`, err.message)
      })

      await conn.imapClient.connect()
      conn.connected = true
      conn.reconnectDelay = INITIAL_RECONNECT_DELAY_MS

      log.info(`Connected to ${conn.account.email}`)
      this.startIdleLoop(conn).catch(err => {
        log.error(`${conn.account.email}: IDLE loop failed:`, err)
      })
    } catch (err) {
      log.error(`${conn.account.email}: Failed to connect:`, err)
      conn.connected = false
      if (this._running && this.connections.has(conn.account.accountId)) {
        this.scheduleReconnect(conn)
      }
    }
  }

  private async disconnectAccount(conn: AccountConnection): Promise<void> {
    if (conn.imapClient) {
      try {
        await conn.imapClient.logout()
      } catch { /* already closed */ }
      conn.imapClient = null
      conn.connected = false
    }
  }

  private async startIdleLoop(conn: AccountConnection): Promise<void> {
    if (!conn.imapClient || !this._running) return

    try {
      const lock = await conn.imapClient.getMailboxLock('INBOX')
      try {
        if (conn.lastSeenUid === 0) {
          // 首次运行（无持久化记录）：从当前最新 UID 开始，不扫描已有未读邮件
          const status = await conn.imapClient.status('INBOX', { uidNext: true })
          conn.lastSeenUid = (status.uidNext || 1) - 1
          this.saveState()
          log.info(`${conn.account.email}: First run, starting from UID ${conn.lastSeenUid}`)
        } else {
          // 有持久化记录或同一会话内重连：只获取上次之后的新邮件
          await this.checkNewMail(conn)
        }

        this.scheduleIdleRefresh(conn)
        await this.idleAndWait(conn)
      } finally {
        lock.release()
      }
    } catch (err) {
      log.error(`${conn.account.email}: IDLE loop error:`, err)
      if (this._running && this.connections.has(conn.account.accountId)) {
        this.scheduleReconnect(conn)
      }
    }
  }

  private async idleAndWait(conn: AccountConnection): Promise<void> {
    while (this._running && conn.imapClient?.usable) {
      try {
        await conn.imapClient.idle()
        await this.checkNewMail(conn)
      } catch (err: any) {
        if (err?.code === 'ECONNRESET' || err?.message?.includes('closed')) {
          break
        }
        log.error(`${conn.account.email}: IDLE error:`, err)
        break
      }
    }
  }

  private async checkNewMail(conn: AccountConnection): Promise<void> {
    if (!conn.imapClient?.usable) return

    try {
      for await (const msg of conn.imapClient.fetch(
        { uid: `${conn.lastSeenUid + 1}:*` },
        { envelope: true, uid: true }
      )) {
        if (msg.uid > conn.lastSeenUid) {
          conn.lastSeenUid = msg.uid
          this.emitMailEvents(conn, msg)
        }
      }
    } catch (err) {
      log.error(`${conn.account.email}: Check new mail error:`, err)
    }
  }

  private emitMailEvents(conn: AccountConnection, msg: any): void {
    const from = msg.envelope?.from?.[0]
    const fromAddr = from?.address || ''
    const fromName = from?.name || ''
    const subject = msg.envelope?.subject || ''

    for (const [watchId, target] of this.targets) {
      if (this.matchesFilter(target.filter, fromAddr, subject)) {
        const event: SensorEvent = {
          id: `em-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 6)}`,
          type: 'email',
          source: this.id,
          timestamp: Date.now(),
          watchId,
          payload: {
            uid: msg.uid,
            from: fromAddr,
            fromName,
            subject,
            date: msg.envelope?.date?.toISOString(),
            account: conn.account.email
          },
          priority: 'normal'
        }

        log.info(`${conn.account.email}: New email from ${fromAddr}: ${subject}`)
        this.eventBus.emit(event)
      }
    }
  }

  private matchesFilter(filter: EmailFilter | undefined, from: string, subject: string): boolean {
    if (!filter) return true
    if (filter.from && !from.toLowerCase().includes(filter.from.toLowerCase())) {
      return false
    }
    if (filter.subject && !subject.toLowerCase().includes(filter.subject.toLowerCase())) {
      return false
    }
    return true
  }

  // ==================== 定时器管理 ====================

  private scheduleReconnect(conn: AccountConnection): void {
    this.clearAccountTimers(conn)

    const delay = Math.min(conn.reconnectDelay, MAX_RECONNECT_DELAY_MS)
    log.info(`${conn.account.email}: Reconnecting in ${delay / 1000}s...`)

    conn.reconnectTimer = setTimeout(async () => {
      conn.reconnectTimer = null
      if (this._running && this.connections.has(conn.account.accountId)) {
        conn.reconnectDelay = Math.min(conn.reconnectDelay * 2, MAX_RECONNECT_DELAY_MS)
        await this.disconnectAccount(conn)
        await this.connectAccount(conn)
      }
    }, delay)
  }

  private scheduleIdleRefresh(conn: AccountConnection): void {
    if (conn.idleRefreshTimer) {
      clearInterval(conn.idleRefreshTimer)
    }
    conn.idleRefreshTimer = setInterval(async () => {
      if (conn.imapClient?.usable) {
        try {
          await conn.imapClient.noop()
        } catch {
          log.info(`${conn.account.email}: IDLE keepalive failed`)
        }
      }
    }, IDLE_TIMEOUT_MS)
  }

  private clearAccountTimers(conn: AccountConnection): void {
    if (conn.reconnectTimer) {
      clearTimeout(conn.reconnectTimer)
      conn.reconnectTimer = null
    }
    if (conn.idleRefreshTimer) {
      clearInterval(conn.idleRefreshTimer)
      conn.idleRefreshTimer = null
    }
  }
}
