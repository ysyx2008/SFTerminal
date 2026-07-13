/**
 * 凭据存储服务
 *
 * 把所有敏感信息（邮箱密码、日历密码、OAuth2 token、IM 凭证、堡垒机密码、
 * 第三方平台 token）统一加密后写入 `{userData}/credentials.json`。
 *
 * ## 加密格式
 *
 * - `g1:` —— **当前推荐**。代码自管的主密钥（`MasterKey` 类，PBKDF2 + AES-256-GCM），
 *   跨机器迁移只需把 `credentials.json` 和 `master.key` 一起拷走。详见 `credential/master-key.ts`。
 * - `e1:` —— **历史兼容**。Electron `safeStorage` 加密（macOS Keychain / Windows DPAPI）。
 *   不再写新 e1，但启动时仍能读取旧数据并自动转 g1。safeStorage 的 Keychain ACL
 *   跨版本/跨 build 会失效，此时旧 e1: 密文永久不可恢复（旧 Keychain 主密钥已丢失），
 *   `getCredential` 检测到这种坏 e1: 数据会自动删除条目，避免反复弹窗 + 刷错误日志。
 * - `p:`  —— base64 明文，safeStorage 与 master.key 都不可用时的兜底降级。
 *
 * 历史上敏感信息分散在 keytar 的多个 Keychain item 中，每个 item 都要单独
 * 授权一次。本服务现在只负责新格式，但保留了对旧 keytar 数据的「懒迁移」：
 * 当新存储里没有某个 key 时，会回退到 keytar 读取，读到后顺手写入新存储，
 * 这样旧用户升级后只在「首次访问某个旧账户」时弹一次窗，之后再也不弹。
 */

import { app, safeStorage } from 'electron'
import { promises as fs } from 'fs'
import path from 'path'
import { createLogger } from '../utils/logger'
import { MasterKey } from './credential/master-key'

const log = createLogger('Credential')

/** keytar 时代的 service 名称，仅用于读取/清理旧数据，不再写入 */
const LEGACY_SERVICE_NAME = 'SFTerminal'

interface CredentialStoreFile {
  schemaVersion: number
  /**
   * 每个 value 的格式为 `<scheme>:<base64>`：
   *   - `g1:` → MasterKey 自管密钥加密（AES-256-GCM，推荐）
   *   - `e1:` → safeStorage 加密后的密文（仅历史兼容，不再写入）
   *   - `p:`  → base64 明文（兜底降级）
   */
  items: Record<string, string>
}

/**
 * CredentialService —— 凭据读写核心（OOP）。
 *
 * 所有状态（内存缓存、写队列、keytar 句柄、MasterKey 实例）都封装在类实例里，
 * 便于测试时构造独立实例。模块级导出的 `getCredential` / `setCredential` 等函数
 * 转发给默认单例，保持调用方零改动。
 */
export class CredentialService {
  /** 最近一次加载的内存缓存 */
  private _cache: CredentialStoreFile | null = null
  /** 首次加载的 in-flight promise，避免并发 read 触发多次 IO */
  private _cachePromise: Promise<CredentialStoreFile> | null = null
  /** 写操作串行化队列，避免并发 set/delete 导致丢失 */
  private _writeQueue: Promise<unknown> = Promise.resolve()

  /** keytar 句柄懒加载缓存 */
  private _keytarModule: typeof import('keytar') | null | undefined = undefined

  /** 主密钥管理器（MasterKey 内部再懒加载 salt 与派生 key） */
  private readonly _masterKey = new MasterKey()

  /**
   * skill env 凭据的 schema 版本：2 = envName 强制大写存储（v1→v2 时一次性迁移）。
   * 与主 schema 独立，用于凭据自身的轻量级结构演进。
   */
  private static readonly SKILL_ENV_SCHEMA_VERSION = 2

  // ============ 存储路径 ============

  getStorePath(): string {
    // CLI 与桌面共用同一凭据文件 + master.key（userData 已由 bootstrap / CLI shim 对齐）。
    // 隔离测试用 SFT_DATA_DIR，不再使用 credentials-cli.json。
    return path.join(app.getPath('userData'), 'credentials.json')
  }

