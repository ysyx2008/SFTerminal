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
];

export function applyTransforms(relPath, content) {
  let out = content;
  for (const t of TRANSFORMS) {
    const hit = typeof t.match === "string" ? t.match === relPath : t.match.test(relPath);
    if (hit) out = t.apply(out, relPath);
  }
  return out;
}
