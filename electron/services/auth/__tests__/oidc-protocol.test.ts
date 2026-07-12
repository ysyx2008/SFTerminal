import { describe, it, expect } from 'vitest'
import {
  authUserFromIdToken,
  buildAuthorizeUrl,
  discoveryUrl,
  generateCodeChallenge,
  generateCodeVerifier,
  generateOAuthState,
  parseJwtPayload,
} from '../oidc-protocol'

function makeUnsignedJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${header}.${body}.sig`
}

describe('oidc-protocol', () => {
  it('generates PKCE verifier/challenge', () => {
    const verifier = generateCodeVerifier()
    expect(verifier.length).toBeGreaterThan(20)
    const challenge = generateCodeChallenge(verifier)
    expect(challenge).not.toBe(verifier)
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('builds authorize URL with PKCE params', () => {
    const url = buildAuthorizeUrl({
      authorizationEndpoint: 'https://idp.example.com/authorize',
      clientId: 'client-1',
      redirectUri: 'http://127.0.0.1:8765/callback',
      scope: 'openid profile',
      state: 'st',
      codeChallenge: 'ch',
    })
    const u = new URL(url)
    expect(u.searchParams.get('response_type')).toBe('code')
    expect(u.searchParams.get('client_id')).toBe('client-1')
    expect(u.searchParams.get('code_challenge')).toBe('ch')
    expect(u.searchParams.get('code_challenge_method')).toBe('S256')
    expect(u.searchParams.get('state')).toBe('st')
  })

  it('parses ID Token claims into AuthUser fields', () => {
    const jwt = makeUnsignedJwt({
      sub: 'user-42',
      name: 'Ada',
      email: 'ada@example.com',
    })
    const user = authUserFromIdToken(jwt)
    expect(user.sub).toBe('user-42')
    expect(user.name).toBe('Ada')
    expect(user.email).toBe('ada@example.com')
    expect(parseJwtPayload(jwt).sub).toBe('user-42')
  })

  it('builds discovery URL', () => {
    expect(discoveryUrl('https://idp.example.com/')).toBe(
      'https://idp.example.com/.well-known/openid-configuration'
    )
  })

  it('generates opaque state', () => {
    expect(generateOAuthState()).not.toBe(generateOAuthState())
  })
})
