/**
 * 凭据存储服务
 *
 * 把所有敏感信息（邮箱密码、日历密码、OAuth2 token、第三方平台 token）统一
 * 用 Electron `safeStorage` 加密后写入 `{userData}/credentials.json`：
 *
 * - macOS：safeStorage 主密钥存在 Keychain 的 "<productName> Safe Storage" item，
 *   每次进程启动只访问一次 Keychain，后续所有加解密在内存完成；
 * - Windows：DPAPI；
 * - Linux：libsecret / kwallet（可用时）；
 * - 不可用时（CLI 模式 / 缺 secret service 的 Linux）自动降级为 base64 明文存储。
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

const log = createLogger('Credential')

/** keytar 时代的 service 名称，仅用于读取/清理旧数据，不再写入 */
const LEGACY_SERVICE_NAME = 'SFTerminal'

interface CredentialStoreFile {
  schemaVersion: number
  /**
   * 每个 value 的格式为 `<scheme>:<base64>`：
   *   - `e1:` → safeStorage 加密后的密文（推荐）
   *   - `p:`  → base64 编码的明文（safeStorage 不可用时的降级）
   */
  items: Record<string, string>
}

/** 最近一次加载的内存缓存 */
let _cache: CredentialStoreFile | null = null
/** 首次加载的 in-flight promise，避免并发 read 触发多次 IO */
let _cachePromise: Promise<CredentialStoreFile> | null = null
/** 写操作串行化队列，避免并发 set/delete 导致丢失 */
let _writeQueue: Promise<unknown> = Promise.resolve()

function getStorePath(): string {
  const isCli = !!process.env.SFT_CLI_MODE
  const fileName = isCli ? 'credentials-cli.json' : 'credentials.json'
  return path.join(app.getPath('userData'), fileName)
}

function isEncryptionAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

/** 把明文加密为 `<scheme>:<base64>` 字符串 */
function encryptValue(plain: string): string {
  if (isEncryptionAvailable()) {
    const buf = safeStorage.encryptString(plain)
    return 'e1:' + buf.toString('base64')
  }
  return 'p:' + Buffer.from(plain, 'utf-8').toString('base64')
}

/** 解密 `<scheme>:<base64>` 字符串 */
function decryptValue(stored: string): string {
  if (stored.startsWith('e1:')) {
    if (!isEncryptionAvailable()) {
      throw new Error('Credential is encrypted but safeStorage is unavailable on this platform')
    }
    const buf = Buffer.from(stored.slice(3), 'base64')
    return safeStorage.decryptString(buf)
  }
  if (stored.startsWith('p:')) {
    return Buffer.from(stored.slice(2), 'base64').toString('utf-8')
  }
  throw new Error('Unknown credential value format')
}

async function loadStore(): Promise<CredentialStoreFile> {
  if (_cache) return _cache
  if (_cachePromise) return _cachePromise
  _cachePromise = (async () => {
    const filePath = getStorePath()
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
        store = { schemaVersion: SKILL_ENV_SCHEMA_VERSION, items: {} }
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') {
        log.warn(`Failed to read credential store, treating as empty`, err)
      }
      store = { schemaVersion: SKILL_ENV_SCHEMA_VERSION, items: {} }
    }
    // 首次从磁盘加载到旧版本时，立刻迁移；保证 _cache 落定时就是迁移后状态，
    // 并发的 loadStore 调用 await 同一个 promise 拿到的也是迁移后的 store。
    if (loadedFromDisk && store.schemaVersion < SKILL_ENV_SCHEMA_VERSION) {
      let changed = false
      if (store.schemaVersion < 2) {
        if (migrateSkillEnvToUpperCase(store)) changed = true
        store.schemaVersion = 2
      }
      if (changed) {
        try {
          await persistStore(store)
          log.info(`Credential store migrated to schema v${SKILL_ENV_SCHEMA_VERSION}`)
        } catch (err) {
          log.error('Failed to persist migrated credential store', err)
          // 内存里的 store 已迁移，后续读写仍正确，只是磁盘滞后
        }
      } else {
        // 即使没数据变化，也把 schemaVersion 标记为最新并落盘一次，避免下次启动重复扫描
        try {
          await persistStore(store)
        } catch (err) {
          log.error('Failed to persist schema version bump', err)
        }
      }
    }
    _cache = store
    return _cache
  })()
  try {
    return await _cachePromise
  } finally {
    _cachePromise = null
  }
}

async function persistStore(store: CredentialStoreFile): Promise<void> {
  const filePath = getStorePath()
  const tmp = filePath + '.tmp'
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const payload = JSON.stringify(store, null, 2)
  // 先写到临时文件再 rename，保证原子性；权限 0o600 限定只有所有者可读写。
  await fs.writeFile(tmp, payload, { encoding: 'utf-8', mode: 0o600 })
  await fs.rename(tmp, filePath)
}

