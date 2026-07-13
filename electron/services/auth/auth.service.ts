/**
 * 应用 SSO AuthService（OAuth2/OIDC）
 *
 * - features.sso === false 时所有入口拒绝 / no-op
 * - 与邮箱/飞书 OAuth 分离（本模块只做应用身份登录）
 * - refreshToken 经 credential.service 加密落盘；渲染进程只拿脱敏会话 + 按需 accessToken
 */
import { createLogger } from '../../utils/logger'
import { isOemFeatureEnabled } from '@shared/oem-features'
import { oemConfig } from '@shared/oem.config'
import type { OemSsoConfig, OemSsoGateMode, OemSsoVerifyIdToken } from '@shared/oem-types'
import type { AuthPublicSession, AuthSession, AuthTokens, OidcDiscoveryDocument } from '@shared/types'
import { getDefaultCredentialService } from '../credential.service'
import { openSsoLoginWindow } from './login-window'
import {
  authUserFromIdToken,
  buildAuthorizeUrl,
  discoveryUrl,
  generateCodeChallenge,
  generateCodeVerifier,
  generateOAuthState,
  hostMatchesEnterpriseApi,
  parseTokenEndpointJson,
  refreshTokens,
  verifyIdTokenSignatureRs256,
} from './oidc-protocol'

const log = createLogger('Auth')

/** credential.service 中的 SSO 会话键（非 email: 前缀） */
const SSO_CREDENTIAL_KEY = 'sso:app'

/** access_token 提前刷新阈值 */
const REFRESH_SKEW_MS = 60_000

interface PersistedSsoBlob {
  user: AuthSession['user']
  tokens: AuthTokens
  authenticatedAt: number
  issuer: string
  clientId: string
}

export class AuthService {
  private session: AuthSession | null = null
  private discoveryCache: { issuer: string; doc: OidcDiscoveryDocument } | null = null
  private pending: {
    state: string
    codeVerifier: string
    redirectUri: string
    tokenEndpoint: string
    clientId: string
    clientSecret?: string
    issuer: string
    jwksUri?: string
  } | null = null
  private refreshInFlight: Promise<string | null> | null = null
  private restored = false

  isEnabled(): boolean {
    return isOemFeatureEnabled('sso')
  }

  getSsoConfig(): OemSsoConfig | undefined {
    return oemConfig.sso
  }

  getGateMode(): OemSsoGateMode {
    if (!this.isEnabled()) return 'none'
    return this.getSsoConfig()?.gateMode || 'soft'
  }

  getVerifyMode(): OemSsoVerifyIdToken {
    return this.getSsoConfig()?.verifyIdToken || 'claims'
  }

  /** 精确企业 API hostname 名单；未配 / 空 = 不自动注入 */
  getEnterpriseApiHosts(): string[] {
    const hosts = this.getSsoConfig()?.enterpriseApiHosts
    if (!Array.isArray(hosts)) return []
    return hosts
      .filter((h): h is string => typeof h === 'string')
      .map(h => h.trim())
      .filter(h => h.length > 0)
  }

  /** URL 是否应自动带 Bearer（开源未配名单 → false） */
  shouldInjectBearerForUrl(url: string): boolean {
    if (!this.isEnabled() || !this.session) return false
    const hosts = this.getEnterpriseApiHosts()
    if (hosts.length === 0) return false
    try {
      return hostMatchesEnterpriseApi(new URL(url).hostname, hosts)
    } catch {
      return false
    }
  }

  /** 主进程内部完整会话（含 token）；渲染进程请用 getPublicSession */
  getSession(): AuthSession | null {
    if (!this.isEnabled()) return null
    return this.session
  }

  getPublicSession(): AuthPublicSession | null {
    if (!this.isEnabled() || !this.session) return null
    return {
      user: this.session.user,
      authenticatedAt: this.session.authenticatedAt,
      expiresAt: this.session.tokens.expiresAt,
    }
  }

