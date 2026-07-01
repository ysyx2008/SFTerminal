/**
 * Migration v7: 把 IM/堡垒机明文凭证迁入 credential.service，并把旧 e1: 凭证转 g1:
 *
 * 背景：
 * - IM（钉钉/飞书/企业微信/Slack/Telegram/微信）和堡垒机的 secret/password
 *   历史上明文存在 config.json，任何有文件访问权限的程序都能直接读出 token。
 * - credential.service 旧的 e1:（safeStorage）格式在跨 build/跨产品场景下
 *   Keychain ACL 反复失效，已切换为 g1:（自管主密钥）。本迁移把存量 e1: 凭证
 *   也一并转 g1:，让所有凭证统一格式。
 *
 * 本迁移做两件事：
 * 1. **明文 → g1:** 扫描 config 里 8 个明文敏感字段，非空且 credential 里
 *    没有对应 key 时，用 credential.service 加密写入；成功后清空 config 字段
 *    （置为空字符串，保留 schema 字段以避免 TS 类型报错；最终字段移除在 v8）。
 * 2. **e1: → g1:** 扫描 credential store 里所有 e1: 项，能用 safeStorage
 *    解开的就重新加密为 g1:；解不开的跳过（不阻塞，记 warn）。
 *
 * 幂等：再次运行时 config 字段已空、credential 里已是 g1:，扫描结果为空直接返回。
 */

import type { ConfigService } from '../services/config.service'
import type { CredentialService } from '../services/credential.service'
import { createLogger } from '../utils/logger'
import type { Migration } from './types'

const log = createLogger('Migration:v7')

/**
 * config.json 明文字段 → credential.service key 的映射。
 * key 命名规则：`<domain>:<platform>:<field>`，便于按平台/前缀过滤。
 */
const IM_BASTION_FIELDS: Array<{ configKey: string; credentialKey: string }> = [
  { configKey: 'imDingTalkClientSecret', credentialKey: 'im:dingtalk:clientSecret' },
  { configKey: 'imFeishuAppSecret',      credentialKey: 'im:feishu:appSecret' },
  { configKey: 'imWeComSecret',          credentialKey: 'im:wecom:secret' },
  { configKey: 'imSlackBotToken',        credentialKey: 'im:slack:botToken' },
  { configKey: 'imSlackAppToken',        credentialKey: 'im:slack:appToken' },
  { configKey: 'imTelegramBotToken',    credentialKey: 'im:telegram:botToken' },
  { configKey: 'imWeChatToken',          credentialKey: 'im:wechat:token' },
  { configKey: 'bastionPassword',        credentialKey: 'bastion:password' },
]

export async function migrateImAndBastionSecrets(
  configService: ConfigService,
  credentialService: CredentialService
): Promise<{ plaintextMigrated: number; e1Upgraded: number; errors: string[] }> {
  const errors: string[] = []
  let plaintextMigrated = 0
  let e1Upgraded = 0

  // ---- 阶段 1：明文 → g1: ----
  for (const { configKey, credentialKey } of IM_BASTION_FIELDS) {
    const plain = (configService.get(configKey as any) as string | undefined) ?? ''
    if (!plain) continue

    // credential 里若已有同 key 且能解密成功，则不重复迁移（避免覆盖用户最新值）
    const existing = await credentialService.getCredential(credentialKey)
    if (existing !== null) {
      log.info(`credential ${credentialKey} 已存在，跳过明文迁移（清空 config 字段）`)
    } else {
      try {
        await credentialService.setCredential(credentialKey, plain)
        plaintextMigrated++
        log.info(`明文凭证已迁移：${configKey} → ${credentialKey}`)
      } catch (err) {
        errors.push(`迁移 ${configKey} 失败: ${err instanceof Error ? err.message : String(err)}`)
        // 写 credential 失败时不清空 config，保留原值下次重试
        continue
      }
    }

    // 清空 config 里的明文字段（置为空字符串，保留 schema 字段）
    try {
      configService.set(configKey as any, '')
    } catch (err) {
      log.warn(`清空 config 字段 ${configKey} 失败`, err)
    }
  }

  // ---- 阶段 2：e1: → g1: ----
  // 列出所有 credential key，过滤出 e1: 的，逐条解密重写为 g1:
  try {
    const allKeys = await credentialService.listCredentials()
    for (const key of allKeys) {
      // 读取原始密文（绕过 decryptValue，直接拿 store 里的字符串判断 scheme）
      const raw = await readRawStoredValue(credentialService, key)
      if (!raw || !raw.startsWith('e1:')) continue

      // 用旧 safeStorage 通道解密（getCredential 内部会走 e1: 分支）
      const plain = await credentialService.getCredential(key)
      if (plain === null) {
        // safeStorage 不可用 / 解密失败：跳过，保留 e1: 原值
        log.warn(`e1: 凭证 ${key} 无法解密（safeStorage 不可用或密钥变化），保留原值`)
        continue
      }
      // setCredential 会用新 g1: 格式重新加密
      try {
        await credentialService.setCredential(key, plain)
        e1Upgraded++
        log.info(`e1: 凭证已升级为 g1: ${key}`)
      } catch (err) {
        errors.push(`升级 e1: ${key} 失败: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  } catch (err) {
    errors.push(`扫描 e1: 凭证失败: ${err instanceof Error ? err.message : String(err)}`)
  }

  return { plaintextMigrated, e1Upgraded, errors }
}

/**
 * 从 credential store 直接读取原始密文字符串（含 scheme 前缀）。
 * 仅 migration 使用，调用方正常运行时应当用 `getCredential` 拿明文。
 * 在 CredentialService 上通过约定的内部方法 `__getRawValueForMigration` 暴露，
 * 避免污染 public API。
 */
async function readRawStoredValue(
  credentialService: CredentialService,
  key: string
): Promise<string | undefined> {
  return await credentialService.__getRawValueForMigration(key)
}

export const migrationV7: Migration = {
  version: 7,
  name: 'im-bastion-plaintext-and-e1-to-g1',
  phase: 'early',

  async migrate({ configService }) {
    // 延迟导入避免循环依赖；CredentialService 模块级单例在 early phase 可用
    const { getDefaultCredentialService } = await import('../services/credential.service')
    const credentialService = getDefaultCredentialService()

    log.info('开始迁移：IM/堡垒机明文凭证 → credential.service；旧 e1: → g1:')
    const result = await migrateImAndBastionSecrets(configService, credentialService)
    log.info(
      `迁移完成：明文迁移 ${result.plaintextMigrated} 条，e1: 升级 ${result.e1Upgraded} 条` +
      (result.errors.length ? `，${result.errors.length} 个错误` : '')
    )
    if (result.errors.length > 0) {
      log.warn('迁移部分失败:', result.errors.slice(0, 20).join('; '))
    }
  },
}
