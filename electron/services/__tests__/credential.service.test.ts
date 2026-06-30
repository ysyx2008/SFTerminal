import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

let tmpDir: string

// safeStorage 模式由测试动态控制
let safeStorageEnabled = true

vi.mock('electron', () => ({
  app: {
    getPath: (key: string) => {
      if (key === 'userData') return tmpDir
      return tmpDir
    },
    getName: () => 'SailFish',
    getVersion: () => '1.0.0',
    isPackaged: false
  },
  safeStorage: {
    isEncryptionAvailable: () => safeStorageEnabled,
    encryptString: (plain: string) => {
      // 用一个简单可逆变换模拟加密：异或 0x42 + 加前缀
      const buf = Buffer.from(plain, 'utf-8')
      const xored = Buffer.from(buf.map(b => b ^ 0x42))
      return Buffer.concat([Buffer.from('ENC:'), xored])
    },
    decryptString: (buf: Buffer) => {
      const prefix = buf.slice(0, 4).toString()
      if (prefix !== 'ENC:') throw new Error('decrypt failed')
      const body = buf.slice(4)
      return Buffer.from(body.map(b => b ^ 0x42)).toString('utf-8')
    }
  }
}))

// keytar fallback：测试中按需通过 setLegacy 注入伪数据
const legacyStore: Record<string, string> = {}
let legacyDeleteCalls: string[] = []

vi.mock('keytar', () => ({
  default: {
    getPassword: async (_service: string, key: string) => {
      return Object.prototype.hasOwnProperty.call(legacyStore, key) ? legacyStore[key] : null
    },
    setPassword: async (_service: string, key: string, value: string) => {
      legacyStore[key] = value
    },
    deletePassword: async (_service: string, key: string) => {
      legacyDeleteCalls.push(key)
      if (Object.prototype.hasOwnProperty.call(legacyStore, key)) {
        delete legacyStore[key]
        return true
      }
      return false
    },
    findCredentials: async () =>
      Object.entries(legacyStore).map(([account, password]) => ({ account, password }))
  }
}))

import {
  setCredential,
  getCredential,
  deleteCredential,
  listCredentials,
  setEmailCredential,
  getEmailCredential,
  deleteEmailCredential,
  setCalendarCredential,
  getCalendarCredential,
  setOAuth2Token,
  getOAuth2Token,
  setSkillEnv,
  getSkillEnv,
  deleteSkillEnv,
  listSkillEnvNames,
  getSkillEnvMap,
  __resetCredentialCacheForTests
} from '../credential.service'

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sft-credential-test-'))
  safeStorageEnabled = true
  for (const k of Object.keys(legacyStore)) delete legacyStore[k]
  legacyDeleteCalls = []
  __resetCredentialCacheForTests()
})

