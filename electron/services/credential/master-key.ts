/**
 * 主密钥层（C 方案）
 *
 * 目标：在保留"无主密码、对用户无感"体验的前提下，把凭证加密从 Electron
 * `safeStorage`（绑定 OS 身份 / app 签名，跨机器不可迁移、跨 build 不稳定）
 * 切换为代码自管的自派生密钥，使得：
 *
 * - 跨机器迁移：把 `{userData}/credentials.json` 和 `master.key` 一起拷过去就能解密
 * - 跨 app 兼容：dev / packaged / 同源多 binary 共用同一份 userData 时不再互相打架
 * - 统一加密：所有敏感凭证（含旧版 IM 明文）都走同一通道
 * - 反盗用门槛：盗走 `credentials.json` 单文件无法解密，必须同时拿到 `master.key`
 *   或反编译二进制拿到 `SEED`。比 safeStorage 弱在"同机其它进程拿到这两个文件即可解密"，
 *   但 safeStorage 在跨 build/跨产品场景下本来就不可靠，权衡后接受。
 *
 * 密钥派生：`PBKDF2(SEED, salt, 200k, 32B, sha256)` → AES-256-GCM
 *   - SEED：硬编码在二进制里，所有用户共享（提供"反盗用单文件"门槛）
 *   - salt：每 userData 目录独有的 16B 随机盐，明文存 `master.key`（防止只靠 SEED 的全用户统一密钥）
 *
 * 密文格式：`g1:` + base64(iv[12] || ciphertext || tag[16])
 */

import { app } from 'electron'
import * as crypto from 'crypto'
import { promises as fs, constants as fsConstants } from 'fs'
import * as path from 'path'
import { createLogger } from '../../utils/logger'

const log = createLogger('MasterKey')

/** 派生迭代次数：200k，在 macOS M 系列约 60ms 量级，启动一次可接受。 */
const PBKDF2_ITERATIONS = 200_000
const KEY_LEN = 32 // AES-256
const SALT_LEN = 16
const IV_LEN = 12 // GCM 推荐 12 字节
const TAG_LEN = 16

/**
 * 内嵌种子。32 字节随机串，编译进二进制。
 *
 * 安全模型：本种子不是"主密钥"，只是 PBKDF2 的 password 之一；真正的主密钥
 * 由本种子 + 用户目录独有的 `master.key` salt 共同派生。盗走 `credentials.json`
 * 单文件无法解密，必须同时拿到 `master.key`（或反编译二进制拿 SEED）。
 *
 * 不要随意修改——一旦改动，旧 `g1:` 凭证全部无法解密，等同于全量重置。
 */
const SEED = Buffer.from(
  'SFTerm-v1-seed-7d3e9f1a4b6c2e8d5a0f3b7c9e1d4a6f8b2e5c7d9a1b3e6f0c2d4a8b6e1f3c5d7',
  'utf-8'
)

/** master.key 文件名（放在 userData 根目录） */
const MASTER_KEY_FILE = 'master.key'

/** `g1:` 前缀标记 */
const G1_PREFIX = 'g1:'

/**
 * 主密钥管理器。
 *
 * 职责：
 * - 懒加载并缓存 `{userData}/master.key` 中的 salt（每进程一次）
 * - 派生 AES-256 key（PBKDF2，缓存于内存）
 * - 提供 `encrypt(plain)` / `decrypt(stored)` 纯函数式 API
 *
 * 设计：salt 文件不存在时自动生成；派生过程只发生一次（首次加密或解密 g1 时）。
 */
export class MasterKey {
  private _salt: Buffer | null = null
  private _key: Buffer | null = null
  /** salt 加载 in-flight promise，避免并发首次解密各自读盘 */
  private _saltPromise: Promise<Buffer> | null = null
  /** 已尝试过且成功的文件路径（用于 getMasterKeyFilePath 暴露给备份/导出） */
  private _filePath: string | null = null

  /**
   * 返回 master.key 文件绝对路径。
   * 即使文件尚未创建也返回预期路径，调用方可用于备份/迁移。
   */
  getMasterKeyFilePath(): string {
    return path.join(this._getUserDataPath(), MASTER_KEY_FILE)
  }

  /**
   * 加密明文为 `g1:<base64>` 字符串。
   * 内部生成随机 IV，输出格式：base64(iv || ciphertext || tag)。
   */
  async encrypt(plain: string): Promise<string> {
    const key = await this.getOrCreateKey()
    const iv = crypto.randomBytes(IV_LEN)
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
    const ct = Buffer.concat([cipher.update(plain, 'utf-8'), cipher.final()])
    const tag = cipher.getAuthTag()
    const blob = Buffer.concat([iv, ct, tag])
    return G1_PREFIX + blob.toString('base64')
  }

