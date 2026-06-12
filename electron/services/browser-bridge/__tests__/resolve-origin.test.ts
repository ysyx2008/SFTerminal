import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const resolveOriginModule = new URL(
  '../../../../resources/browser-bridge/native-host/resolve-origin.mjs',
  import.meta.url,
).href

async function loadResolveOrigin() {
  return import(resolveOriginModule) as Promise<{
    resolveNativeHostOrigin: (arg: unknown) => string
  }>
}

describe('resolveNativeHostOrigin', () => {
  let tempDir = ''

  afterEach(() => {
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true })
      tempDir = ''
    }
  })

  it('passes through chromium origin', async () => {
    const { resolveNativeHostOrigin } = await loadResolveOrigin()
    expect(resolveNativeHostOrigin('chrome-extension://abc/')).toBe('chrome-extension://abc/')
    expect(resolveNativeHostOrigin('chrome-extension://abc')).toBe('chrome-extension://abc/')
  })

  it('reads firefox id from native host manifest path', async () => {
    const { resolveNativeHostOrigin } = await loadResolveOrigin()
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-bridge-'))
    const manifestPath = path.join(tempDir, 'com.sailfish.browser.json')
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        allowed_extensions: ['sailfish-browser-bridge@yushen.dev'],
      }),
      'utf8',
    )
    expect(resolveNativeHostOrigin(manifestPath)).toBe(
      'moz-extension://sailfish-browser-bridge@yushen.dev/',
    )
  })

  it('maps bare firefox extension id', async () => {
    const { resolveNativeHostOrigin } = await loadResolveOrigin()
    expect(resolveNativeHostOrigin('sailfish-browser-bridge@yushen.dev')).toBe(
      'moz-extension://sailfish-browser-bridge@yushen.dev/',
    )
  })
})
