# Credential Service SPEC

> 凭据存储服务：把所有敏感信息（邮箱密码、OAuth2 token、IM 凭证、堡垒机密码、skill env）
> 统一加密后写入 `{userData}/credentials.json`。
>
> Last verified: 2026-08-21 — 从仓库跑的命令行默认进沙箱并借用桌面密钥；装机后的正式命令默认与桌面共用。

## 文件结构

| 文件 | 行数 | 职责 |
|------|------|------|
| `credential.service.ts` | ~580 | `CredentialService` 类 + 模块级单例 + 函数式 re-export |
| `credential/master-key.ts` | ~210 | `MasterKey` 类：salt 文件管理 + PBKDF2 派生 + AES-256-GCM |

## 加密格式

每个 value 落盘格式为 `<scheme>:<base64>`：

| scheme | 含义 | 状态 |
|--------|------|------|
| `g1:` | MasterKey 自管密钥（PBKDF2 + AES-256-GCM） | **当前推荐**，新写入默认 |
| `e1:` | Electron `safeStorage` 加密（macOS Keychain / Windows DPAPI） | **仅历史兼容**，不再写入 |
| `p:`  | base64 明文 | 兜底降级（master.key 初始化失败时） |

### g1: 密钥派生

```
salt = 16B 随机盐，存 {userData}/master.key（权限 0o600，每 userData 独有）
key  = PBKDF2(SEED, salt, 200000 iters, 32B, sha256)
```

- **SEED**：硬编码在二进制里的 64 字节 ASCII 字符串（编译期常量，所有用户共享）。提供"反盗用单文件"门槛——
  盗走 `credentials.json` 单文件无法解密，必须同时拿到 `master.key` 或反编译二进制。
- **salt**：每个 userData 目录独有。保证"全用户统一 SEED"不会导致统一密钥。
- **派生缓存**：`MasterKey` 实例内 `_key` 缓存派生结果，每进程只派生一次。

### g1: 密文结构

```
g1: + base64(iv[12] || ciphertext || tag[16])
```

- IV：每次加密随机 12 字节（GCM 推荐）
- tag：GCM 认证标签，篡改时 `decrypt` 抛错
- 同明文两次加密结果不同

## 跨机器迁移

只需把 `{userData}/credentials.json` 和 `{userData}/master.key` 一起拷贝即可解密。
- `bootstrap.ts` 的目录迁移已自动覆盖整个 userData，无需额外处理
- knowledge 备份/恢复（`knowledge:createBackup` / `knowledge:restoreBackup`）只备份 knowledge 目录，
  不含 credentials.json / master.key；若将来要做"全应用数据导出"，需显式纳入这两个文件

## 安全模型权衡

| 维度 | safeStorage (e1:) | MasterKey (g1:) |
|------|------------------|-----------------|
| 跨机器迁移 | ❌ 绑定 OS 身份 | ✅ 拷文件即可 |
| 跨 build/跨产品 | ❌ Keychain ACL 冲突 | ✅ 共享 SEED |
| 反盗单文件 | ✅ 强（Keychain ACL） | ⚠️ 弱（需同时拿到 master.key） |
| 同机其它进程 | ✅ Keychain ACL 阻断 | ❌ 拿到两文件即可解密 |
| 用户感知 | 无 | 无 |

放弃 safeStorage 的"同机其它进程"保护，换取跨机器迁移和跨 build 稳定性——
后者在 v11.1.0 已两次出现"凭证验证失败"事故，前者在桌面应用场景下威胁较小。

## API

### CredentialService 类（OOP）