  /** master.key 文件路径（暴露给备份/导出迁移） */
  getMasterKeyFilePath(): string {
    return this._masterKey.getMasterKeyFilePath()
  }

  // ============ 加密原语 ============

  private isSafeStorageAvailable(): boolean {
    try {
      return safeStorage.isEncryptionAvailable()
    } catch {
      return false
    }
  }

  /**
   * 把明文加密为 `<scheme>:<base64>` 字符串。
   * 优先 `g1:`（自管密钥）；master.key 初始化失败时降级到 `p:` 明文。
   * 旧 `e1:`（safeStorage）不再主动写入。
   */
  async encryptValue(plain: string): Promise<string> {
    try {
      return await this._masterKey.encrypt(plain)
    } catch (err) {
      log.error('MasterKey encrypt failed, falling back to plain base64', err)
      // best-effort：至少保证能写盘读回，不丢用户数据
      return 'p:' + Buffer.from(plain, 'utf-8').toString('base64')
    }
  }

  /**
   * 解密 `<scheme>:<base64>` 字符串。
   *
   * - `g1:`（自管密钥）：解密失败抛错（密钥/数据异常，调用方应感知）
   * - `e1:`（safeStorage，历史）：解密失败返回 null（Keychain ACL 跨版本失效是已知场景，
   *   数据已不可恢复，由 `getCredential` 负责清理坏条目）
   * - `p:`（明文）：直接读
   */
  async decryptValue(stored: string): Promise<string | null> {
    if (this._masterKey.isG1(stored)) {
      return await this._masterKey.decrypt(stored)
    }
    if (stored.startsWith('e1:')) {
      if (!this.isSafeStorageAvailable()) return null
      try {
        const buf = Buffer.from(stored.slice(3), 'base64')
        return safeStorage.decryptString(buf)
      } catch (err) {
        log.warn('e1: credential decryption failed (safeStorage ACL changed or key lost)', err)
        return null
      }
    }
    if (stored.startsWith('p:')) {
      return Buffer.from(stored.slice(2), 'base64').toString('utf-8')
    }
    throw new Error('Unknown credential value format')
  }

  // ============ 加载 / 落盘 ============

