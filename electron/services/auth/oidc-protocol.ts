/**
 * OAuth2 / OIDC 协议辅助（纯函数，可单测）
 */
import { createHash, randomBytes } from 'crypto'

export function generateCodeVerifier(bytes = 32): string {
  return base64Url(randomBytes(bytes))
}

export function generateCodeChallenge(verifier: string): string {
  return base64Url(createHash('sha256').update(verifier).digest())
}

export function generateOAuthState(bytes = 16): string {
  return base64Url(randomBytes(bytes))
}

function base64Url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export interface BuildAuthorizeUrlInput {
  authorizationEndpoint: string
  clientId: string
  redirectUri: string
  scope: string
  state: string
  codeChallenge: string
  codeChallengeMethod?: 'S256'
  extraParams?: Record<string, string>
}

export function buildAuthorizeUrl(input: BuildAuthorizeUrlInput): string {
  const url = new URL(input.authorizationEndpoint)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', input.clientId)
  url.searchParams.set('redirect_uri', input.redirectUri)
  url.searchParams.set('scope', input.scope)
  url.searchParams.set('state', input.state)
  url.searchParams.set('code_challenge', input.codeChallenge)
  url.searchParams.set('code_challenge_method', input.codeChallengeMethod || 'S256')
  if (input.extraParams) {
    for (const [k, v] of Object.entries(input.extraParams)) {
      url.searchParams.set(k, v)
    }
  }
  return url.toString()
}

/**
 * 解析 JWT 中段 payload（不验证签名——桌面端完整验签需 JWKS，后续可加）。
 * 调用方应再做 iss/aud/exp 校验（见 assertIdTokenClaims）。
 */
export function parseJwtPayload(jwt: string): Record<string, unknown> {
  const parts = jwt.split('.')
  if (parts.length < 2) {
    throw new Error('Invalid JWT')
  }
  const json = Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
  return JSON.parse(json) as Record<string, unknown>
}

export function assertIdTokenClaims(
  claims: Record<string, unknown>,
  expected: { issuer: string; clientId: string }
): void {
  const iss = typeof claims.iss === 'string' ? claims.iss : ''
  if (iss.replace(/\/+$/, '') !== expected.issuer.replace(/\/+$/, '')) {
    throw new Error(`ID Token iss mismatch: got ${iss}`)
  }
  const aud = claims.aud
  const audOk = aud === expected.clientId
    || (Array.isArray(aud) && aud.includes(expected.clientId))
  if (!audOk) {
    throw new Error('ID Token aud mismatch')
  }
  const exp = typeof claims.exp === 'number' ? claims.exp : 0
  if (!exp || exp * 1000 < Date.now() - 60_000) {
    throw new Error('ID Token expired')
  }
}

export function authUserFromIdToken(
  idToken: string,
  expected?: { issuer: string; clientId: string }
): {
  sub: string
  name?: string
  email?: string
  picture?: string
  claims: Record<string, unknown>
} {
  const claims = parseJwtPayload(idToken)
  if (expected) {
    assertIdTokenClaims(claims, expected)
  }
  const sub = typeof claims.sub === 'string' ? claims.sub : ''
  if (!sub) throw new Error('ID Token missing sub')
  return {
    sub,
    name: typeof claims.name === 'string' ? claims.name : undefined,
    email: typeof claims.email === 'string' ? claims.email : undefined,
    picture: typeof claims.picture === 'string' ? claims.picture : undefined,
    claims,
  }
}

export function discoveryUrl(issuer: string): string {
  const base = issuer.replace(/\/+$/, '')
  return `${base}/.well-known/openid-configuration`
}
