/**
 * web-fetch.service.ts 单元测试
 *
 * 关键覆盖：
 * - URL 校验、规范化、大小限制
 * - SSRF 防护（loopback / RFC1918 / link-local / 元数据 IP）
 * - content-type 分发：HTML / JSON / text/plain / 二进制拒绝
 * - 字符编码：UTF-8 默认 + GBK 通过 iconv-lite 解码
 * - 重定向后 finalUrl 正确，且重定向目标也走 SSRF 校验
 * - Readability 提取 + fallback 文本提取
 * - Jina 路径：成功 + 失败降级到 readability
 *
 * 不覆盖：真实网络请求、AbortSignal.timeout 真实超时（vitest 假时钟成本高）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// 关键：在 import service 之前 mock，否则 `import { getApiKey } from './web-search'` 会跑真实模块
// （真实模块依赖 electron-store，测试环境会报错）
vi.mock('../web-search', () => ({
  isConfigured: () => false,
  getApiKey: vi.fn().mockReturnValue(''),
}))

// eslint-disable-next-line import/first
import { webFetch, _internal, jinaAvailable } from '../web-fetch.service'
// eslint-disable-next-line import/first
import { getApiKey } from '../web-search'

// ============================================================================
// fetch mock 工具
// ============================================================================

interface MockResponse {
  status: number
  contentType?: string
  body: string | Uint8Array
  contentLength?: number
  finalUrl?: string
}

function makeFetchMock(routes: Record<string, MockResponse>) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString()
    const route = routes[url]
    if (!route) {
      throw new Error(`Unmocked URL: ${url}`)
    }
    const bodyBytes = typeof route.body === 'string'
      ? new TextEncoder().encode(route.body)
      : route.body
    const headers = new Headers()
    if (route.contentType) headers.set('content-type', route.contentType)
    if (route.contentLength !== undefined) headers.set('content-length', String(route.contentLength))

    // 单 chunk ReadableStream（够测试用）
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bodyBytes)
        controller.close()
      },
    })

    return {
      ok: route.status >= 200 && route.status < 300,
      status: route.status,
      statusText: 'OK',
      url: route.finalUrl ?? url,
      headers,
      body: stream,
      text: async () => typeof route.body === 'string' ? route.body : new TextDecoder().decode(route.body),
    } as unknown as Response
  })
}

describe('web-fetch.service', () => {
  let originalFetch: typeof fetch

  beforeEach(() => {
    originalFetch = global.fetch
  })

  afterEach(() => {
    global.fetch = originalFetch
    vi.restoreAllMocks()
  })

  describe('URL 校验 + 规范化', () => {
    it('非 http(s) 协议应拒绝', async () => {
      await expect(webFetch({ url: 'file:///etc/passwd' })).rejects.toThrow(/Only http\/https/)
      await expect(webFetch({ url: 'ftp://example.com/file' })).rejects.toThrow(/Only http\/https/)
    })

    it('无效 URL 字符串应拒绝', async () => {
      await expect(webFetch({ url: 'not-a-url' })).rejects.toThrow(/Invalid URL/)
    })

    it('URL 应被规范化（new URL().toString()）', () => {
      // 含中文路径会被 URL 自动 percent-encode
      expect(_internal.normalizeUrl('https://example.com/中文'))
        .toBe('https://example.com/%E4%B8%AD%E6%96%87')
      // 末尾 / 自动补齐
      expect(_internal.normalizeUrl('https://example.com')).toBe('https://example.com/')
    })
  })

  describe('SSRF 防护', () => {
    it.each([
      ['http://localhost/admin', /local\/internal target/],
      ['http://foo.localhost/x', /local\/internal target/],
      ['http://service.internal/x', /local\/internal target/],
      ['http://127.0.0.1:6379/', /internal IP/],
      ['http://127.99.1.2/', /internal IP/],
      ['http://0.0.0.0/', /internal IP/],
      ['http://10.0.0.1/', /internal IP/],
      ['http://172.16.0.1/', /internal IP/],
      ['http://172.31.255.255/', /internal IP/],
      ['http://192.168.1.1/', /internal IP/],
      ['http://169.254.169.254/latest/meta-data/', /internal IP/],   // AWS metadata
      ['http://100.100.100.100/', /internal IP/],                     // Aliyun metadata (CGNAT)
      ['http://[::1]/', /internal IP/],
      ['http://[fe80::1]/', /internal IP/],
      ['http://[fd00::1]/', /internal IP/],
      ['http://[fc00::1]/', /internal IP/],
    ])('拒绝 %s', async (url, msgRe) => {
      await expect(webFetch({ url })).rejects.toThrow(msgRe)
    })

    it('允许公网地址', () => {
      expect(_internal.isInternalIp('8.8.8.8')).toBe(false)
      expect(_internal.isInternalIp('1.1.1.1')).toBe(false)
      expect(_internal.isInternalIp('172.32.0.1')).toBe(false)  // 172.16-31 之外
      expect(_internal.isInternalIp('192.169.1.1')).toBe(false) // 192.168 之外
    })

    it.each([
      // Node URL 把这些自动规范化为标准点分十进制，所以走 normalizeUrl → ensureNotInternal 链路必拦
      'http://2130706433/',          // 单整数 = 127.0.0.1
      'http://017700000001/',        // 8 进制 = 127.0.0.1
      'http://0x7f.0.0.1/',          // 16 进制 = 127.0.0.1
      'http://127.0.1/',             // 3 段 = 127.0.0.1
      'http://0/',                   // = 0.0.0.0
    ])('IPv4 多种表示绕过应被识别拦截: %s', async (url) => {
      // 验证 normalizeUrl 后能拿到规范化的形式（验证 Node URL 行为不变）
      const normalized = _internal.normalizeUrl(url)
      expect(normalized).toMatch(/^http:\/\/(127\.0\.0\.1|0\.0\.0\.0)\//)
      // 端到端：webFetch 入口必拦
      await expect(webFetch({ url })).rejects.toThrow(/internal IP|local\/internal target/)
    })

    it('IPv4-mapped IPv6（hex 形式）应识别为内部 IP', () => {
      // ::ffff:127.0.0.1 被 Node URL 规范化为 ::ffff:7f00:1
      expect(_internal.isInternalIp('::ffff:7f00:1')).toBe(true)   // 127.0.0.1
      expect(_internal.isInternalIp('::ffff:a9fe:a9fe')).toBe(true) // 169.254.169.254
      expect(_internal.isInternalIp('::ffff:0a00:1')).toBe(true)   // 10.0.0.1
      // 公网地址的 mapped 形式不应被拦
      expect(_internal.isInternalIp('::ffff:808:808')).toBe(false) // 8.8.8.8
    })

    it('IPv4-mapped IPv6（带点形式）也能识别', () => {
      expect(_internal.isInternalIp('::ffff:127.0.0.1')).toBe(true)
      expect(_internal.isInternalIp('::ffff:8.8.8.8')).toBe(false)
    })

    it('parseCharset 应正确提取', () => {
      expect(_internal.parseCharset('text/html; charset=utf-8')).toBe('utf-8')
      expect(_internal.parseCharset('text/html; charset="GBK"')).toBe('GBK')
      expect(_internal.parseCharset('text/html;charset=Shift_JIS;foo=bar')).toBe('Shift_JIS')
      expect(_internal.parseCharset('text/html')).toBe('')
    })
  })

  describe('JSON 响应', () => {
    it('返回美化后的 JSON', async () => {
      global.fetch = makeFetchMock({
        'https://api.example.com/data': {
          status: 200,
          contentType: 'application/json; charset=utf-8',
          body: '{"foo":1,"bar":[1,2,3]}',
        },
      }) as unknown as typeof fetch

      const result = await webFetch({ url: 'https://api.example.com/data' })
      expect(result.backend).toBe('raw')
      expect(result.content).toContain('"foo": 1')
      expect(result.content).toContain('"bar"')
    })

    it('非法 JSON 时降级为原文返回', async () => {
      global.fetch = makeFetchMock({
        'https://api.example.com/bad': {
          status: 200,
          contentType: 'application/json',
          body: '{invalid',
        },
      }) as unknown as typeof fetch

      const result = await webFetch({ url: 'https://api.example.com/bad' })
      expect(result.content).toContain('{invalid')
    })
  })

  describe('text/plain', () => {
    it('原样返回纯文本', async () => {
      global.fetch = makeFetchMock({
        'https://example.com/readme.txt': {
          status: 200,
          contentType: 'text/plain',
          body: 'Hello World\nLine 2',
        },
      }) as unknown as typeof fetch

      const result = await webFetch({ url: 'https://example.com/readme.txt' })
      expect(result.content).toBe('Hello World\nLine 2')
      expect(result.backend).toBe('raw')
    })
  })

  describe('文本型 application/* 不应走 Readability', () => {
    // application/xml / application/javascript / application/x-yaml 等通过
    // isBinaryContentType 白名单（不算二进制），但又不是 text/* 也不是 JSON。
    // 必须按 raw 返回，不能进 Readability，否则 XML 会被当 HTML 解析、YAML 里
    // 的 < > 字符会被当标签剥掉。
    it.each([
      ['application/xml', '<?xml version="1.0"?>\n<root>\n  <item id="1">value</item>\n</root>'],
      ['application/atom+xml', '<?xml version="1.0"?><feed><entry>x</entry></feed>'],
      ['application/javascript', 'function foo() { return a < b && b > 0; }'],
      ['application/x-yaml', 'key: value\nlist:\n  - a\n  - b: c < d'],
    ])('%s 应按 raw 返回，原文不被剥离', async (ct, body) => {
      global.fetch = makeFetchMock({
        'https://example.com/file': {
          status: 200,
          contentType: ct,
          body,
        },
      }) as unknown as typeof fetch

      const result = await webFetch({ url: 'https://example.com/file' })
      expect(result.backend).toBe('raw')
      // 原文必须完整保留，包括 <、> 等关键字符
      expect(result.content).toBe(body)
    })
  })

  describe('错误响应体限流（防 OOM DoS）', () => {
    it('500 + 超大响应体不应被全部读入内存', async () => {
      // 准备一个会"无限流出 1KB chunk"的 body——如果错误路径用 resp.text()
      // 会一直读直到 OOM 或挂起；用 readBodyPreview 应在 ~8KB 处主动 cancel。
      let chunksEmitted = 0
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (chunksEmitted >= 10000) {
            controller.close()
            return
          }
          chunksEmitted++
          controller.enqueue(new TextEncoder().encode('A'.repeat(1024)))
        },
        cancel() { /* 流被取消时这里被调用——证明限流生效 */ },
      })

      global.fetch = vi.fn(async () => ({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        url: 'https://buggy.example.com/x',
        headers: new Headers({ 'content-type': 'text/plain' }),
        body: stream,
        text: async () => { throw new Error('test must not call resp.text() — that has no size limit') },
      } as unknown as Response)) as unknown as typeof fetch

      await expect(webFetch({ url: 'https://buggy.example.com/x' }))
        .rejects.toThrow(/HTTP 500/)
      // 关键断言：发了远少于 10000 个 chunk（限流生效）。8KB / 1KB ≈ 8-10 chunks
      expect(chunksEmitted).toBeLessThan(20)
    })
  })

  describe('二进制内容拒绝', () => {
    it.each([
      ['image/png'],
      ['image/jpeg'],
      ['video/mp4'],
      ['audio/mpeg'],
      ['application/pdf'],
      ['application/zip'],
      ['application/octet-stream'],
    ])('拒绝 content-type %s', async (ct) => {
      global.fetch = makeFetchMock({
        'https://example.com/file': {
          status: 200,
          contentType: ct,
          body: new Uint8Array([1, 2, 3]),
        },
      }) as unknown as typeof fetch

      await expect(webFetch({ url: 'https://example.com/file' }))
        .rejects.toThrow(/Binary content/)
    })

    it('白名单 application/* 类型仍可读', async () => {
      global.fetch = makeFetchMock({
        'https://example.com/data.json': {
          status: 200,
          contentType: 'application/json',
          body: '{"k":1}',
        },
      }) as unknown as typeof fetch

      const result = await webFetch({ url: 'https://example.com/data.json' })
      expect(result.content).toContain('"k"')
    })
  })

  describe('HTTP 错误', () => {
    it('非 2xx 响应抛出含状态码的错误', async () => {
      global.fetch = makeFetchMock({
        'https://example.com/missing': {
          status: 404,
          contentType: 'text/html',
          body: 'not found',
        },
      }) as unknown as typeof fetch

      await expect(webFetch({ url: 'https://example.com/missing' }))
        .rejects.toThrow(/404/)
    })
  })

  describe('size 上限', () => {
    it('Content-Length 已知且超限直接拒绝', async () => {
      global.fetch = makeFetchMock({
        'https://example.com/huge': {
          status: 200,
          contentType: 'text/plain',
          body: 'small',
          contentLength: 999_999_999,
        },
      }) as unknown as typeof fetch

      await expect(webFetch({ url: 'https://example.com/huge', maxBytes: 1024 }))
        .rejects.toThrow(/too large/)
    })

    it('未知大小但实际超限：截断并标记', async () => {
      const big = 'x'.repeat(10000)
      global.fetch = makeFetchMock({
        'https://example.com/sneaky': {
          status: 200,
          contentType: 'text/plain',
          body: big,
        },
      }) as unknown as typeof fetch

      // maxBytes 最小被 clamp 到 1024
      const result = await webFetch({ url: 'https://example.com/sneaky', maxBytes: 2048 })
      // bytes 是流上看到的真实字节数（10000），不是被 clamp 后的值——便于用户看真实体积
      expect(result.bytes).toBe(10000)
      expect(result.truncated).toBe(true)
      // 实际读到内存的内容仍只有 maxBytes（2048）个 'x'
      expect(result.content.startsWith('xxxx')).toBe(true)
    })
  })

  describe('HTML 提取（Readability，本地路径）', () => {
    it('真正的博客结构应提取出正文', async () => {
      const html = `<!DOCTYPE html>
<html>
<head>
  <title>测试文章标题</title>
  <meta charset="utf-8">
</head>
<body>
  <nav>导航 - 首页 - 关于</nav>
  <header><h1>站点 logo</h1></header>
  <article>
    <h1>这是文章主标题</h1>
    <p>这是文章的第一段。${'字'.repeat(200)}</p>
    <p>这是文章的第二段。${'内容'.repeat(100)}</p>
    <p>这是文章的第三段。${'更多文字'.repeat(50)}</p>
  </article>
  <footer>版权 © 2026</footer>
</body>
</html>`
      global.fetch = makeFetchMock({
        'https://blog.example.com/post': {
          status: 200,
          contentType: 'text/html; charset=utf-8',
          body: html,
        },
      }) as unknown as typeof fetch

      const result = await webFetch({ url: 'https://blog.example.com/post' })
      expect(result.backend).toBe('readability')
      expect(result.title).toContain('测试文章')
      // 正文应包含
      expect(result.content).toContain('这是文章的第一段')
      // 应剥掉 nav / footer
      expect(result.content).not.toContain('版权 © 2026')
    })

    it('结构异常的 HTML（无主体）应 fallback 到文本提取', async () => {
      // 几乎无内容的 HTML，Readability 大概率返回 null 或太短
      const html = `<html><head><title>空页面</title></head><body><div></div></body></html>`
      global.fetch = makeFetchMock({
        'https://example.com/empty': {
          status: 200,
          contentType: 'text/html',
          body: html,
        },
      }) as unknown as typeof fetch

      const result = await webFetch({ url: 'https://example.com/empty' })
      // 不论走 readability 还是 fallback-text，都不应该抛错
      expect(['readability', 'fallback-text']).toContain(result.backend)
    })
  })

  describe('字符编码', () => {
    it('GBK 编码的 HTML 应正确解码', async () => {
      // 用 iconv-lite 把"你好世界"编码成 GBK bytes
      const iconv = await import('iconv-lite')
      const gbkBytes = iconv.encode('你好世界', 'gbk')
      // 拼一个最小可识别的 HTML
      const htmlPrefix = '<html><head></head><body><p>'
      const htmlSuffix = '</p></body></html>'
      const fullBytes = Buffer.concat([
        Buffer.from(htmlPrefix),
        gbkBytes,
        Buffer.from(htmlSuffix),
      ])

      global.fetch = makeFetchMock({
        'https://gbk.example.com/page': {
          status: 200,
          contentType: 'text/html; charset=gbk',
          body: new Uint8Array(fullBytes),
        },
      }) as unknown as typeof fetch

      const result = await webFetch({ url: 'https://gbk.example.com/page' })
      // 不论走 readability 还是 fallback-text，"你好世界"都应该被正确解码
      expect(result.content).toContain('你好世界')
    })

    it('未声明 charset 默认按 UTF-8 处理', async () => {
      global.fetch = makeFetchMock({
        'https://utf8.example.com/x': {
          status: 200,
          contentType: 'text/plain',
          body: '日本語テスト',
        },
      }) as unknown as typeof fetch

      const result = await webFetch({ url: 'https://utf8.example.com/x' })
      expect(result.content).toContain('日本語テスト')
    })
  })

  describe('重定向', () => {
    it('重定向链中的内网跳转应被拦截（每跳校验，不只在最终 URL）', async () => {
      // 模拟攻击：第 1 跳是 attacker 公网 → 302 → 169.254.169.254 (云元数据)
      // 关键：第 2 跳的请求**根本不能发出**——SSRF 必须在 fetch 之前拦截
      let attackerHit = false
      let metadataHit = false
      const fetchMock = vi.fn(async (input: string | URL | Request) => {
        const url = typeof input === 'string' ? input : input.toString()
        if (url === 'https://attacker.example.com/start') {
          attackerHit = true
          return {
            ok: false,
            status: 302,
            statusText: 'Found',
            url,
            headers: new Headers({ 'location': 'http://169.254.169.254/latest/meta-data/' }),
            body: null,
            text: async () => '',
          } as unknown as Response
        }
        if (url.startsWith('http://169.254.169.254/')) {
          metadataHit = true  // 不该到这一步！
        }
        throw new Error(`Unexpected URL: ${url}`)
      })
      global.fetch = fetchMock as unknown as typeof fetch

      await expect(webFetch({ url: 'https://attacker.example.com/start' }))
        .rejects.toThrow(/internal IP/)
      expect(attackerHit).toBe(true)
      // 关键断言：元数据 IP **从来没被请求**（不是请求后被拒，是根本没发请求）
      expect(metadataHit).toBe(false)
    })

    it('正常重定向（公网 → 公网）应能跟随', async () => {
      const fetchMock = vi.fn(async (input: string | URL | Request) => {
        const url = typeof input === 'string' ? input : input.toString()
        if (url === 'https://short.example.com/abc') {
          return {
            ok: false,
            status: 301,
            statusText: 'Moved',
            url,
            headers: new Headers({ 'location': 'https://long.example.com/article/123' }),
            body: null,
            text: async () => '',
          } as unknown as Response
        }
        if (url === 'https://long.example.com/article/123') {
          return {
            ok: true,
            status: 200,
            statusText: 'OK',
            url,
            headers: new Headers({ 'content-type': 'text/plain' }),
            body: new ReadableStream<Uint8Array>({
              start(c) { c.enqueue(new TextEncoder().encode('final content')); c.close() },
            }),
            text: async () => '',
          } as unknown as Response
        }
        throw new Error(`Unexpected URL: ${url}`)
      })
      global.fetch = fetchMock as unknown as typeof fetch

      const result = await webFetch({ url: 'https://short.example.com/abc' })
      expect(result.content).toBe('final content')
      expect(result.finalUrl).toBe('https://long.example.com/article/123')
      expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    it('重定向链过长（>10）应抛错', async () => {
      let count = 0
      global.fetch = vi.fn(async (input: string | URL | Request) => {
        count++
        const url = typeof input === 'string' ? input : input.toString()
        return {
          ok: false,
          status: 302,
          statusText: 'Found',
          url,
          headers: new Headers({ 'location': `https://example.com/loop${count}` }),
          body: null,
          text: async () => '',
        } as unknown as Response
      }) as unknown as typeof fetch

      await expect(webFetch({ url: 'https://example.com/loop0' }))
        .rejects.toThrow(/Too many redirects/)
    })

    it('Location 是非 http(s) 协议应被拒', async () => {
      global.fetch = vi.fn(async () => ({
        ok: false,
        status: 302,
        statusText: 'Found',
        url: 'https://example.com/x',
        headers: new Headers({ 'location': 'javascript:alert(1)' }),
        body: null,
        text: async () => '',
      } as unknown as Response)) as unknown as typeof fetch

      await expect(webFetch({ url: 'https://example.com/x' }))
        .rejects.toThrow(/non-http\(s\) protocol/)
    })
  })

  describe('Jina Reader 路径', () => {
    afterEach(() => {
      vi.mocked(getApiKey).mockReturnValue('')
    })

    it('配了 key 时优先走 Jina', async () => {
      vi.mocked(getApiKey).mockReturnValue('test-jina-key')
      expect(jinaAvailable()).toBe(true)

      const fetchMock = vi.fn(async (input: string | URL | Request) => {
        const url = typeof input === 'string' ? input : input.toString()
        // 关键断言：Jina 路径
        expect(url.startsWith('https://r.jina.ai/')).toBe(true)
        expect(url.endsWith('https://target.example.com/article')).toBe(true)
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          url,
          headers: new Headers({ 'content-type': 'text/markdown' }),
          body: new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(new TextEncoder().encode('Title: My Article\n\n# Hello\n\nbody'))
              c.close()
            },
          }),
          text: async () => '',
        } as unknown as Response
      })
      global.fetch = fetchMock as unknown as typeof fetch

      const result = await webFetch({ url: 'https://target.example.com/article' })
      expect(result.backend).toBe('jina')
      expect(result.title).toBe('My Article')
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('Jina 失败时降级到 readability', async () => {
      vi.mocked(getApiKey).mockReturnValue('test-jina-key')

      let call = 0
      const fetchMock = vi.fn(async (input: string | URL | Request) => {
        call++
        const url = typeof input === 'string' ? input : input.toString()
        if (call === 1) {
          // 第一次：Jina 返回 500
          expect(url.startsWith('https://r.jina.ai/')).toBe(true)
          return {
            ok: false,
            status: 500,
            statusText: 'Internal Server Error',
            url,
            headers: new Headers(),
            body: null,
            text: async () => 'jina overloaded',
          } as unknown as Response
        }
        // 第二次：直接 fetch 原 URL
        expect(url).toBe('https://target.example.com/article')
        const html = `<html><head><title>Plan B</title></head><body>
          <article><h1>Plan B</h1><p>${'fallback text content. '.repeat(20)}</p></article>
        </body></html>`
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          url,
          headers: new Headers({ 'content-type': 'text/html' }),
          body: new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(new TextEncoder().encode(html))
              c.close()
            },
          }),
          text: async () => '',
        } as unknown as Response
      })
      global.fetch = fetchMock as unknown as typeof fetch

      const result = await webFetch({ url: 'https://target.example.com/article' })
      expect(result.backend).toBe('readability')
      expect(result.content).toContain('fallback text')
      expect(fetchMock).toHaveBeenCalledTimes(2)
    })
  })

  describe('内部工具函数', () => {
    describe('isBinaryContentType', () => {
      it.each([
        ['text/html', false],
        ['text/plain', false],
        ['text/markdown', false],
        ['application/json', false],
        ['application/xml', false],
        ['application/javascript', false],
        ['application/x-yaml', false],
        ['image/png', true],
        ['video/mp4', true],
        ['audio/mpeg', true],
        ['application/pdf', true],
        ['application/octet-stream', true],
        ['application/zip', true],
        ['', false],
      ])('isBinaryContentType("%s") = %s', (ct, expected) => {
        expect(_internal.isBinaryContentType(ct)).toBe(expected)
      })
    })

    describe('decodeEntities', () => {
      it('解码常见 HTML 实体', () => {
        // nbsp 解码为普通空格；&#39; 后原本已有空格分隔符，结果末尾是双空格
        expect(_internal.decodeEntities('&amp; &lt; &gt; &quot; &#39; &nbsp;'))
          .toBe('& < > " \'  ')
      })

      it('解码数字字符引用', () => {
        expect(_internal.decodeEntities('&#65;&#66;')).toBe('AB')
        expect(_internal.decodeEntities('&#x4e2d;&#x6587;')).toBe('中文')
      })
    })

    describe('simpleHtmlToText', () => {
      it('提取 title + 剥掉 script/style', () => {
        const html = `
          <html>
            <head><title>Page Title</title>
              <style>body{color:red}</style>
            </head>
            <body>
              <script>alert('x')</script>
              <p>Hello world</p>
              <p>Second paragraph</p>
            </body>
          </html>`
        const result = _internal.simpleHtmlToText(html)
        expect(result.title).toBe('Page Title')
        expect(result.text).toContain('Hello world')
        expect(result.text).toContain('Second paragraph')
        expect(result.text).not.toContain('alert')
        expect(result.text).not.toContain('color:red')
      })

      it('块级标签转换为换行', () => {
        const html = '<p>line1</p><p>line2</p><p>line3</p>'
        const result = _internal.simpleHtmlToText(html)
        // 每个 p 之间应该至少有一个换行
        const lines = result.text.split('\n').filter(Boolean)
        expect(lines.length).toBeGreaterThanOrEqual(3)
      })
    })
  })
})