  async loadStore(): Promise<CredentialStoreFile> {
    if (this._cache) return this._cache
    if (this._cachePromise) return this._cachePromise
    this._cachePromise = (async () => {
      const filePath = this.getStorePath()
      let loadedFromDisk = false
      let store: CredentialStoreFile
      try {
        const raw = await fs.readFile(filePath, 'utf-8')
        const parsed = JSON.parse(raw)
        if (parsed && typeof parsed === 'object' && parsed.items && typeof parsed.items === 'object') {
          store = {
            schemaVersion: typeof parsed.schemaVersion === 'number' ? parsed.schemaVersion : 1,
            items: parsed.items as Record<string, string>
          }
          loadedFromDisk = true
        } else {
          log.warn(`Credential store at ${filePath} has unexpected shape, treating as empty`)
          store = { schemaVersion: CredentialService.SKILL_ENV_SCHEMA_VERSION, items: {} }
        }
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code !== 'ENOENT') {
          log.warn(`Failed to read credential store, treating as empty`, err)
        }
        store = { schemaVersion: CredentialService.SKILL_ENV_SCHEMA_VERSION, items: {} }
      }
      // 首次从磁盘加载到旧版本时，立刻迁移；保证 _cache 落定时就是迁移后状态，
      // 并发的 loadStore 调用 await 同一个 promise 拿到的也是迁移后的 store。
      if (loadedFromDisk && store.schemaVersion < CredentialService.SKILL_ENV_SCHEMA_VERSION) {
        let changed = false
        if (store.schemaVersion < 2) {
          if (this.migrateSkillEnvToUpperCase(store)) changed = true
          store.schemaVersion = 2
        }
        if (changed) {
          try {
            await this.persistStore(store)
            log.info(`Credential store migrated to schema v${CredentialService.SKILL_ENV_SCHEMA_VERSION}`)
          } catch (err) {
            log.error('Failed to persist migrated credential store', err)
            // 内存里的 store 已迁移，后续读写仍正确，只是磁盘滞后
          }
        } else {
          // 即使没数据变化，也把 schemaVersion 标记为最新并落盘一次，避免下次启动重复扫描
          try {
            await this.persistStore(store)
          } catch (err) {
            log.error('Failed to persist schema version bump', err)
          }
        }
      }
      this._cache = store
      return this._cache
    })()
    try {
      return await this._cachePromise
    } finally {
      this._cachePromise = null
    }
  }

  async persistStore(store: CredentialStoreFile): Promise<void> {
    const filePath = this.getStorePath()
    const tmp = filePath + '.tmp'
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    const payload = JSON.stringify(store, null, 2)
    // 先写到临时文件再 rename，保证原子性；权限 0o600 限定只有所有者可读写。
    await fs.writeFile(tmp, payload, { encoding: 'utf-8', mode: 0o600 })
    await fs.rename(tmp, filePath)
  }

  enqueueWrite<T>(fn: () => Promise<T>): Promise<T> {
    const next = this._writeQueue.then(fn, fn)
    this._writeQueue = next.then(
      () => undefined,
      () => undefined
    )
    return next
  }

  // ============ 旧 keytar 数据的懒兼容（只读 + 静默删除） ============

  private async getKeytar(): Promise<typeof import('keytar') | null> {
    if (this._keytarModule !== undefined) return this._keytarModule
    try {
      const imported = await import('keytar')
      this._keytarModule = (imported as unknown as { default?: typeof import('keytar') }).default ?? imported
    } catch (err) {
      log.warn('keytar unavailable, legacy credential migration disabled', err)
      this._keytarModule = null
    }
    return this._keytarModule
  }

  async readLegacyKeytar(key: string): Promise<string | null> {
    const kt = await this.getKeytar()
    if (!kt) return null
    try {
      return await kt.getPassword(LEGACY_SERVICE_NAME, key)
    } catch (err) {
      log.warn(`Failed to read legacy keytar credential: ${key}`, err)
      return null
    }
  }

  async deleteLegacyKeytarSilent(key: string): Promise<void> {
    const kt = await this.getKeytar()
    if (!kt) return
    try {
      await kt.deletePassword(LEGACY_SERVICE_NAME, key)
    } catch {
      // best-effort：在某些平台上 deletePassword 也会触发 ACL 弹窗，
      // 失败时静默忽略，残留数据可由用户在系统钥匙串里手动清理。
    }
  }

  // ============ 公开 API ============

  /**
   * 存储凭据。
   * @param key 凭据键名（如 email 账户 ID、`feishu:user_oauth`）
   * @param secret 凭据值（密码、token JSON 等）
   */
  async setCredential(key: string, secret: string): Promise<void> {
    await this.enqueueWrite(async () => {
      const store = await this.loadStore()
      const previous = Object.prototype.hasOwnProperty.call(store.items, key)
        ? store.items[key]
        : undefined
      store.items[key] = await this.encryptValue(secret)
      try {
        await this.persistStore(store)
      } catch (err) {
        // 持久化失败时回滚内存缓存，避免和磁盘不一致
        if (previous === undefined) {
          delete store.items[key]
        } else {
          store.items[key] = previous
        }
        throw err
      }
      log.info(`Credential stored: ${key}`)
    })
  }

  /**
   * 读取凭据；新存储里没有时回退到旧 keytar 并自动迁移。
   *
   * 坏 e1: 数据自愈：safeStorage 的 Keychain ACL 跨版本/跨 build 会失效，
   * 此时 e1: 密文永久不可恢复（旧 Keychain 主密钥已丢失）。`decryptValue` 对
   * e1: 失败返回 null，这里检测到这种情况后顺手删除坏条目，避免反复触发
   * Keychain 弹窗 + 刷错误日志。用户下次需要该凭据时会走"首次配置"流程。
   *
   * 注意：g1: 解密失败（master.key 损坏/数据篡改）仍会抛错传播给调用方--
   * 这是致命错误，不该被静默吞掉。e1: 失败是已知的历史兼容场景，才走自愈。
   * @returns 凭据值，不存在或 e1: 解密失败返回 null
   */
  async getCredential(key: string): Promise<string | null> {
    const store = await this.loadStore()
    const stored = store.items[key]
    if (stored !== undefined) {
      // g1: 解密失败会抛错（master.key 损坏是致命错误，应传播）；
      // e1: 解密失败返回 null（已知场景，下面走自愈删除）
      const plain = await this.decryptValue(stored)
      if (plain !== null) return plain
      // 到这里只可能是 e1:（safeStorage 失败）。先从内存缓存移除该 key，
      // 阻止并发的 getCredential 再次触发 safeStorage 解密（重复弹窗），
      // 再落盘删除。落盘失败时静默回滚内存，下次访问会再尝试自愈。
      delete store.items[key]
      try {
        await this.persistStore(store)
        log.warn(`Removed undecryptable e1: credential (Keychain ACL lost): ${key}`)
      } catch (err) {
        store.items[key] = stored
        log.warn(`Failed to remove undecryptable e1: credential: ${key}`, err)
      }
      return null
    }
    // fallback：兼容旧 keytar 数据，第一次读到后顺手迁移
    const legacy = await this.readLegacyKeytar(key)
    if (legacy !== null) {
      log.info(`Migrating legacy keytar credential to new store: ${key}`)
      try {
        await this.setCredential(key, legacy)
      } catch (err) {
        log.warn(`Failed to persist migrated credential: ${key}`, err)
      }
      return legacy
    }
    return null
  }

  /**
   * 删除凭据；同时尽力清理旧 keytar 残留。
   * @returns 是否真的删除了某个条目
   */
  async deleteCredential(key: string): Promise<boolean> {
    const removed = await this.enqueueWrite(async () => {
      const store = await this.loadStore()
      if (!Object.prototype.hasOwnProperty.call(store.items, key)) {
        return false
      }
      const previous = store.items[key]
      delete store.items[key]
      try {
        await this.persistStore(store)
      } catch (err) {
        // 持久化失败时回滚内存缓存
        store.items[key] = previous
        throw err
      }
      return true
    })
    await this.deleteLegacyKeytarSilent(key)
    if (removed) {
      log.info(`Credential deleted: ${key}`)
    }
    return removed
  }

  /**
   * 列出所有已存储的凭据键名。
   * 仅扫描新存储；旧 keytar 数据不会在这里出现，访问对应账户时会按需懒迁移。
   * @param prefix 可选前缀过滤
   */
  async listCredentials(prefix?: string): Promise<string[]> {
    const store = await this.loadStore()
    let keys = Object.keys(store.items)
    if (prefix) {
      keys = keys.filter(k => k.startsWith(prefix))
    }
    return keys
  }

  // ============ 邮箱专用方法 ============

  private static readonly EMAIL_PREFIX = 'email:'

  async setEmailCredential(accountId: string, credential: string): Promise<void> {
    await this.setCredential(`${CredentialService.EMAIL_PREFIX}${accountId}`, credential)
  }

  async getEmailCredential(accountId: string): Promise<string | null> {
    return await this.getCredential(`${CredentialService.EMAIL_PREFIX}${accountId}`)
  }

  async deleteEmailCredential(accountId: string): Promise<boolean> {
    return await this.deleteCredential(`${CredentialService.EMAIL_PREFIX}${accountId}`)
  }

  // ============ 日历专用方法 ============

  private static readonly CALENDAR_PREFIX = 'calendar:'

  async setCalendarCredential(accountId: string, credential: string): Promise<void> {
    await this.setCredential(`${CredentialService.CALENDAR_PREFIX}${accountId}`, credential)
  }

  async getCalendarCredential(accountId: string): Promise<string | null> {
    return await this.getCredential(`${CredentialService.CALENDAR_PREFIX}${accountId}`)
  }

  async deleteCalendarCredential(accountId: string): Promise<boolean> {
    return await this.deleteCredential(`${CredentialService.CALENDAR_PREFIX}${accountId}`)
  }

  // ============ OAuth2 Token ============

  async setOAuth2Token(accountId: string, token: OAuth2Token): Promise<void> {
    await this.setEmailCredential(accountId, JSON.stringify(token))
  }

  /**
   * 读取 OAuth2 Token。
   * 即使已过期也照常返回，由调用者用 refreshToken 自行续期。
   */
  async getOAuth2Token(accountId: string): Promise<OAuth2Token | null> {
    const credential = await this.getEmailCredential(accountId)
    if (!credential) return null
    try {
      const token = JSON.parse(credential) as OAuth2Token
      if (token.expiresAt && Date.now() > token.expiresAt - 5 * 60 * 1000) {
        log.info(`OAuth2 token expired for: ${accountId}`)
      }
      return token
    } catch {
      return null
    }
  }

  // ============ 技能 env 凭据 ============

  private static readonly SKILL_ENV_PREFIX = 'skill:'

  /**
   * 存储技能 env 凭据（API Key 等）。
   * key 格式：`skill:<skillId>:<ENV_NAME>`，envName 统一转大写后再落盘，
   * 避免前端 IPC / Agent 工具 / 老数据混用大小写导致同一变量名分裂成两条记录。
   */
  async setSkillEnv(skillId: string, envName: string, value: string): Promise<void> {
    await this.setCredential(
      `${CredentialService.SKILL_ENV_PREFIX}${skillId}:${envName.toUpperCase()}`,
      value
    )
  }

  /**
   * 读取技能 env 凭据。不存在返回 null。
   */
  async getSkillEnv(skillId: string, envName: string): Promise<string | null> {
    return await this.getCredential(
      `${CredentialService.SKILL_ENV_PREFIX}${skillId}:${envName.toUpperCase()}`
    )
  }

  /**
   * 删除技能 env 凭据。
   */
  async deleteSkillEnv(skillId: string, envName: string): Promise<boolean> {
    return await this.deleteCredential(
      `${CredentialService.SKILL_ENV_PREFIX}${skillId}:${envName.toUpperCase()}`
    )
  }

  /**
   * 列出某个技能已存储的所有 env 名称（不含值，已是大写）。
   */
  async listSkillEnvNames(skillId: string): Promise<string[]> {
    const prefix = `${CredentialService.SKILL_ENV_PREFIX}${skillId}:`
    const keys = await this.listCredentials(prefix)
    return keys.map(k => k.slice(prefix.length)).filter(Boolean)
  }

  /**
   * 读取某个技能的所有 env 键值对（用于子进程注入）。
   * 返回的 key 是存储时的大写名；调用方负责按 SKILL.md 声明的大小写映射后再注入。
   * 返回 `{ ENV_NAME: 'value', ... }`，只包含已配置的项。
   */
  async getSkillEnvMap(skillId: string): Promise<Record<string, string>> {
    const names = await this.listSkillEnvNames(skillId)
    const result: Record<string, string> = {}
    await Promise.all(
      names.map(async (name) => {
        const val = await this.getSkillEnv(skillId, name)
        if (val !== null) result[name] = val
      })
    )
    return result
  }

  /**
   * 读取某个 key 在 store 里的原始密文字符串（含 scheme 前缀）。
   * 仅用于 migration 判断 scheme（e1: → g1: 升级扫描）；正常运行时调用方
   * 应使用 `getCredential` 拿明文。
   * @internal
   */
  async __getRawValueForMigration(key: string): Promise<string | undefined> {
    const store = await this.loadStore()
    return store.items[key]
  }

  // ============ 一次性迁移：skill env v1→v2 大小写归一化 ============

  /**
   * 把所有 `skill:<id>:<envName>` 的 envName 归一化为大写。
   * 处理 v1（混合大小写）→ v2（统一大写）的升级场景。同一 (skillId, UPPER_ENV) 下若已有
   * 大写记录，小写记录直接丢弃（以大写为准，避免覆盖用户最新配置）。
   * 幂等：已是 v2 的 store 不会再扫描。
   */
  private migrateSkillEnvToUpperCase(store: CredentialStoreFile): boolean {
    if (store.schemaVersion >= CredentialService.SKILL_ENV_SCHEMA_VERSION) return false
    const items = store.items
    // key 形如 `skill:<skillId>:<envName>`，按 (skillId, UPPER_ENV) 分桶收集需要迁移的小写条目
    const grouped = new Map<string, { skillId: string; upperEnv: string; originalKeys: string[] }>()
    for (const key of Object.keys(items)) {
      if (!key.startsWith(CredentialService.SKILL_ENV_PREFIX)) continue
      const rest = key.slice(CredentialService.SKILL_ENV_PREFIX.length)
      const colonIdx = rest.indexOf(':')
      if (colonIdx < 0) continue // 不符合 skill:id:name 结构
      const skillId = rest.slice(0, colonIdx)
      const envName = rest.slice(colonIdx + 1)
      if (!envName) continue
      const upperEnv = envName.toUpperCase()
      if (envName === upperEnv) continue // 已是大写，无需迁移
      const bucketKey = `${skillId}:${upperEnv}`
      let bucket = grouped.get(bucketKey)
      if (!bucket) {
        bucket = { skillId, upperEnv, originalKeys: [] }
        grouped.set(bucketKey, bucket)
      }
      bucket.originalKeys.push(key)
    }

    let changed = false
    for (const { skillId, upperEnv, originalKeys } of grouped.values()) {
      const upperKey = `${CredentialService.SKILL_ENV_PREFIX}${skillId}:${upperEnv}`
      const hasUpperAlready = items[upperKey] !== undefined
      if (originalKeys.length > 1) {
        log.warn(
          `Skill ${skillId} has ${originalKeys.length} lowercase variants for ${upperEnv} ` +
          `(${originalKeys.map(k => k.slice(CredentialService.SKILL_ENV_PREFIX.length + skillId.length + 1)).join(', ')}); ` +
          `keeping ${hasUpperAlready ? 'existing uppercase record' : 'first lowercase value'}, discarding the rest`
        )
      }
      for (const originalKey of originalKeys) {
        if (!hasUpperAlready) {
          // 没有大写版本：把第一条小写记录升级为大写
          items[upperKey] = items[originalKey]
        }
        // 已有大写版本则直接丢弃小写记录（大写优先，避免覆盖）
        delete items[originalKey]
        changed = true
      }
    }

    if (changed) {
      log.info(`Migrated skill env keys to uppercase (schema v1→v2)`)
    }
    return changed
  }

  // ============ 测试辅助：仅用于单元测试时重置内存状态 ============

  /** @internal */
  resetCacheForTests(): void {
    this._cache = null
    this._cachePromise = null
    this._writeQueue = Promise.resolve()
    this._keytarModule = undefined
  }
}