  /**
   * 启动时从 credential 恢复；失败则清空。幂等。
   */
  async restoreSession(): Promise<AuthPublicSession | null> {
    if (this.restored) return this.getPublicSession()
    this.restored = true
    if (!this.isEnabled()) {
      this.session = null
      return null
    }
    try {
      const raw = await getDefaultCredentialService().getCredential(SSO_CREDENTIAL_KEY)
      if (!raw) return null
      const blob = JSON.parse(raw) as PersistedSsoBlob
      if (!blob?.tokens?.accessToken || !blob.user?.sub) {
        await this.clearPersisted()
        return null
      }
      this.session = {
        user: blob.user,
        tokens: blob.tokens,
        authenticatedAt: blob.authenticatedAt || Date.now(),
      }
      // 过期则尝试 refresh；失败则清会话
      const token = await this.getAccessToken()
      if (!token) {
        this.session = null
        return null
      }
      log.info(`SSO session restored for sub=${blob.user.sub}`)
      return this.getPublicSession()
    } catch (e) {
      log.warn('SSO restoreSession failed:', e)
      this.session = null
      await this.clearPersisted().catch(() => {})
      return null
    }
  }

  private async fetchDiscovery(issuer: string): Promise<OidcDiscoveryDocument> {
    if (!this.isEnabled()) {
      throw new Error('SSO is disabled (oem.config.features.sso)')
    }
    if (this.discoveryCache?.issuer === issuer) {
      return this.discoveryCache.doc
    }
    const url = discoveryUrl(issuer)
    const res = await fetch(url)
    if (!res.ok) {
      throw new Error(`OIDC discovery failed: HTTP ${res.status}`)
    }
    const doc = (await res.json()) as OidcDiscoveryDocument
    this.discoveryCache = { issuer, doc }
    return doc
  }

  /**
   * 构造授权 URL（含 PKCE）。一般请用 login() 一条龙。
   */
  async beginLogin(): Promise<{ authorizationUrl: string; state: string }> {
    if (!this.isEnabled()) {
      throw new Error('SSO is disabled (oem.config.features.sso)')
    }
    const cfg = this.getSsoConfig()
    if (!cfg?.issuer || !cfg.clientId || !cfg.redirectUri) {
      throw new Error('oem.config.sso is incomplete (issuer/clientId/redirectUri required)')
    }

    const discovery = await this.fetchDiscovery(cfg.issuer)
    const codeVerifier = generateCodeVerifier()
    const codeChallenge = generateCodeChallenge(codeVerifier)
    const state = generateOAuthState()
    const scope = (cfg.scopes && cfg.scopes.length > 0)
      ? cfg.scopes.join(' ')
      : 'openid profile email'

    this.pending = {
      state,
      codeVerifier,
      redirectUri: cfg.redirectUri,
      tokenEndpoint: discovery.token_endpoint,
      clientId: cfg.clientId,
      clientSecret: cfg.clientSecret,
      issuer: cfg.issuer,
      jwksUri: discovery.jwks_uri,
    }

    const authorizationUrl = buildAuthorizeUrl({
      authorizationEndpoint: discovery.authorization_endpoint,
      clientId: cfg.clientId,
      redirectUri: cfg.redirectUri,
      scope,
      state,
      codeChallenge,
    })

    log.info('SSO login begun')
    return { authorizationUrl, state }
  }

  /**
   * 一条龙：begin → 弹窗 → complete。前端 / 岗包只调这一次。
   */
  async login(): Promise<AuthPublicSession> {
    const cfg = this.getSsoConfig()
    if (!cfg?.redirectUri) {
      throw new Error('oem.config.sso.redirectUri required')
    }
    const { authorizationUrl } = await this.beginLogin()
    const { code, state } = await openSsoLoginWindow(authorizationUrl, cfg.redirectUri)
    await this.completeLogin(code, state)
    const pub = this.getPublicSession()
    if (!pub) throw new Error('SSO login completed but session missing')
    return pub
  }