```typescript
class CredentialService {
  // 通用
  setCredential(key: string, secret: string): Promise<void>
  getCredential(key: string): Promise<string | null>
  deleteCredential(key: string): Promise<boolean>
  listCredentials(prefix?: string): Promise<string[]>

  // 邮箱
  setEmailCredential(accountId: string, credential: string): Promise<void>
  getEmailCredential(accountId: string): Promise<string | null>
  deleteEmailCredential(accountId: string): Promise<boolean>

  // 日历
  setCalendarCredential(accountId: string, credential: string): Promise<void>
  getCalendarCredential(accountId: string): Promise<string | null>
  deleteCalendarCredential(accountId: string): Promise<boolean>

  // OAuth2 Token（序列化到 email: 前缀下）
  setOAuth2Token(accountId: string, token: OAuth2Token): Promise<void>
  getOAuth2Token(accountId: string): Promise<OAuth2Token | null>

  // skill env（envName 统一大写存储）
  setSkillEnv(skillId: string, envName: string, value: string): Promise<void>
  getSkillEnv(skillId: string, envName: string): Promise<string | null>
  deleteSkillEnv(skillId: string, envName: string): Promise<boolean>
  listSkillEnvNames(skillId: string): Promise<string[]>
  getSkillEnvMap(skillId: string): Promise<Record<string, string>>

  // 备份/导出辅助
  getMasterKeyFilePath(): string
}
```

### 模块级单例与函数式 re-export

为兼容现有调用方，模块导出一组函数（`getCredential` / `setCredential` / ...），
转发到 `getDefaultCredentialService()` 单例。新代码推荐直接用类实例方法。

### 纯函数

```typescript
// 把 getSkillEnvMap 返回的大写 key 映射回 SKILL.md 声明的原始大小写
mapSkillEnvToDeclaredCase(envMap, declaredEnvs): Record<string, string>
```

## 旧数据兼容

| 来源 | 行为 |
|------|------|
| keytar Keychain item (`SFTerminal` service) | 读时懒迁移：新存储没有时回退读取，读到后写入新存储 |
| `e1:` (safeStorage) | 启动后仍能读；safeStorage 不可用或解密失败（Keychain ACL 失效）时返回 null 不抛错，`getCredential` 自动删除坏 e1: 条目自愈 |
| `p:` (base64 明文) | 直接读 |
| skill env v1 混合大小写 | `loadStore` 时一次性归一化为大写（schema v1→v2） |

### Migration v7：明文 → g1: + e1: → g1:

`electron/migrations/v7-im-bastion-and-e1-to-g1.ts`（phase=early）启动时一次性完成：

1. **明文 → g1:** config.json 里 8 个明文敏感字段（IM 6 平台 + Slack App Token + 堡垒机密码）
   非空且 credential 里没有对应 key 时，加密写入 credential；成功后清空 config 字段
2. **e1: → g1:** credential store 里所有 e1: 项，能用 safeStorage 解开的重新加密为 g1:；
   解不开的由 `getCredential` 自愈删除（safeStorage 不可用时不阻塞）--
   Keychain ACL 失效的 e1: 永久不可恢复，留着只会反复弹窗

字段映射（config key → credential key）：

| config.json 字段 | credential key |
|-----------------|---------------|
| `imDingTalkClientSecret` | `im:dingtalk:clientSecret` |
| `imFeishuAppSecret` | `im:feishu:appSecret` |
| `imWeComSecret` | `im:wecom:secret` |
| `imSlackBotToken` | `im:slack:botToken` |
| `imSlackAppToken` | `im:slack:appToken` |
| `imTelegramBotToken` | `im:telegram:botToken` |
| `imWeChatToken` | `im:wechat:token` |
| `bastionPassword` | `bastion:password` |

幂等：再次运行时 config 字段已空、credential 已是 g1:，扫描结果为空直接返回。

## 不变量

- `setCredential` 持久化失败时回滚内存缓存，保证与磁盘一致
- 写操作串行化（`enqueueWrite`），并发 set 不会互相覆盖
- `loadStore` 并发去重（`_cachePromise`），首次加载只触发一次磁盘 IO
- `MasterKey.getOrCreateKey` 并发去重（`_saltPromise`），首次派生只触发一次 salt 加载
- `master.key` 权限必须 0o600，对 group/other 可读时自动重建

## 已知限制

- `SEED` 写死在源码里，一旦泄露需全局重置（所有 g1: 凭证失效，用户需重新输入）
- `master.key` 丢失同样导致该 userData 下所有 g1: 凭证失效
- 同机其它进程只要拿到 `master.key` + `credentials.json` 即可解密（比 safeStorage 弱）