export interface OAuth2Token {
  accessToken: string
  refreshToken?: string
  /** Unix 毫秒时间戳 */
  expiresAt?: number
  tokenType?: string
}

// ============ 模块级单例 + 函数式 re-export（兼容现有调用方） ============

let _default: CredentialService | null = null

export function getDefaultCredentialService(): CredentialService {
  if (!_default) _default = new CredentialService()
  return _default
}

/** @deprecated 新代码请用 getDefaultCredentialService().setCredential */
export async function setCredential(key: string, secret: string): Promise<void> {
  await getDefaultCredentialService().setCredential(key, secret)
}

/** @deprecated 新代码请用 getDefaultCredentialService().getCredential */
export async function getCredential(key: string): Promise<string | null> {
  return await getDefaultCredentialService().getCredential(key)
}

/** @deprecated 新代码请用 getDefaultCredentialService().deleteCredential */
export async function deleteCredential(key: string): Promise<boolean> {
  return await getDefaultCredentialService().deleteCredential(key)
}

/** @deprecated 新代码请用 getDefaultCredentialService().listCredentials */
export async function listCredentials(prefix?: string): Promise<string[]> {
  return await getDefaultCredentialService().listCredentials(prefix)
}

// ============ 邮箱专用方法 ============

/** @deprecated 用 getDefaultCredentialService().setEmailCredential */
export async function setEmailCredential(accountId: string, credential: string): Promise<void> {
  await getDefaultCredentialService().setEmailCredential(accountId, credential)
}

