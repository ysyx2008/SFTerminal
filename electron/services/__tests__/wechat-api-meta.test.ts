import { describe, expect, it } from 'vitest'
import path from 'node:path'

import { readPackageJsonFromDir } from '../im/wechat/api/api'
import { WEIXIN_PACKAGE_META } from '../im/wechat/weixin-meta'

describe('wechat api metadata', () => {
  it('resolves ilink_appid from vendored fallback when plugin package.json is absent', () => {
    const apiDir = path.join(process.cwd(), 'electron/services/im/wechat/api')
    const found = readPackageJsonFromDir(apiDir)
    expect(found.ilink_appid).toBeUndefined()

    const pkg = found.ilink_appid !== undefined ? found : { ...WEIXIN_PACKAGE_META }
    expect(pkg.ilink_appid).toBe('bot')
    expect(pkg.version).toBe('2.4.6')
  })
})
