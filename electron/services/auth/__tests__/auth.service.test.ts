import { describe, it, expect, beforeEach } from 'vitest'
import { AuthService } from '../auth.service'

describe('AuthService feature gate', () => {
  let auth: AuthService

  beforeEach(() => {
    auth = new AuthService()
  })

  it('is disabled by default (features.sso=false)', () => {
    expect(auth.isEnabled()).toBe(false)
    expect(auth.getSession()).toBeNull()
  })

  it('beginLogin rejects when sso disabled', async () => {
    await expect(auth.beginLogin()).rejects.toThrow(/SSO is disabled/)
  })
})