/** @deprecated 用 getDefaultCredentialService().getEmailCredential */
export async function getEmailCredential(accountId: string): Promise<string | null> {
  return await getDefaultCredentialService().getEmailCredential(accountId)
}

/** @deprecated 用 getDefaultCredentialService().deleteEmailCredential */
export async function deleteEmailCredential(accountId: string): Promise<boolean> {
  return await getDefaultCredentialService().deleteEmailCredential(accountId)
}

// ============ 日历专用方法 ============

/** @deprecated 用 getDefaultCredentialService().setCalendarCredential */
export async function setCalendarCredential(accountId: string, credential: string): Promise<void> {
  await getDefaultCredentialService().setCalendarCredential(accountId, credential)
}

/** @deprecated 用 getDefaultCredentialService().getCalendarCredential */
export async function getCalendarCredential(accountId: string): Promise<string | null> {
  return await getDefaultCredentialService().getCalendarCredential(accountId)
}

/** @deprecated 用 getDefaultCredentialService().deleteCalendarCredential */
export async function deleteCalendarCredential(accountId: string): Promise<boolean> {
  return await getDefaultCredentialService().deleteCalendarCredential(accountId)
}

// ============ OAuth2 Token ============

/** @deprecated 用 getDefaultCredentialService().setOAuth2Token */
export async function setOAuth2Token(accountId: string, token: OAuth2Token): Promise<void> {
  await getDefaultCredentialService().setOAuth2Token(accountId, token)
}

