/**
 * 应用 SSO（OAuth2 / OIDC）共享类型
 * 与邮箱/飞书等「服务授权」OAuth 分离。
 */

export interface AuthUser {
  sub: string
  name?: string
  email?: string
  picture?: string
  /** 原始 ID Token claims（已解析 JSON） */
  claims?: Record<string, unknown>
}

export interface AuthTokens {
  accessToken: string
  refreshToken?: string
  idToken?: string
  tokenType?: string
  /** epoch ms */
  expiresAt?: number
  scope?: string
}

export interface AuthSession {
  user: AuthUser
  tokens: AuthTokens
  /** 登录完成时间 */
  authenticatedAt: number
}

export interface OidcDiscoveryDocument {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  end_session_endpoint?: string
  jwks_uri?: string
  userinfo_endpoint?: string
  scopes_supported?: string[]
}