function enqueueWrite<T>(fn: () => Promise<T>): Promise<T> {
  const next = _writeQueue.then(fn, fn)
  _writeQueue = next.then(
    () => undefined,
    () => undefined
  )
  return next
}

// ============ 旧 keytar 数据的懒兼容（只读 + 静默删除） ============

let _keytarModule: typeof import('keytar') | null | undefined = undefined

async function getKeytar(): Promise<typeof import('keytar') | null> {
  if (_keytarModule !== undefined) return _keytarModule
  try {
    const imported = await import('keytar')
    _keytarModule = (imported as unknown as { default?: typeof import('keytar') }).default ?? imported
  } catch (err) {
    log.warn('keytar unavailable, legacy credential migration disabled', err)
    _keytarModule = null
  }
  return _keytarModule
}

async function readLegacyKeytar(key: string): Promise<string | null> {
  const kt = await getKeytar()
  if (!kt) return null
  try {
    return await kt.getPassword(LEGACY_SERVICE_NAME, key)
  } catch (err) {
    log.warn(`Failed to read legacy keytar credential: ${key}`, err)
    return null
  }
}

async function deleteLegacyKeytarSilent(key: string): Promise<void> {
  const kt = await getKeytar()
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
export async function setCredential(key: string, secret: string): Promise<void> {
  await enqueueWrite(async () => {
    const store = await loadStore()
    const previous = Object.prototype.hasOwnProperty.call(store.items, key)
      ? store.items[key]
      : undefined
    store.items[key] = encryptValue(secret)
    try {
      await persistStore(store)
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
 * @returns 凭据值，不存在返回 null
 */
export async function getCredential(key: string): Promise<string | null> {
  const store = await loadStore()
  const stored = store.items[key]
  if (stored !== undefined) {
    try {
      return decryptValue(stored)
    } catch (err) {
      log.error(`Failed to decrypt credential: ${key}`, err)
      return null
    }
  }
  // fallback：兼容旧 keytar 数据，第一次读到后顺手迁移
  const legacy = await readLegacyKeytar(key)
  if (legacy !== null) {
    log.info(`Migrating legacy keytar credential to new store: ${key}`)
    try {
      await setCredential(key, legacy)
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
export async function deleteCredential(key: string): Promise<boolean> {
  const removed = await enqueueWrite(async () => {
    const store = await loadStore()
    if (!Object.prototype.hasOwnProperty.call(store.items, key)) {
      return false
    }
    const previous = store.items[key]
    delete store.items[key]
    try {
      await persistStore(store)
    } catch (err) {
      // 持久化失败时回滚内存缓存
      store.items[key] = previous
      throw err
    }
    return true
  })
  await deleteLegacyKeytarSilent(key)
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
export async function listCredentials(prefix?: string): Promise<string[]> {
  const store = await loadStore()
  let keys = Object.keys(store.items)
  if (prefix) {
    keys = keys.filter(k => k.startsWith(prefix))
  }
  return keys
}

// ============ 邮箱专用方法 ============

const EMAIL_PREFIX = 'email:'

export async function setEmailCredential(accountId: string, credential: string): Promise<void> {
  await setCredential(`${EMAIL_PREFIX}${accountId}`, credential)
}

export async function getEmailCredential(accountId: string): Promise<string | null> {
  return await getCredential(`${EMAIL_PREFIX}${accountId}`)
}

export async function deleteEmailCredential(accountId: string): Promise<boolean> {
  return await deleteCredential(`${EMAIL_PREFIX}${accountId}`)
}

// ============ 日历专用方法 ============

const CALENDAR_PREFIX = 'calendar:'

export async function setCalendarCredential(accountId: string, credential: string): Promise<void> {
  await setCredential(`${CALENDAR_PREFIX}${accountId}`, credential)
}

export async function getCalendarCredential(accountId: string): Promise<string | null> {
  return await getCredential(`${CALENDAR_PREFIX}${accountId}`)
}

export async function deleteCalendarCredential(accountId: string): Promise<boolean> {
  return await deleteCredential(`${CALENDAR_PREFIX}${accountId}`)
}

// ============ OAuth2 Token ============

export interface OAuth2Token {
  accessToken: string
  refreshToken?: string
  /** Unix 毫秒时间戳 */
  expiresAt?: number
  tokenType?: string
}

export async function setOAuth2Token(accountId: string, token: OAuth2Token): Promise<void> {
  await setEmailCredential(accountId, JSON.stringify(token))
}

/**
 * 读取 OAuth2 Token。
 * 即使已过期也照常返回，由调用者用 refreshToken 自行续期。
 */
export async function getOAuth2Token(accountId: string): Promise<OAuth2Token | null> {
  const credential = await getEmailCredential(accountId)
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

const SKILL_ENV_PREFIX = 'skill:'
/** skill env 凭据的 schema 版本：2 = envName 强制大写存储（v1→v2 时一次性迁移） */
const SKILL_ENV_SCHEMA_VERSION = 2

/**
 * 存储技能 env 凭据（API Key 等）。
 * key 格式：`skill:<skillId>:<ENV_NAME>`，envName 统一转大写后再落盘，
 * 避免前端 IPC / Agent 工具 / 老数据混用大小写导致同一变量名分裂成两条记录。
 */
export async function setSkillEnv(skillId: string, envName: string, value: string): Promise<void> {
  await setCredential(`${SKILL_ENV_PREFIX}${skillId}:${envName.toUpperCase()}`, value)
}

/**
 * 读取技能 env 凭据。不存在返回 null。
 */
export async function getSkillEnv(skillId: string, envName: string): Promise<string | null> {
  return await getCredential(`${SKILL_ENV_PREFIX}${skillId}:${envName.toUpperCase()}`)
}

/**
 * 删除技能 env 凭据。
 */
export async function deleteSkillEnv(skillId: string, envName: string): Promise<boolean> {
  return await deleteCredential(`${SKILL_ENV_PREFIX}${skillId}:${envName.toUpperCase()}`)
}

/**
 * 列出某个技能已存储的所有 env 名称（不含值，已是大写）。
 */
export async function listSkillEnvNames(skillId: string): Promise<string[]> {
  const prefix = `${SKILL_ENV_PREFIX}${skillId}:`
  const keys = await listCredentials(prefix)
  return keys.map(k => k.slice(prefix.length)).filter(Boolean)
}

/**
 * 读取某个技能的所有 env 键值对（用于子进程注入）。
 * 返回的 key 是存储时的大写名；调用方负责按 SKILL.md 声明的大小写映射后再注入。
 * 返回 `{ ENV_NAME: 'value', ... }`，只包含已配置的项。
 */
export async function getSkillEnvMap(skillId: string): Promise<Record<string, string>> {
  const names = await listSkillEnvNames(skillId)
  const result: Record<string, string> = {}
  await Promise.all(
    names.map(async (name) => {
      const val = await getSkillEnv(skillId, name)
      if (val !== null) result[name] = val
    })
  )
  return result
}

/**
 * 把 getSkillEnvMap 返回的「大写 key」映射回 SKILL.md 声明的原始大小写。
 * 用于注入子进程环境变量：credential 层统一大写存储，但技能脚本里读的是
 * 声明的变量名（可能是 api_key 而非 API_KEY），所以注入前要还原。
 * 未在 declaredEnvs 里声明的大写 key 原样保留（兼容老数据/未声明但已存的 key）。
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

/**
 * 一次性迁移：把所有 `skill:<id>:<envName>` 的 envName 归一化为大写。
 * 处理 v1（混合大小写）→ v2（统一大写）的升级场景。同一 (skillId, UPPER_ENV) 下若已有
 * 大写记录，小写记录直接丢弃（以大写为准，避免覆盖用户最新配置）。
 * 幂等：已是 v2 的 store 不会再扫描。
 */
function migrateSkillEnvToUpperCase(store: CredentialStoreFile): boolean {
  if (store.schemaVersion >= SKILL_ENV_SCHEMA_VERSION) return false
  const items = store.items
  // key 形如 `skill:<skillId>:<envName>`，按 (skillId, UPPER_ENV) 分桶收集需要迁移的小写条目
  const grouped = new Map<string, { skillId: string; upperEnv: string; originalKeys: string[] }>()
  for (const key of Object.keys(items)) {
    if (!key.startsWith(SKILL_ENV_PREFIX)) continue
    const rest = key.slice(SKILL_ENV_PREFIX.length)
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
    const upperKey = `${SKILL_ENV_PREFIX}${skillId}:${upperEnv}`
    const hasUpperAlready = items[upperKey] !== undefined
    if (originalKeys.length > 1) {
      log.warn(`Skill ${skillId} has ${originalKeys.length} lowercase variants for ${upperEnv} (${originalKeys.map(k => k.slice(SKILL_ENV_PREFIX.length + skillId.length + 1)).join(', ')}); keeping ${hasUpperAlready ? 'existing uppercase record' : 'first lowercase value'}, discarding the rest`)
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
export function __resetCredentialCacheForTests(): void {
  _cache = null
  _cachePromise = null
  _writeQueue = Promise.resolve()
  _keytarModule = undefined
}
