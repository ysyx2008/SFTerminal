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
    // Upstream sendMessage only checks HTTP status — body errors like
    // { errcode: -2, errmsg: "unknown" } silently return. We need to surface
    // them so SailFish channels can react (retry, notify user, etc.).
    //
    // Best-effort: if upstream still matches the "silent return" shape we
    // patch it; if upstream changed (added their own errcode handling, or
    // refactored sendMessage entirely), we leave it alone and log a notice
    // so a human can decide whether this transform is still needed. We
    // intentionally do NOT throw — the goal is the behavior, not this exact
    // patch, and a hard failure would block the weekly sync for a transform
    // that may already be obsolete upstream.
    name: "api/api.ts: sendMessage propagates non-zero errcode from response body",
    match: "api/api.ts",
    apply(content) {
      // Idempotency guard — already patched.
      if (content.includes("/ilink/bot/sendmessage: errcode=")) return content;

      const re =
        /(export async function sendMessage\([\s\S]*?\): Promise<void> \{\n)\s*await (apiPostFetch\(\{[\s\S]*?label: "sendMessage",\s*\}\);)\n\}/;
      if (!re.test(content)) {
        console.warn(
          "[vendor-wechat] notice: upstream sendMessage no longer matches the\n" +
          "  'silent return' shape we used to patch. Skipping the errcode-throw\n" +
          "  transform. Inspect api/api.ts and decide whether the patch is still\n" +
          "  needed (upstream may now surface errcode itself).",
        );
        return content;
      }
      return content.replace(re, (_m, header, call) =>
        header +
        "  const rawText = await " + call + "\n" +
        "  const trimmed = rawText.trim();\n" +
        "  if (!trimmed) return;\n" +
        "  try {\n" +
        "    const data = JSON.parse(trimmed) as {\n" +
        "      errcode?: number;\n" +
        "      ret?: number;\n" +
        "      errmsg?: string;\n" +
        "    };\n" +
        "    const code = data.errcode ?? data.ret;\n" +
        "    if (code != null && code !== 0) {\n" +
        "      throw new Error(\n" +
        "        `/ilink/bot/sendmessage: errcode=${code} errmsg=${data.errmsg || \"unknown\"}`,\n" +
        "      );\n" +
        "    }\n" +
        "  } catch (e) {\n" +
        "    if (e instanceof SyntaxError) return;\n" +
        "    throw e;\n" +
        "  }\n" +
        "}",
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
