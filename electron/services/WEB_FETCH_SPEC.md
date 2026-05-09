# Web Fetch Service SPEC

> Last verified: 2026-05-09

## 职责

网页内容提取。对给定 URL 发起 HTTP 请求，通过多后端策略提取可读文本内容（支持 Jina API、本地 Readability、纯文本 fallback），并内置 SSRF 防护（内网 IP 拦截）。

## 文件 / 规模

单文件：`electron/services/web-fetch.service.ts`（~763 行）

## 公开 API

模块函数体系，无 class。

| 函数签名 | 用途 | 主要调用方 |
|---------|------|-----------|
| `async webFetch(options: WebFetchOptions): Promise<WebFetchResult>` | 主入口：URL → 可读文本提取 | `agent/tools/web-fetch.ts` |
| `jinaAvailable(): boolean` | 检查 Jina API 是否已配置 | 调用方决策后端 |

## 核心类型 / 接口

### WebFetchOptions
```ts
interface WebFetchOptions {
  url: string
  timeoutSec?: number     // 超时秒数
  maxBytes?: number       // 响应体大小上限（默认 3MB，硬上限 10MB）
  backend?: "auto" | "jina" | "readability" | "raw"
}
```

### WebFetchResult
```ts
interface WebFetchResult {
  url: string, finalUrl: string
  status: number, contentType: string
  bytes: number, content: string
  title?: string, truncated: boolean
  backend: WebFetchBackend
}
```

### WebFetchBackend
```ts
type WebFetchBackend = "jina" | "readability" | "raw" | "fallback-text"
```

## 依赖（跨 service）

| 服务 | 关系 | 说明 |
|------|:----:|------|
| Web Search（`getApiKey`） | 可选 | 仅 `jina` 后端需要 API key |

## 关键行为 / 数据流

**后端选择（`backend: "auto"`）**：
1. Jina API 已配置 → `fetchViaJina`（远程抓取，最权威）
2. 否则本地抓取 → `fetchAndExtract` → `extractHtml` → `runReadability`
3. Readability 失败 → `simpleHtmlToText`（纯文本降级）
4. 全部失败 → `fallback-text`

**SSRF 防���**：`ensureNotInternal` 在请求前解析目标 IP，拦截所有内网地址（127.0.0.0/8、10.0.0.0/8、172.16.0.0/12、192.168.0.0/16）。

**大小限制**：`maxBytes` 默认 3MB，超出截断并标记 `truncated: true`，硬上限 10MB。注意：若服务器声明的 `Content-Length` 已超过 `maxBytes`，会直接抛 `Response too large` 错误而不是截断（避免下载浪费）。

## 关键约束

- **所有出站请求必须经过 `ensureNotInternal` SSRF 检查**，严禁直接 fetch
- **Readability 后端不得返回原始 HTML**——必须提取纯文本
- **Jina 后端为付费服务**，未配置 API key 时不得发起 Jina 请求
- **URL 格式必须包含协议**（`http://` 或 `https://`），否则拒绝
- **`maxBytes` 上限硬编码 10MB**，调用方不得突破（超过会被 clamp 到 10MB）