/** @deprecated 用 getDefaultCredentialService().getOAuth2Token */
export async function getOAuth2Token(accountId: string): Promise<OAuth2Token | null> {
  return await getDefaultCredentialService().getOAuth2Token(accountId)
}

// ============ 技能 env 凭据 ============

/** @deprecated 用 getDefaultCredentialService().setSkillEnv */
export async function setSkillEnv(skillId: string, envName: string, value: string): Promise<void> {
  await getDefaultCredentialService().setSkillEnv(skillId, envName, value)
}

/** @deprecated 用 getDefaultCredentialService().getSkillEnv */
export async function getSkillEnv(skillId: string, envName: string): Promise<string | null> {
  return await getDefaultCredentialService().getSkillEnv(skillId, envName)
}

/** @deprecated 用 getDefaultCredentialService().deleteSkillEnv */
export async function deleteSkillEnv(skillId: string, envName: string): Promise<boolean> {
  return await getDefaultCredentialService().deleteSkillEnv(skillId, envName)
}

/** @deprecated 用 getDefaultCredentialService().listSkillEnvNames */
export async function listSkillEnvNames(skillId: string): Promise<string[]> {
  return await getDefaultCredentialService().listSkillEnvNames(skillId)
}

/** @deprecated 用 getDefaultCredentialService().getSkillEnvMap */
export async function getSkillEnvMap(skillId: string): Promise<Record<string, string>> {
  return await getDefaultCredentialService().getSkillEnvMap(skillId)
}

