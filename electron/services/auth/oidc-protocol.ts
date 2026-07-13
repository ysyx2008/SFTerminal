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

function decodeJwtPart(part: string): string {
  return Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
}

/** 解析 JWT header（不验签） */
export function parseJwtHeader(jwt: string): Record<string, unknown> {
  const parts = jwt.split('.')
  if (parts.length < 2) throw new Error('Invalid JWT')
  return JSON.parse(decodeJwtPart(parts[0])) as Record<string, unknown>
}

/**
 * 解析 JWT 中段 payload（不验证签名）。
 * 调用方应再做 iss/aud/exp 校验（见 assertIdTokenClaims）；
 * OEM 开 jwks 时再走 verifyIdTokenSignatureRs256。
 */
export function parseJwtPayload(jwt: string): Record<string, unknown> {
  const parts = jwt.split('.')
  if (parts.length < 2) {
    throw new Error('Invalid JWT')
  }
  return JSON.parse(decodeJwtPart(parts[1])) as Record<string, unknown>
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

export interface RefreshTokensInput {
  tokenEndpoint: string
  clientId: string
  clientSecret?: string
  refreshToken: string
}

export interface TokenEndpointResult {
  accessToken: string
  refreshToken?: string
  idToken?: string
  tokenType?: string
  scope?: string
  expiresAt?: number
}

/** 用 refresh_token 换新 access_token（纯协议，不含落盘） */
export async function refreshTokens(input: RefreshTokensInput): Promise<TokenEndpointResult> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: input.refreshToken,
    client_id: input.clientId,
  })
  if (input.clientSecret) {
    body.set('client_secret', input.clientSecret)
  }
  const res = await fetch(input.tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Token refresh failed: HTTP ${res.status} ${text}`)
  }
  return parseTokenEndpointJson(await res.json() as Record<string, unknown>)
}

export function parseTokenEndpointJson(json: Record<string, unknown>): TokenEndpointResult {
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

interface JwkRsa {
  kty: string
  kid?: string
  n?: string
  e?: string
  alg?: string
  use?: string
}

/**
 * 用 JWKS 验 RS256 ID Token 签名。仅支持 RSA；其它 alg 抛错由调用方降级。
 */
export async function verifyIdTokenSignatureRs256(
  idToken: string,
  jwksUri: string
): Promise<void> {
  const { createVerify } = await import('crypto')
  const header = parseJwtHeader(idToken)
  const alg = typeof header.alg === 'string' ? header.alg : ''
  if (alg !== 'RS256') {
    throw new Error(`JWKS verify only supports RS256, got ${alg || 'unknown'}`)
  }
  const kid = typeof header.kid === 'string' ? header.kid : undefined
  const res = await fetch(jwksUri)
  if (!res.ok) throw new Error(`JWKS fetch failed: HTTP ${res.status}`)
  const jwks = (await res.json()) as { keys?: JwkRsa[] }
  const keys = Array.isArray(jwks.keys) ? jwks.keys : []
  const jwk = (kid ? keys.find(k => k.kid === kid) : undefined)
    || keys.find(k => k.kty === 'RSA' && k.n && k.e)
  if (!jwk?.n || !jwk?.e) {
    throw new Error('No matching RSA JWK in JWKS')
  }
  const pem = rsaJwkToPem(jwk.n, jwk.e)
  const parts = idToken.split('.')
  if (parts.length !== 3) throw new Error('Invalid JWT')
  const signed = `${parts[0]}.${parts[1]}`
  const signature = Buffer.from(parts[2].replace(/-/g, '+').replace(/_/g, '/'), 'base64')
  const verifier = createVerify('RSA-SHA256')
  verifier.update(signed)
  verifier.end()
  if (!verifier.verify(pem, signature)) {
    throw new Error('ID Token signature verification failed')
  }
}

function rsaJwkToPem(nB64Url: string, eB64Url: string): string {
  const n = Buffer.from(nB64Url.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
  const e = Buffer.from(eB64Url.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
  // PKCS#1 RSAPublicKey DER，再包一层 SubjectPublicKeyInfo
  const rsaPublicKey = derEncodeSequence(
    Buffer.concat([derEncodeInteger(n), derEncodeInteger(e)])
  )
  const algo = Buffer.from('300d06092a864886f70d0101010500', 'hex') // rsaEncryption NULL
  const bitString = Buffer.concat([
    Buffer.from([0x03]),
    derEncodeLength(rsaPublicKey.length + 1),
    Buffer.from([0x00]),
    rsaPublicKey,
  ])
  const spki = derEncodeSequence(Buffer.concat([algo, bitString]))
  const b64 = spki.toString('base64')
  const lines = b64.match(/.{1,64}/g) || []
  return `-----BEGIN PUBLIC KEY-----\n${lines.join('\n')}\n-----END PUBLIC KEY-----\n`
}

function derEncodeLength(len: number): Buffer {
  if (len < 0x80) return Buffer.from([len])
  if (len < 0x100) return Buffer.from([0x81, len])
  return Buffer.from([0x82, (len >> 8) & 0xff, len & 0xff])
}

function derEncodeInteger(buf: Buffer): Buffer {
  let v = buf
  while (v.length > 1 && v[0] === 0) v = v.subarray(1)
  if (v[0] & 0x80) v = Buffer.concat([Buffer.from([0x00]), v])
  return Buffer.concat([Buffer.from([0x02]), derEncodeLength(v.length), v])
}

function derEncodeSequence(content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([0x30]), derEncodeLength(content.length), content])
}

/** 精确 hostname 命中（大小写不敏感）；不做通配 / 后缀匹配 */
export function hostMatchesEnterpriseApi(hostname: string, hosts: string[] | undefined): boolean {
  if (!hosts || hosts.length === 0) return false
  const target = hostname.trim().toLowerCase()
  return hosts.some(h => typeof h === 'string' && h.trim().toLowerCase() === target)
}
