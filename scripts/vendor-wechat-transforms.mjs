// Patch-as-Code: declarative rules applied to vendored WeChat sources.
// Never edit files under VENDOR_DIR by hand — add a transform here instead.

export const UPSTREAM_PACKAGE = "@tencent-weixin/openclaw-weixin";
export const VENDOR_DIR = "electron/services/im/wechat";

// Whitelist of files copied from <package>/src into VENDOR_DIR (same relative path).
// Files NOT in this list are intentionally not vendored — either irrelevant
// (host/runtime/channel/process-message) or replaced by local shims (logger, accounts).
export const FILE_LIST = [
  "api/api.ts",
  "api/types.ts",
  "api/session-guard.ts",
  "api/config-cache.ts",
  "cdn/aes-ecb.ts",
  "cdn/cdn-upload.ts",
  "cdn/cdn-url.ts",
  "cdn/pic-decrypt.ts",
  "cdn/upload.ts",
  "media/media-download.ts",
  "media/mime.ts",
  "media/silk-transcode.ts",
  "messaging/send.ts",
  "messaging/send-media.ts",
  "messaging/inbound.ts",
  "messaging/markdown-filter.ts",
  "messaging/reply-progress-sender.ts",
  "messaging/error-notice.ts",
  "auth/login-qr.ts",
  "storage/state-dir.ts",
  "util/random.ts",
  "util/redact.ts",
];

// Files that exist locally as shims and must NOT be overwritten by the copy step.
// The vendored files import them via relative paths (e.g. "../util/logger.js")
// which resolves to the shim placed at the same path.
export const SHIM_FILES = [
  "util/logger.ts",
  "auth/accounts.ts",
  "weixin-meta.ts",
];

/**
 * Transform rules. Each entry:
 *   - match: relative path under VENDOR_DIR (string === / RegExp test)
 *   - apply: (content: string, filePath: string) => string
 *
 * Rules run in order. Keep each rule small and idempotent.
 */