afterEach(() => {
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

describe('credential.service - 基本读写', () => {
  it('set/get 一对密钥能正确往返', async () => {
    await setCredential('email:abc', 'super-secret')
    const got = await getCredential('email:abc')
    expect(got).toBe('super-secret')
  })

  it('磁盘文件落到 credentials.json 并使用 e1: 前缀（safeStorage 可用时）', async () => {
    await setCredential('feishu:user_oauth', 'token-xyz')
    const filePath = path.join(tmpDir, 'credentials.json')
    expect(fs.existsSync(filePath)).toBe(true)
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
    expect(raw.schemaVersion).toBe(2)
    expect(raw.items['feishu:user_oauth']).toMatch(/^e1:/)
    // 密文应该不包含明文
    expect(raw.items['feishu:user_oauth']).not.toContain('token-xyz')
  })

  it('safeStorage 不可用时降级为 base64 明文（p: 前缀），仍能读回', async () => {
    safeStorageEnabled = false
    await setCredential('email:linux', 'plain-pwd')
    const filePath = path.join(tmpDir, 'credentials.json')
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
    expect(raw.items['email:linux']).toMatch(/^p:/)
    expect(await getCredential('email:linux')).toBe('plain-pwd')
  })

  it('删除已存在的 key 返回 true，不存在的返回 false', async () => {
    await setCredential('k1', 'v1')
    expect(await deleteCredential('k1')).toBe(true)
    expect(await getCredential('k1')).toBeNull()
    expect(await deleteCredential('not-exist')).toBe(false)
  })

  it('listCredentials 支持前缀过滤', async () => {
    await setCredential('email:a', '1')
    await setCredential('email:b', '2')
    await setCredential('calendar:c', '3')
    const emails = await listCredentials('email:')
    expect(emails.sort()).toEqual(['email:a', 'email:b'])
    const all = await listCredentials()
    expect(all.length).toBe(3)
  })

  it('CLI 模式下使用独立的 credentials-cli.json 文件', async () => {
    const original = process.env.SFT_CLI_MODE
    process.env.SFT_CLI_MODE = '1'
    __resetCredentialCacheForTests()
    try {
      await setCredential('cli:key', 'cli-secret')
      expect(fs.existsSync(path.join(tmpDir, 'credentials-cli.json'))).toBe(true)
      expect(fs.existsSync(path.join(tmpDir, 'credentials.json'))).toBe(false)
    } finally {
      if (original === undefined) delete process.env.SFT_CLI_MODE
      else process.env.SFT_CLI_MODE = original
    }
  })
})

describe('credential.service - 邮箱/日历专用方法', () => {
  it('邮箱凭据走 email: 前缀', async () => {
    await setEmailCredential('a1', 'pwd-a1')
    expect(await getEmailCredential('a1')).toBe('pwd-a1')
    const all = await listCredentials('email:')
    expect(all).toContain('email:a1')
    expect(await deleteEmailCredential('a1')).toBe(true)
    expect(await getEmailCredential('a1')).toBeNull()
  })

  it('日历凭据走 calendar: 前缀', async () => {
    await setCalendarCredential('cal1', 'pwd-cal1')
    expect(await getCalendarCredential('cal1')).toBe('pwd-cal1')
    const all = await listCredentials('calendar:')
    expect(all).toContain('calendar:cal1')
  })

  it('OAuth2 Token 序列化往返', async () => {
    await setOAuth2Token('oa1', {
      accessToken: 'AT',
      refreshToken: 'RT',
      expiresAt: Date.now() + 60_000,
      tokenType: 'Bearer'
    })
    const got = await getOAuth2Token('oa1')
    expect(got).not.toBeNull()
    expect(got!.accessToken).toBe('AT')
    expect(got!.refreshToken).toBe('RT')
    expect(got!.tokenType).toBe('Bearer')
  })

  it('OAuth2 Token 不存在时返回 null', async () => {
    expect(await getOAuth2Token('nope')).toBeNull()
  })
})

describe('credential.service - 旧 keytar 数据懒迁移', () => {
  it('新存储没有时回退到 keytar，并把读到的值写入新存储', async () => {
    legacyStore['email:legacy'] = 'old-pwd'
    const got = await getCredential('email:legacy')
    expect(got).toBe('old-pwd')
    // 确认已经写到新存储里
    const filePath = path.join(tmpDir, 'credentials.json')
    expect(fs.existsSync(filePath)).toBe(true)
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
    expect(raw.items['email:legacy']).toMatch(/^e1:/)
    // 不主动 delete keytar，避免再次触发 ACL 弹窗
    expect(legacyDeleteCalls).not.toContain('email:legacy')
  })

  it('迁移后再次 get 不会再读 keytar（命中新存储）', async () => {
    legacyStore['k'] = 'first'
    expect(await getCredential('k')).toBe('first')
    // 修改 legacy 模拟 keytar 数据变化，新 get 应仍返回首次迁移的值
    legacyStore['k'] = 'second'
    expect(await getCredential('k')).toBe('first')
  })

  it('deleteCredential 同时尽力清理 keytar 残留', async () => {
    legacyStore['legacy-only'] = 'val'
    // 直接删（新存储里没有）
    const removed = await deleteCredential('legacy-only')
    expect(removed).toBe(false) // 新存储里没有，所以返回 false
    // 但 keytar 仍被尝试 delete
    expect(legacyDeleteCalls).toContain('legacy-only')
  })
})

describe('credential.service - 写并发', () => {
  it('并发 set 不会互相覆盖', async () => {
    await Promise.all([
      setCredential('k1', 'v1'),
      setCredential('k2', 'v2'),
      setCredential('k3', 'v3')
    ])
    expect(await getCredential('k1')).toBe('v1')
    expect(await getCredential('k2')).toBe('v2')
    expect(await getCredential('k3')).toBe('v3')
  })

  it('并发 get（首次）不会触发多次磁盘读取', async () => {
    // 先写一条记录到磁盘
    await setCredential('k', 'v')
    __resetCredentialCacheForTests()

    // 监视 readFile 的调用次数
    const fsModule = await import('fs')
    const realReadFile = fsModule.promises.readFile
    let readCount = 0
    const spy = vi.spyOn(fsModule.promises, 'readFile').mockImplementation((async (...args: Parameters<typeof realReadFile>) => {
      readCount++
      return await realReadFile(...args)
    }) as typeof realReadFile)

    try {
      const [a, b, c] = await Promise.all([
        getCredential('k'),
        getCredential('k'),
        getCredential('k')
      ])
      expect(a).toBe('v')
      expect(b).toBe('v')
      expect(c).toBe('v')
      expect(readCount).toBe(1)
    } finally {
      spy.mockRestore()
    }
  })
})

describe('credential.service - 持久化失败回滚', () => {
  it('setCredential 写盘失败时不会污染内存缓存', async () => {
    await setCredential('k', 'old')
    expect(await getCredential('k')).toBe('old')

    // 让 fs.rename 失败一次
    const fsModule = await import('fs')
    const realRename = fsModule.promises.rename
    let failed = false
    const spy = vi.spyOn(fsModule.promises, 'rename').mockImplementation((async (...args: Parameters<typeof realRename>) => {
      if (!failed) {
        failed = true
        throw new Error('disk full')
      }
      return realRename(...args)
    }) as typeof realRename)

    try {
      await expect(setCredential('k', 'new')).rejects.toThrow('disk full')
      // 内存里仍是旧值
      expect(await getCredential('k')).toBe('old')
    } finally {
      spy.mockRestore()
    }

    // 写盘恢复后，再次 set 应能正常工作
    await setCredential('k', 'new2')
    expect(await getCredential('k')).toBe('new2')
  })

  it('deleteCredential 写盘失败时条目不会从内存里消失', async () => {
    await setCredential('k', 'v')
    const fsModule = await import('fs')
    const realRename = fsModule.promises.rename
    let failed = false
    const spy = vi.spyOn(fsModule.promises, 'rename').mockImplementation((async (...args: Parameters<typeof realRename>) => {
      if (!failed) {
        failed = true
        throw new Error('disk full')
      }
      return realRename(...args)
    }) as typeof realRename)

    try {
      await expect(deleteCredential('k')).rejects.toThrow('disk full')
      expect(await getCredential('k')).toBe('v')
    } finally {
      spy.mockRestore()
    }
  })
})

describe('credential.service - 技能 env 凭据（大小写归一化）', () => {
  it('setSkillEnv 无论传入什么大小写，存储的 envName 都是大写', async () => {
    await setSkillEnv('weather', 'api_key', 'val-1')
    // 直接读磁盘验证 key 是大写
    const filePath = path.join(tmpDir, 'credentials.json')
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
    expect(raw.items['skill:weather:API_KEY']).toBeDefined()
    expect(raw.items['skill:weather:api_key']).toBeUndefined()
  })

  it('getSkillEnv 用小写/大写/混合大小写都能读到同一份值', async () => {
    await setSkillEnv('weather', 'api_key', 'val-2')
    expect(await getSkillEnv('weather', 'api_key')).toBe('val-2')
    expect(await getSkillEnv('weather', 'API_KEY')).toBe('val-2')
    expect(await getSkillEnv('weather', 'Api_Key')).toBe('val-2')
  })

  it('deleteSkillEnv 用小写删除大写存储的 key 能成功', async () => {
    await setSkillEnv('weather', 'API_KEY', 'val-3')
    expect(await deleteSkillEnv('weather', 'api_key')).toBe(true)
    expect(await getSkillEnv('weather', 'API_KEY')).toBeNull()
  })

  it('listSkillEnvNames 返回的都是大写名', async () => {
    await setSkillEnv('weather', 'api_key', 'v')
    await setSkillEnv('weather', 'Secret_Token', 'v')
    const names = await listSkillEnvNames('weather')
    expect(names.sort()).toEqual(['API_KEY', 'SECRET_TOKEN'])
  })

  it('getSkillEnvMap 返回的 key 是大写，由调用方负责映射回声明大小写', async () => {
    await setSkillEnv('weather', 'api_key', 'v1')
    await setSkillEnv('weather', 'API_KEY', 'v2') // 覆盖
    const map = await getSkillEnvMap('weather')
    expect(Object.keys(map)).toEqual(['API_KEY'])
    expect(map['API_KEY']).toBe('v2')
  })
})

describe('credential.service - skill env v1→v2 一次性迁移', () => {
  it('磁盘上存在小写 envName 的旧记录，loadStore 时自动归一化为大写', async () => {
    // 手工构造一个 v1 格式的旧 store 文件，含混合大小写的 skill env key
    const filePath = path.join(tmpDir, 'credentials.json')
    // 用 p: 前缀（base64 明文）构造，让 decryptValue 能正常解密
    const enc = (plain: string) => 'p:' + Buffer.from(plain, 'utf-8').toString('base64')
    const legacyStore = {
      schemaVersion: 1,
      items: {
        'skill:weather:api_key': enc('low-val'),    // 纯小写
        'skill:weather:Secret': enc('mixed-val'),   // 混合大小写
        'email:user1': enc('email-val'),            // 非_skill_前缀，不应被动
      }
    }
    fs.writeFileSync(filePath, JSON.stringify(legacyStore), 'utf-8')

    // 触发 loadStore（任意 credential 读取都会触发）
    expect(await getSkillEnv('weather', 'api_key')).toBe('low-val')

    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
    expect(raw.schemaVersion).toBe(2)
    // 小写/混合都已归一化为大写
    expect(raw.items['skill:weather:API_KEY']).toBe(enc('low-val'))
    expect(raw.items['skill:weather:SECRET']).toBe(enc('mixed-val'))
    // 旧的小写 key 已删除
    expect(raw.items['skill:weather:api_key']).toBeUndefined()
    expect(raw.items['skill:weather:Secret']).toBeUndefined()
    // 非_skill_前缀的记录不受影响
    expect(raw.items['email:user1']).toBe(enc('email-val'))
  })

  it('同一 (skillId, UPPER_ENV) 下既有小写又已有大写记录时，以大写为准，小写丢弃', async () => {
    const filePath = path.join(tmpDir, 'credentials.json')
    // 用 p: 前缀（base64 明文）构造旧数据，让 decryptValue 能正常解密
    const enc = (plain: string) => 'p:' + Buffer.from(plain, 'utf-8').toString('base64')
    const legacyStore = {
      schemaVersion: 1,
      items: {
        'skill:weather:api_key': enc('lower-value'),  // 小写
        'skill:weather:API_KEY': enc('upper-value'),  // 大写已存在
      }
    }
    fs.writeFileSync(filePath, JSON.stringify(legacyStore), 'utf-8')

    expect(await getSkillEnv('weather', 'api_key')).toBe('upper-value')

    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
    expect(raw.schemaVersion).toBe(2)
    // 大写记录的值保留，小写记录被丢弃
    expect(raw.items['skill:weather:API_KEY']).toBe(enc('upper-value'))
    expect(raw.items['skill:weather:api_key']).toBeUndefined()
  })

  it('已是 v2 的 store 不会重复扫描（幂等）', async () => {
    // 先正常写入一条（v2）
    await setSkillEnv('weather', 'api_key', 'v')
    const filePath = path.join(tmpDir, 'credentials.json')
    const afterFirst = fs.readFileSync(filePath, 'utf-8')

    // 重置缓存后再读，不应改动文件内容（除了可能的 mtime）
    __resetCredentialCacheForTests()
    await getSkillEnv('weather', 'API_KEY')
    const afterSecond = fs.readFileSync(filePath, 'utf-8')
    expect(afterSecond).toBe(afterFirst)
  })

  it('多个 skillId 的小写 key 互不干扰地各自迁移', async () => {
    const filePath = path.join(tmpDir, 'credentials.json')
    const enc = (plain: string) => 'p:' + Buffer.from(plain, 'utf-8').toString('base64')
    const legacyStore = {
      schemaVersion: 1,
      items: {
        'skill:weather:api_key': enc('w-key'),
        'skill:stock:token': enc('s-token'),
        'skill:weather:token': enc('w-token'),
      }
    }
    fs.writeFileSync(filePath, JSON.stringify(legacyStore), 'utf-8')

    expect(await getSkillEnv('weather', 'API_KEY')).toBe('w-key')

    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
    expect(raw.items['skill:weather:API_KEY']).toBe(enc('w-key'))
    expect(raw.items['skill:weather:TOKEN']).toBe(enc('w-token'))
    expect(raw.items['skill:stock:TOKEN']).toBe(enc('s-token'))
    // 旧 key 全部清除（排序后比较，避免顺序敏感）
    expect(
      Object.keys(raw.items).filter(k => k.startsWith('skill:')).sort()
    ).toEqual([
      'skill:stock:TOKEN',
      'skill:weather:API_KEY',
      'skill:weather:TOKEN',
    ])
  })
})
