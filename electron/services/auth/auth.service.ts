/**
 * 应用 SSO AuthService（OAuth2/OIDC 协议底座）
 *
 * - features.sso === false 时所有入口拒绝 / no-op
 * - 与邮箱/飞书 OAuth 分离（本模块只做应用身份登录）
 */
import { createLogger } from '../../utils/logger'
import { isOemFeatureEnabled } from '@shared/oem-features'
import { oemConfig } from '@shared/oem.config'
import type { OemSsoConfig } from '@shared/oem-types'
import type { AuthSession, AuthTokens, OidcDiscoveryDocument } from '@shared/types'
import {
  authUserFromIdToken,
  buildAuthorizeUrl,
  discoveryUrl,
  generateCodeChallenge,
  generateCodeVerifier,
  generateOAuthState,
} from './oidc-protocol'

const log = createLogger('Auth')

export class AuthService {
  private session: AuthSession | null = null
  private pending: {
    state: string
    codeVerifier: string
    redirectUri: string
    tokenEndpoint: string
    clientId: string
    clientSecret?: string
  } | null = null

  isEnabled(): boolean {
    return isOemFeatureEnabled('sso')
  }

  getSsoConfig(): OemSsoConfig | undefined {
    return oemConfig.sso
  }

  getSession(): AuthSession | null {
    if (!this.isEnabled()) return null
    return this.session
  }

  async fetchDiscovery(issuer: string): Promise<OidcDiscoveryDocument> {
    const url = discoveryUrl(issuer)
    const res = await fetch(url)
    if (!res.ok) {
      throw new Error(`OIDC discovery failed: HTTP ${res.status}`)
    }
    return (await res.json()) as OidcDiscoveryDocument
  }

  /**
   * 构造授权 URL（含 PKCE）。调用方用 BrowserWindow / openExternal 打开。
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
   * 用授权码换 token 并建立会话。
   */
  async completeLogin(code: string, state: string): Promise<AuthSession> {
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
    const json = (await res.json()) as Record<string, unknown>
    const tokens = this.parseTokenResponse(json)
    if (!tokens.idToken) {
      throw new Error('Token response missing id_token (request openid scope)')
    }
    const user = authUserFromIdToken(tokens.idToken)
    this.session = {
      user: {
        sub: user.sub,
        name: user.name,
        email: user.email,
        picture: user.picture,
        claims: user.claims,
      },
      tokens,
      authenticatedAt: Date.now(),
    }
    log.info(`SSO login completed for sub=${user.sub}`)
    return this.session
  }

  async logout(): Promise<void> {
    this.session = null
    this.pending = null
    if (!this.isEnabled()) return
    log.info('SSO session cleared')
  }

  private parseTokenResponse(json: Record<string, unknown>): AuthTokens {
    const accessToken = typeof json.access_token === 'string' ? json.access_token : ''
    if (!accessToken) throw new Error('Token response missing access_token')
    const expiresIn = typeof json.expires_in === 'number' ? json.expires_in : undefined
    return {
      accessToken,
      refreshToken: typeof json.refresh_token === 'string' ? json.refresh_token : undefined,
      idToken: typeof json.id_token === 'string' ? json.id_token : undefined,
      tokenType: typeof json.token_type === 'string' ? json.token_type : undefined,
      scope: typeof json.scope === 'string' ? json.scope : undefined,
      expiresAt: expiresIn ? Date.now() + expiresIn * 1000 : undefined,
    }
  }
}

let instance: AuthService | null = null

export function getAuthService(): AuthService {
  if (!instance) instance = new AuthService()
  return instance
}