  /**
   * 解密 `g1:<base64>` 字符串为明文。
   * 认证失败（tag 不匹配 / 文件被篡改）会抛错。
   */
  async decrypt(stored: string): Promise<string> {
    if (!stored.startsWith(G1_PREFIX)) {
      throw new Error('Not a g1: credential value')
    }
    const blob = Buffer.from(stored.slice(G1_PREFIX.length), 'base64')
    if (blob.length < IV_LEN + TAG_LEN) {
      throw new Error('g1: credential too short')
    }
    const iv = blob.subarray(0, IV_LEN)
    const tag = blob.subarray(blob.length - TAG_LEN)
    const ct = blob.subarray(IV_LEN, blob.length - TAG_LEN)
    const key = await this.getOrCreateKey()
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(tag)
    try {
      return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf-8')
    } catch (err) {
      throw new Error(`g1: decryption failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** 判断字符串是否为 g1: 格式（用于调用方分流） */
  isG1(stored: string): boolean {
    return stored.startsWith(G1_PREFIX)
  }

  /**
   * 拿到或创建主密钥（懒加载）。
   * 首次调用时若 master.key 不存在，生成新 salt 并落盘（权限 0o600）。
   * 后续调用直接用缓存的派生 key。
   */
  private async getOrCreateKey(): Promise<Buffer> {
    if (this._key) return this._key
    // 并发去重：多个 decryptValue 同时首次触发时共享同一个 salt 加载 promise
    if (!this._saltPromise) {
      this._saltPromise = this.loadOrCreateSalt()
    }
    const salt = await this._saltPromise
    this._saltPromise = null
    // loadOrCreateSalt 可能在 EEXIST 分支里已经派生并缓存了 key
    if (this._key) return this._key
    this._key = crypto.pbkdf2Sync(SEED, salt, PBKDF2_ITERATIONS, KEY_LEN, 'sha256')
    return this._key
  }

  /**
   * 加载 salt 文件；不存在则生成新的并落盘。
   * 同一进程内 salt 缓存，避免重复 IO。
   */
  private async loadOrCreateSalt(): Promise<Buffer> {
    if (this._salt) return this._salt
    const filePath = this.getMasterKeyFilePath()
    this._filePath = filePath

    let salt: Buffer | null = null
    let invalidateExisting = false
    try {
      // 显式校验权限：若文件对 group/other 可读则视为不可信，重建
      const stat = await fs.stat(filePath)
      const mode = stat.mode & 0o077
      if (mode !== 0 && process.platform !== 'win32') {
        log.warn(`master.key has insecure mode ${stat.mode.toString(8)}, regenerating`)
        invalidateExisting = true
      } else {
        salt = await fs.readFile(filePath)
        if (salt.length !== SALT_LEN) {
          log.warn(`master.key size ${salt.length} != ${SALT_LEN}, regenerating`)
          invalidateExisting = true
          salt = null
        }
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') {
        log.warn('Failed to read master.key, will regenerate', err)
      }
      salt = null
    }

    if (!salt) {
      // 旧文件不可信（权限/大小异常）时先删除，让 persistSalt 走全新创建路径
      if (invalidateExisting) {
        try { await fs.unlink(filePath) } catch { /* ignore */ }
      }
      salt = crypto.randomBytes(SALT_LEN)
      await this.persistSalt(filePath, salt)
    }

    this._salt = salt
    return salt
  }

  /**
   * 原子写入 salt 文件，权限 0o600。
   * 写入前再次确认文件不存在（防并发进程重复写），存在则读取对方的盐以保持一致。
   */
  private async persistSalt(filePath: string, salt: Buffer): Promise<void> {
    const dir = path.dirname(filePath)
    await fs.mkdir(dir, { recursive: true })

    // 防止多进程同时首次创建：先尝试独占创建
    try {
      const handle = await fs.open(filePath, 'wx', 0o600)
      await handle.writeFile(salt)
      await handle.close()
      log.info(`Created new master.key at ${filePath}`)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'EEXIST') {
        // 另一个进程刚写好，读取它的 salt 保证一致
        try {
          const existing = await fs.readFile(filePath)
          if (existing.length === SALT_LEN) {
            this._salt = existing
            // 同步派生 key，避免后续读到内存里不一致
            this._key = crypto.pbkdf2Sync(SEED, existing, PBKDF2_ITERATIONS, KEY_LEN, 'sha256')
            return
          }
        } catch (readErr) {
          log.warn('Failed to read existing master.key after EEXIST', readErr)
        }
        // 读取失败或长度异常：尝试覆盖（best-effort，权限校验在 loadOrCreateSalt 入口保证）
        await fs.writeFile(filePath, salt, { mode: 0o600 })
      } else {
        throw err
      }
    }
  }

  private _getUserDataPath(): string {
    // CLI 模式下 app 可能被 shim 替换，但仍提供 getPath('userData')
    return app.getPath('userData')
  }
}
