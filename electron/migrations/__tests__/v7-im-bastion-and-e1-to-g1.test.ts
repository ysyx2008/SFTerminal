import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

let tmpDir: string

// safeStorage mock：测试里始终可用
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

import { ConfigService } from '../../services/config.service'
import { CredentialService, __resetCredentialCacheForTests } from '../../services/credential.service'
import { migrateImAndBastionSecrets, migrationV7 } from '../v7-im-bastion-and-e1-to-g1'
import type { MigrationContext } from '../types'

let configService: ConfigService
let credentialService: CredentialService

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sft-migration-v7-'))
  safeStorageEnabled = true
  configService = new ConfigService()
  credentialService = new CredentialService()
  __resetCredentialCacheForTests()
})

afterEach(() => {
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

describe('migration v7 - 明文凭证迁移', () => {
  it('config 里的明文 IM/堡垒机 secret 迁移到 credential 并清空 config 字段', async () => {
    configService.set('imDingTalkClientSecret' as any, 'dt-secret-123')
    configService.set('imFeishuAppSecret' as any, 'fs-secret-456')
    configService.set('bastionPassword' as any, 'bastion-pwd-789')

    const result = await migrateImAndBastionSecrets(configService, credentialService)

    expect(result.plaintextMigrated).toBe(3)
    expect(result.errors).toEqual([])

    // config 字段被清空
    expect(configService.get('imDingTalkClientSecret' as any)).toBe('')
    expect(configService.get('imFeishuAppSecret' as any)).toBe('')
    expect(configService.get('bastionPassword' as any)).toBe('')

    // credential 里有对应记录（g1: 格式）
    expect(await credentialService.getCredential('im:dingtalk:clientSecret')).toBe('dt-secret-123')
    expect(await credentialService.getCredential('im:feishu:appSecret')).toBe('fs-secret-456')
    expect(await credentialService.getCredential('bastion:password')).toBe('bastion-pwd-789')

    // 落盘验证：是 g1: 格式
    const raw = credentialService.__getRawValueForMigration('im:dingtalk:clientSecret')
    expect(await raw).toMatch(/^g1:/)
  })

  it('config 字段为空时跳过迁移', async () => {
    configService.set('imDingTalkClientSecret' as any, '')
    configService.set('imSlackBotToken' as any, '')

    const result = await migrateImAndBastionSecrets(configService, credentialService)

    expect(result.plaintextMigrated).toBe(0)
    expect(await credentialService.listCredentials()).toHaveLength(0)
  })

  it('所有 8 个字段都能被映射到正确的 credential key', async () => {
    const samples: Array<[string, string]> = [
      ['imDingTalkClientSecret', 'dt-secret'],
      ['imFeishuAppSecret', 'fs-secret'],
      ['imWeComSecret', 'wc-secret'],
      ['imSlackBotToken', 'slack-bot'],
      ['imSlackAppToken', 'slack-app'],
      ['imTelegramBotToken', 'tg-token'],
      ['imWeChatToken', 'wx-token'],
      ['bastionPassword', 'bastion-pwd'],
    ]
    for (const [k, v] of samples) {
      configService.set(k as any, v)
    }

    const result = await migrateImAndBastionSecrets(configService, credentialService)
    expect(result.plaintextMigrated).toBe(8)

    expect(await credentialService.getCredential('im:dingtalk:clientSecret')).toBe('dt-secret')
    expect(await credentialService.getCredential('im:feishu:appSecret')).toBe('fs-secret')
    expect(await credentialService.getCredential('im:wecom:secret')).toBe('wc-secret')
    expect(await credentialService.getCredential('im:slack:botToken')).toBe('slack-bot')
    expect(await credentialService.getCredential('im:slack:appToken')).toBe('slack-app')
    expect(await credentialService.getCredential('im:telegram:botToken')).toBe('tg-token')
    expect(await credentialService.getCredential('im:wechat:token')).toBe('wx-token')
    expect(await credentialService.getCredential('bastion:password')).toBe('bastion-pwd')
  })

  it('幂等：再次运行不重复迁移，不丢数据', async () => {
    configService.set('imDingTalkClientSecret' as any, 'dt-secret')
    await migrateImAndBastionSecrets(configService, credentialService)

    // 第二次运行：config 已空，credential 已存在
    const result = await migrateImAndBastionSecrets(configService, credentialService)
    expect(result.plaintextMigrated).toBe(0)

    // 数据仍在
    expect(await credentialService.getCredential('im:dingtalk:clientSecret')).toBe('dt-secret')
  })

  it('credential 已有同 key 时不覆盖，但仍清空 config 明文', async () => {
    // 预置 credential 里有更新值
    await credentialService.setCredential('im:dingtalk:clientSecret', 'newer-value')
    // config 里还有旧的明文
    configService.set('imDingTalkClientSecret' as any, 'old-value')

    const result = await migrateImAndBastionSecrets(configService, credentialService)

    expect(result.plaintextMigrated).toBe(0) // 没新写入
    // credential 里仍是新值（没被旧明文覆盖）
    expect(await credentialService.getCredential('im:dingtalk:clientSecret')).toBe('newer-value')
    // config 明文已被清空（避免明文残留）
    expect(configService.get('imDingTalkClientSecret' as any)).toBe('')
  })
})

describe('migration v7 - e1: 升级为 g1:', () => {
  it('credential store 里的 e1: 数据被升级为 g1:', async () => {
    // 用 mock safeStorage 构造一条 e1: 数据
    const plain = 'legacy-e1-secret'
    const buf = Buffer.from(plain, 'utf-8')
    const xored = Buffer.from(buf.map(b => b ^ 0x42))
    const combined = Buffer.concat([Buffer.from('ENC:'), xored])
    const e1Value = 'e1:' + combined.toString('base64')

    // 直接写到磁盘 credentials.json
    const credFilePath = path.join(tmpDir, 'credentials.json')
    fs.writeFileSync(credFilePath, JSON.stringify({
      schemaVersion: 2,
      items: { 'email:legacy': e1Value }
    }), 'utf-8')
    __resetCredentialCacheForTests()

    const result = await migrateImAndBastionSecrets(configService, credentialService)

    expect(result.e1Upgraded).toBe(1)
    // 升级后值能读回原明文
    expect(await credentialService.getCredential('email:legacy')).toBe(plain)
    // 磁盘上是 g1: 格式
    const raw = JSON.parse(fs.readFileSync(credFilePath, 'utf-8'))
    expect(raw.items['email:legacy']).toMatch(/^g1:/)
  })

  it('safeStorage 不可用时 e1: 跳过，保留原值', async () => {
    safeStorageEnabled = false
    const credFilePath = path.join(tmpDir, 'credentials.json')
    fs.writeFileSync(credFilePath, JSON.stringify({
      schemaVersion: 2,
      items: { 'email:broken': 'e1:AAAA' }
    }), 'utf-8')
    __resetCredentialCacheForTests()

    const result = await migrateImAndBastionSecrets(configService, credentialService)

    expect(result.e1Upgraded).toBe(0)
    // 原值保留（没被破坏）
    const raw = JSON.parse(fs.readFileSync(credFilePath, 'utf-8'))
    expect(raw.items['email:broken']).toBe('e1:AAAA')
  })

  it('g1: 和 p: 数据不被升级', async () => {
    const credFilePath = path.join(tmpDir, 'credentials.json')
    // 先用 credential.service 写一条 g1:
    await credentialService.setCredential('email:g1user', 'g1-plain')
    // 再写一条 p: 明文
    const p1Value = 'p:' + Buffer.from('p-plain', 'utf-8').toString('base64')
    const raw1 = JSON.parse(fs.readFileSync(credFilePath, 'utf-8'))
    raw1.items['email:puser'] = p1Value
    fs.writeFileSync(credFilePath, JSON.stringify(raw1), 'utf-8')
    __resetCredentialCacheForTests()

    const result = await migrateImAndBastionSecrets(configService, credentialService)

    expect(result.e1Upgraded).toBe(0) // 没有 e1: 的
    // g1 和 p 原样保留
    const raw2 = JSON.parse(fs.readFileSync(credFilePath, 'utf-8'))
    expect(raw2.items['email:g1user']).toMatch(/^g1:/)
    expect(raw2.items['email:puser']).toBe(p1Value)
  })
})

describe('migration v7 - 注册与执行', () => {
  it('version = 7, phase = early', () => {
    expect(migrationV7.version).toBe(7)
    expect(migrationV7.phase).toBe('early')
    expect(migrationV7.name).toBe('im-bastion-plaintext-and-e1-to-g1')
  })

  it('migrate 函数能直接跑（通过 MigrationContext）', async () => {
    configService.set('imDingTalkClientSecret' as any, 'direct-test')
    const ctx: MigrationContext = {
      configService,
      userDataPath: tmpDir,
    }
    await migrationV7.migrate(ctx)

    expect(configService.get('imDingTalkClientSecret' as any)).toBe('')
    // credential 已迁移（用同一个默认单例读取）
    const { getDefaultCredentialService } = await import('../../services/credential.service')
    const svc = getDefaultCredentialService()
    expect(await svc.getCredential('im:dingtalk:clientSecret')).toBe('direct-test')
  })
})
