import { describe, expect, it } from 'vitest'
import { extractPageContentFromHtml } from '../page-content-extract'

const NEWS_LIKE_HTML = `<!DOCTYPE html><html><head><title>让发展惠及人民_腾讯新闻</title></head><body>
<nav>首页 新闻 视频 登录</nav>
<div class="sidebar">
  <div class="video-player">精选视频 00:26 暂停 下一个</div>
</div>
<article>
  <h1>让发展惠及人民，把人权愿景落到实处</h1>
  <p>6月11日至12日，“2026·全球人权治理高端论坛”在北京举办。</p>
  <p>冈比亚副总统穆罕默德·贾洛表示，《发展权利宣言》具有重大里程碑意义。</p>
</article>
<footer>Copyright 腾讯网</footer>
</body></html>`

describe('extractPageContentFromHtml', () => {
  it('prefers Readability over sidebar video on news-like layout', async () => {
    const result = await extractPageContentFromHtml(
      NEWS_LIKE_HTML,
      'https://news.qq.com/rain/a/20260613A02DBC00',
    )
    expect(result.text).toContain('全球人权治理高端论坛')
    expect(result.text).toContain('穆罕默德·贾洛')
    expect(result.text).not.toContain('精选视频')
  })

  it('uses plain fallback when Readability and heuristic both fail', async () => {
    const fallback = '兜底正文。'.repeat(12)
    const result = await extractPageContentFromHtml(
      '<html><body><div>x</div></body></html>',
      'https://example.com/',
      fallback,
    )
    expect(result.text).toContain('兜底正文')
  })
})
