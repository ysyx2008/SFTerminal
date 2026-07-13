import { describe, it, expect, beforeEach } from 'vitest'
import { AuthService, __resetAuthServiceForTests } from '../auth.service'
import { hostMatchesEnterpriseApi } from '../oidc-protocol'

describe('AuthService feature gate', () => {
  let auth: AuthService

  beforeEach(() => {
    __resetAuthServiceForTests()
    auth = new AuthService()
  })

  it('is disabled by default (features.sso=false)', () => {
    expect(auth.isEnabled()).toBe(false)
    expect(auth.getSession()).toBeNull()
    expect(auth.getPublicSession()).toBeNull()
    expect(auth.getGateMode()).toBe('none')
  })

  it('beginLogin rejects when sso disabled', async () => {
    await expect(auth.beginLogin()).rejects.toThrow(/SSO is disabled/)
  })

  it('shouldInjectBearerForUrl is false when disabled or hosts empty', () => {
    expect(auth.shouldInjectBearerForUrl('https://api.corp.example/v1')).toBe(false)
    expect(auth.getEnterpriseApiHosts()).toEqual([])
  })
})

describe('hostMatchesEnterpriseApi', () => {
  it('returns false for empty / undefined hosts', () => {
    expect(hostMatchesEnterpriseApi('api.corp.example', undefined)).toBe(false)
    expect(hostMatchesEnterpriseApi('api.corp.example', [])).toBe(false)
  })

  it('matches exact hostname case-insensitively', () => {
    expect(hostMatchesEnterpriseApi('API.Corp.Example', ['api.corp.example'])).toBe(true)
  })

  it('does not match suffix or subdomain wildcards', () => {
    expect(hostMatchesEnterpriseApi('evil.api.corp.example', ['api.corp.example'])).toBe(false)
    expect(hostMatchesEnterpriseApi('corp.example', ['api.corp.example'])).toBe(false)
  })
})
