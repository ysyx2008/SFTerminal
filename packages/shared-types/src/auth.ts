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

/** 主进程内部完整会话（含 refreshToken，勿下发渲染进程） */
export interface AuthSession {
  user: AuthUser
  tokens: AuthTokens
  /** 登录完成时间 */
  authenticatedAt: number
}

/**
 * 给渲染进程 / 岗包的脱敏会话（无 refreshToken / accessToken）。
 * 取短期 accessToken 请走 auth:getAccessToken。
 */
export interface AuthPublicSession {
  user: AuthUser
  authenticatedAt: number
  /** access token 过期时间（epoch ms），便于 UI 提示；不含 token 本身 */
  expiresAt?: number
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
