import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

let tmpDir: string

vi.mock('electron', () => ({
  app: {
    getPath: (key: string) => {
      if (key === 'userData') return tmpDir
      return tmpDir
    },
    getName: () => 'SailFish',
    getVersion: () => '1.0.0',
    isPackaged: false
  }
}))

import { MasterKey } from '../credential/master-key'

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sft-masterkey-test-'))
})

afterEach(() => {
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

describe('MasterKey - 加解密原语', () => {
  it('encrypt 输出 g1: 前缀且不含明文', async () => {
    const mk = new MasterKey()
    const ct = await mk.encrypt('super-secret-token')
    expect(ct.startsWith('g1:')).toBe(true)
    expect(ct).not.toContain('super-secret-token')
  })

  it('encrypt + decrypt 往返一致', async () => {
    const mk = new MasterKey()
    const plain = 'a'.repeat(1024) + '中文测试-!@#$%^&*()'
    const ct = await mk.encrypt(plain)
    expect(await mk.decrypt(ct)).toBe(plain)
  })

  it('同明文两次加密结果不同（IV 随机）', async () => {
    const mk = new MasterKey()
    const a = await mk.encrypt('same')
    const b = await mk.encrypt('same')
    expect(a).not.toBe(b)
    // 都能解回同明文
    expect(await mk.decrypt(a)).toBe('same')
    expect(await mk.decrypt(b)).toBe('same')
  })

  it('isG1 正确识别 g1: 前缀', async () => {
    const mk = new MasterKey()
    const ct = await mk.encrypt('x')
    expect(mk.isG1(ct)).toBe(true)
    expect(mk.isG1('e1:abc')).toBe(false)
    expect(mk.isG1('p:abc')).toBe(false)
    expect(mk.isG1('')).toBe(false)
  })
})

describe('MasterKey - 篡改与错误处理', () => {
  it('密文被篡改时 decrypt 抛错（GCM 认证失败）', async () => {
    const mk = new MasterKey()
    const ct = await mk.encrypt('original')
    // 篡改 base64 部分的最后一个字符
    const prefix = 'g1:'
    const b64 = ct.slice(prefix.length)
    const tampered = prefix + b64.slice(0, -2) + (b64.slice(-2) === 'AA' ? 'BB' : 'AA')
    await expect(mk.decrypt(tampered)).rejects.toThrow(/decryption failed/)
  })

  it('g1: 数据过短时 decrypt 抛错', async () => {
    const mk = new MasterKey()
    const short = 'g1:' + Buffer.from('tooshort').toString('base64')
    await expect(mk.decrypt(short)).rejects.toThrow(/too short/)
  })

  it('非 g1: 字符串调用 decrypt 抛错', async () => {
    const mk = new MasterKey()
    await expect(mk.decrypt('e1:xxx')).rejects.toThrow(/Not a g1/)
  })
})

describe('MasterKey - salt 文件生命周期', () => {
  it('首次加密时自动创建 master.key 文件（权限 0o600）', async () => {
    const mk = new MasterKey()
    const keyPath = mk.getMasterKeyFilePath()
    expect(fs.existsSync(keyPath)).toBe(false)

    await mk.encrypt('trigger')

    expect(fs.existsSync(keyPath)).toBe(true)
    const stat = fs.statSync(keyPath)
    // macOS / Linux 校验权限；Windows 跳过
    if (process.platform !== 'win32') {
      expect(stat.mode & 0o077).toBe(0)
    }
    // 文件大小 = SALT_LEN (16)
    expect(stat.size).toBe(16)
  })

  it('同一 MasterKey 实例多次加密只创建一次 salt', async () => {
    const mk = new MasterKey()
    await mk.encrypt('a')
    const keyPath = mk.getMasterKeyFilePath()
    const saltAfterFirst = fs.readFileSync(keyPath)

    await mk.encrypt('b')
    await mk.encrypt('c')
    const saltAfterThird = fs.readFileSync(keyPath)

    expect(saltAfterFirst.equals(saltAfterThird)).toBe(true)
  })

  it('新实例复用已存在的 master.key（同 salt → 同 key）', async () => {
    const mk1 = new MasterKey()
    await mk1.encrypt('seed-data')
    const keyPath = mk1.getMasterKeyFilePath()
    const saltOnDisk = fs.readFileSync(keyPath)

    // 新实例：salt 已存在，应直接读取而不是重新生成
    const mk2 = new MasterKey()
    const ct = await mk2.encrypt('hello')
    const saltStillSame = fs.readFileSync(keyPath)
    expect(saltStillSame.equals(saltOnDisk)).toBe(true)

    // mk1 加密的 mk2 能解（同 key）
    const ct1 = await mk1.encrypt('cross-instance')
    expect(await mk2.decrypt(ct1)).toBe('cross-instance')
    expect(await mk1.decrypt(ct)).toBe('hello')
  })

  it('不同 userData 目录产生不同 salt，无法互相解密', async () => {
    // 目录 A
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sft-mk-A-'))
    const mkA = new MasterKey()
    const ctA = await mkA.encrypt('from-A')
    const saltA = fs.readFileSync(mkA.getMasterKeyFilePath())

    // 切到目录 B
    const dirA = tmpDir
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sft-mk-B-'))
    try {
      const mkB = new MasterKey()
      // B 没有这条记录，但即使把 ctA 拷过来也解不开（key 不同）
      await expect(mkB.decrypt(ctA)).rejects.toThrow()
      const saltB = fs.readFileSync(mkB.getMasterKeyFilePath())
      expect(saltA.equals(saltB)).toBe(false)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
      tmpDir = dirA
    }
  })

  it('master.key 文件权限不安全时重新生成', async () => {
    if (process.platform === 'win32') return // Windows 跳过权限测试

    const mk1 = new MasterKey()
    await mk1.encrypt('first')
    const keyPath = mk1.getMasterKeyFilePath()
    const originalSalt = fs.readFileSync(keyPath)

    // 故意把权限改成 0o644（group/other 可读）
    fs.chmodSync(keyPath, 0o644)

    // 新实例应检测到不安全权限并重新生成
    const mk2 = new MasterKey()
    await mk2.encrypt('second')
    const regeneratedSalt = fs.readFileSync(keyPath)
    expect(regeneratedSalt.equals(originalSalt)).toBe(false)

    // 权限恢复为 0o600
    const stat = fs.statSync(keyPath)
    expect(stat.mode & 0o077).toBe(0)
  })

  it('master.key 大小异常时重新生成', async () => {
    const mk1 = new MasterKey()
    const keyPath = mk1.getMasterKeyFilePath()
    // 先写一个错误大小的文件
    fs.mkdirSync(path.dirname(keyPath), { recursive: true })
    fs.writeFileSync(keyPath, Buffer.alloc(8), { mode: 0o600 })

    const mk2 = new MasterKey()
    await mk2.encrypt('test')
    const stat = fs.statSync(keyPath)
    expect(stat.size).toBe(16) // 重新生成后是正确的 16 字节
  })
})

describe('MasterKey - getMasterKeyFilePath', () => {
  it('路径在 userData 下，文件名为 master.key', () => {
    const mk = new MasterKey()
    const p = mk.getMasterKeyFilePath()
    expect(p).toBe(path.join(tmpDir, 'master.key'))
  })

  it('文件不存在时也返回预期路径（用于备份规划）', () => {
    const mk = new MasterKey()
    const p = mk.getMasterKeyFilePath()
    expect(fs.existsSync(p)).toBe(false)
    expect(p.endsWith('master.key')).toBe(true)
  })
})
