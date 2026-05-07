// Local shim. Replaces upstream src/auth/accounts.ts which depends on the
// openclaw plugin host's multi-account config store. SailFish manages WeChat
// auth itself (single account per adapter instance), so these stubs return
// empty/undefined and let the calling code fall through to defaults.

export type WeixinAccountData = {
  baseUrl?: string;
  cdnBaseUrl?: string;
  token?: string;
  cookie?: string;
  uin?: string;
};

export const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
export const CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";

export function loadConfigBotAgent(): string | undefined {
  return undefined;
}

export function loadConfigRouteTag(_accountId?: string): string | undefined {
  return undefined;
}

export function listIndexedWeixinAccountIds(): string[] {
  return [];
}

export function loadWeixinAccount(_accountId: string): WeixinAccountData | null {
  return null;
}