  /**
   * 用授权码换 token 并建立会话。
   */
  async completeLogin(code: string, state: string): Promise<AuthPublicSession> {
    if (!this.isEnabled()) {
      throw new Error('SSO is disabled (oem.config.features.sso)')
    }
    if (!this.pending || this.pending.state !== state) {
      throw new Error('Invalid or expired OAuth state')
    }
    const pending = this.pending
    this.pending = null

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: pending.redirectUri,
      client_id: pending.clientId,
      code_verifier: pending.codeVerifier,
    })
    if (pending.clientSecret) {
      body.set('client_secret', pending.clientSecret)
    }

    const res = await fetch(pending.tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`Token exchange failed: HTTP ${res.status} ${text}`)
    }
    const tokens = parseTokenEndpointJson((await res.json()) as Record<string, unknown>)
    if (!tokens.idToken) {
      throw new Error('Token response missing id_token (request openid scope)')
    }

    await this.verifyIdTokenIfNeeded(tokens.idToken, pending.jwksUri)

    const user = authUserFromIdToken(tokens.idToken, {
      issuer: pending.issuer,
      clientId: pending.clientId,
    })
    this.session = {
      user: {
        sub: user.sub,
        name: user.name,
        email: user.email,
        picture: user.picture,
        claims: user.claims,
      },
      tokens: {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        idToken: tokens.idToken,
        tokenType: tokens.tokenType,
        scope: tokens.scope,
        expiresAt: tokens.expiresAt,
      },
      authenticatedAt: Date.now(),
    }
    await this.persistSession(pending.issuer, pending.clientId)
    log.info(`SSO login completed for sub=${user.sub}`)
    return this.getPublicSession()!
  }

  private async verifyIdTokenIfNeeded(
    idToken: string,
    jwksUri?: string
  ): Promise<void> {
    // claims 校验在 authUserFromIdToken 内完成；此处仅额外 JWKS
    if (this.getVerifyMode() !== 'jwks') return
    if (!jwksUri) {
      log.warn('verifyIdToken=jwks but discovery has no jwks_uri; falling back to claims')
      return
    }
    try {
      await verifyIdTokenSignatureRs256(idToken, jwksUri)
    } catch (e) {
      throw new Error(`ID Token JWKS verification failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /**
   * 返回可用的 access_token；临近过期则 refresh。
   * SSO 关闭 / 未登录 → null。
   */
  async getAccessToken(): Promise<string | null> {
    if (!this.isEnabled() || !this.session) return null
    const { tokens } = this.session
    const expiresAt = tokens.expiresAt
    const stillValid = !expiresAt || expiresAt - Date.now() > REFRESH_SKEW_MS
    if (stillValid && tokens.accessToken) {
      return tokens.accessToken
    }
    if (!tokens.refreshToken) {
      if (!tokens.accessToken) {
        log.warn('SSO access token missing and no refresh_token')
      } else {
        log.warn('SSO access token expired and no refresh_token')
      }
      return null
    }
    if (this.refreshInFlight) return this.refreshInFlight
    this.refreshInFlight = this.doRefresh().finally(() => {
      this.refreshInFlight = null
    })
    return this.refreshInFlight
  }

  private async doRefresh(): Promise<string | null> {
    if (!this.session?.tokens.refreshToken) return null
    const cfg = this.getSsoConfig()
    if (!cfg?.issuer || !cfg.clientId) return null
    try {
      const discovery = await this.fetchDiscovery(cfg.issuer)
      const next = await refreshTokens({
        tokenEndpoint: discovery.token_endpoint,
        clientId: cfg.clientId,
        clientSecret: cfg.clientSecret,
        refreshToken: this.session.tokens.refreshToken,
      })
      this.session = {
        ...this.session,
        tokens: {
          ...this.session.tokens,
          accessToken: next.accessToken,
          refreshToken: next.refreshToken || this.session.tokens.refreshToken,
          idToken: next.idToken || this.session.tokens.idToken,
          tokenType: next.tokenType || this.session.tokens.tokenType,
          scope: next.scope || this.session.tokens.scope,
          expiresAt: next.expiresAt,
        },
      }
      await this.persistSession(cfg.issuer, cfg.clientId)
      log.info('SSO token refreshed')
      return this.session.tokens.accessToken
    } catch (e) {
      log.warn('SSO token refresh failed:', e)
      await this.logout()
      return null
    }
  }

  async logout(): Promise<void> {
    this.session = null
    this.pending = null
    this.discoveryCache = null
    await this.clearPersisted()
    if (this.isEnabled()) {
      log.info('SSO session cleared')
    }
  }

  private async persistSession(issuer: string, clientId: string): Promise<void> {
    if (!this.session) return
    const blob: PersistedSsoBlob = {
      user: this.session.user,
      tokens: this.session.tokens,
      authenticatedAt: this.session.authenticatedAt,
      issuer,
      clientId,
    }
    await getDefaultCredentialService().setCredential(SSO_CREDENTIAL_KEY, JSON.stringify(blob))
  }

  private async clearPersisted(): Promise<void> {
    await getDefaultCredentialService().deleteCredential(SSO_CREDENTIAL_KEY)
  }
}

let instance: AuthService | null = null

export function getAuthService(): AuthService {
  if (!instance) instance = new AuthService()
  return instance
}

/** @internal 测试用 */
export function __resetAuthServiceForTests(): void {
  instance = null
}