/**
 * 把 getSkillEnvMap 返回的「大写 key」映射回 SKILL.md 声明的原始大小写。
 * 用于注入子进程环境变量：credential 层统一大写存储，但技能脚本里读的是
 * 声明的变量名（可能是 api_key 而非 API_KEY），所以注入前要还原。
 * 未在 declaredEnvs 里声明的大写 key 原样保留（兼容老数据/未声明但已存的 key）。
 *
 * 纯函数，无副作用，便于测试。
 */
export function mapSkillEnvToDeclaredCase(
  envMap: Record<string, string>,
  declaredEnvs: string[]
): Record<string, string> {
  const upperToDeclared = new Map(declaredEnvs.map(n => [n.toUpperCase(), n]))
  const result: Record<string, string> = {}
  for (const [upperName, val] of Object.entries(envMap)) {
    result[upperToDeclared.get(upperName) ?? upperName] = val
  }
  return result
}

// ============ 测试辅助：仅用于单元测试时重置内存状态 ============

/**
 * @internal 重置默认单例的内存缓存。仅测试使用。
 * 注意：master.key 文件在测试 tmpDir 里的话，单例会重新派生 key；
 * 跨测试场景需保证 tmpDir 切换前先调用本函数。
 */
export function __resetCredentialCacheForTests(): void {
  if (_default) _default.resetCacheForTests()
  // 重建单例，保证 tmpDir 变化后 master.key 路径重新解析
  _default = null
}