export const TRANSFORMS = [
  {
    name: "messaging/send.ts: inline ReplyPayload (drop openclaw host SDK import)",
    match: "messaging/send.ts",
    apply(content) {
      return content.replace(
        /import type \{ ReplyPayload \} from "openclaw\/plugin-sdk\/reply-runtime";?\n/,
        'type ReplyPayload = { text?: string };\n',
      );
    },
  },
  {
    // SailFish wechat-adapter 直接复用 vendored 的 bodyFromItemList（处理引用消息、
    // 语音转文字等业务逻辑），保持 adapter 当薄壳。上游目前没 export 该函数，
    // 这里改成 export 以便外部 import；同步时若上游已自行导出，正则不会匹配，
    // transform 自动失效。
    name: "messaging/inbound.ts: export bodyFromItemList for adapter reuse",
    match: "messaging/inbound.ts",
    apply(content) {
      if (/export function bodyFromItemList\(/.test(content)) return content;
      return content.replace(
        /^function bodyFromItemList\(/m,
        "export function bodyFromItemList(",
      );
    },
  },
  {
    // Vendored 源码不在 npm 包目录内，readPackageJsonFromDir 找不到 ilink_appid，
    // 导致 iLink-App-Id 为空 / ClientVersion=0。文本消息可能侥幸成功，但 CDN
    // 上传会因签名/鉴权不匹配返回 500。
    name: "api/api.ts: fallback ilink metadata for vendored layout",
    match: "api/api.ts",
    apply(content) {
      if (content.includes("weixin-meta.js")) return content;
      let out = content.replace(
        'import { loadConfigBotAgent, loadConfigRouteTag } from "../auth/accounts.js";',
        'import { loadConfigBotAgent, loadConfigRouteTag } from "../auth/accounts.js";\nimport { WEIXIN_PACKAGE_META } from "../weixin-meta.js";',
      );
      out = out.replace(
        "function readPackageJson(): PackageJson {\n  return readPackageJsonFromDir(path.dirname(fileURLToPath(import.meta.url)));\n}",
        `function readPackageJson(): PackageJson {
  const found = readPackageJsonFromDir(path.dirname(fileURLToPath(import.meta.url)));
  if (found.ilink_appid !== undefined) return found;
  return { ...WEIXIN_PACKAGE_META };
}`,
      );
      return out;
    },
  },
  {
    // Weixin CDN 拒绝 chunked/duplex 流式 body（会立即 500）。用整包 Buffer +
    // AbortSignal.timeout 防止大文件无响应时永久卡死。
    name: "cdn/cdn-upload.ts: buffer upload with wall-clock timeout",
    match: "cdn/cdn-upload.ts",
    apply(content) {
      if (content.includes("uploadAttemptTimeoutMs")) return content;
      let out = content.replace(
        /(\/\*\* Maximum retry attempts for CDN upload\. \*\/\nconst UPLOAD_MAX_RETRIES = 3;\n)/,
        `$1
/** Minimum wall-clock timeout per upload attempt. */
const UPLOAD_TIMEOUT_MIN_MS = 60_000;
/** Extra timeout budget per 64 KB of ciphertext (upload + server processing). */
const UPLOAD_TIMEOUT_PER_64K_MS = 5_000;
/** Response wait slack after the full body is sent. */
const UPLOAD_TIMEOUT_RESPONSE_MS = 30_000;

function uploadAttemptTimeoutMs(ciphertextSize: number): number {
  const chunks = Math.max(1, Math.ceil(ciphertextSize / (64 * 1024)));
  return Math.max(
    UPLOAD_TIMEOUT_MIN_MS,
    chunks * UPLOAD_TIMEOUT_PER_64K_MS + UPLOAD_TIMEOUT_RESPONSE_MS,
  );
}
`,
      );
      out = out.replace(
        /      const res = await fetch\(cdnUrl, \{\n        method: "POST",\n        headers: \{ "Content-Type": "application\/octet-stream" \},\n        body: new Uint8Array\(ciphertext\),\n      \}\);/,
        `      const timeoutMs = uploadAttemptTimeoutMs(ciphertext.length);
      const res = await fetch(cdnUrl, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: ciphertext,
        signal: AbortSignal.timeout(timeoutMs),
      });`,
      );
      // Upgrade error logging if upstream still has simple status-only message.
      out = out.replace(
        `const errMsg = res.headers.get("x-error-message") ?? \`status \${res.status}\`;`,
        `const bodySnippet = (await res.text()).slice(0, 200);
        const errMsg =
          res.headers.get("x-error-message") ??
          (bodySnippet ? \`status \${res.status} body=\${bodySnippet}\` : \`status \${res.status}\`);`,
      );
      return out;
    },
  },
  {
    // 每条 inbound 消息都携带一个新的 context_token。当 context_token 变化时，
    // SailFish adapter 需要立即让 configManager 对该 user 的缓存失效，强制重新
    // 调用 getconfig，否则服务端 per-user session 过期后 sendmessage 会持续报
    // errcode=-2，直到 24h 随机 TTL 自然到期才恢复。
    // 
    // 若上游已自行暴露该方法，正则不会匹配，transform 自动失效。
    name: "api/config-cache.ts: expose invalidateUser to force session re-registration",
    match: "api/config-cache.ts",
    apply(content) {
      if (content.includes("invalidateUser(")) return content;
      return content.replace(
        /  async getForUser\(/,
        "  /** Force the next getForUser call for this user to bypass the TTL cache and re-fetch.\n   * Call whenever a fresh context_token arrives to re-register the server-side session.\n   */\n  invalidateUser(userId: string): void {\n    this.cache.delete(userId);\n  }\n\n  async getForUser(",
      );
    },
  },
];

export function applyTransforms(relPath, content) {
  let out = content;
  for (const t of TRANSFORMS) {
    const hit = typeof t.match === "string" ? t.match === relPath : t.match.test(relPath);
    if (hit) out = t.apply(out, relPath);
  }
  return out;
}
