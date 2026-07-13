/**
 * Auth / SSO 模块契约
 *
 * ## 职责
 * - 提供应用级 OAuth2/OIDC **协议底座**（授权码 + PKCE、token 交换、ID Token 解析）
 * - 受 `oem.config.features.sso` 门控；默认关闭，不挡开源产品使用
 *
 * ## 非职责
 * - 企业组织树 / RBAC / 计费控制面
 * - 邮箱、飞书等「服务授权」OAuth（见 skills/email/oauth、IM 适配器）
 *
 * ## 公开 API
 * - `getAuthService()` → `AuthService`
 * - `beginLogin` / `completeLogin` / `getSession` / `logout`
 * - 纯函数：`electron/services/auth/oidc-protocol.ts`
 *
 * ## 配置
 * - `features.sso` + 可选 `oem.config.sso`（issuer / clientId / redirectUri / scopes）
 *
 * ## IPC（由 main 注册）
 * - `auth:getSession` / `auth:startLogin` / `auth:completeLogin` / `auth:logout`
 * - SSO 关闭时返回明确错误或空会话
 */
