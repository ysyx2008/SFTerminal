import { describe, expect, it } from 'vitest'
import {
  extractArticleHtmlFromHtml,
  extractArticleTextFromHtml,
} from '../html-article-extract'

const SAMPLE_ARTICLE_HTML = `<!DOCTYPE html><html><body>
<nav>首页 关于 登录</nav>
<header><h1>站点标题</h1></header>
<article>
  <h1>如何测试浏览器正文提取</h1>
  <p>这是文章的第一段正文，包含足够长的内容以便通过启发式评分。Agent 应该能读到这段而不是导航栏里的链接文字。</p>
  <p>第二段继续说明 attach 模式下 browser_get_content 会优先提取 article 区域。</p>
</article>
<aside>相关推荐：广告 A 广告 B</aside>
<footer>Copyright 2026 Example</footer>
</body></html>`

const SAMPLE_MAIN_HTML = `<!DOCTYPE html><html><body>
<div class="sidebar">菜单项一 菜单项二</div>
<main>
  <h2>文档正文标题</h2>
  <p>main 标签内的正文内容，同样应该被提取出来供 LLM 阅读，而不是侧边栏里的短文本。</p>
</main>
</body></html>`

describe('html-article-extract', () => {
  it('extracts article body and drops nav/footer noise', () => {
    const text = extractArticleTextFromHtml(SAMPLE_ARTICLE_HTML, 'https://example.com/', 'article')
    expect(text).toContain('如何测试浏览器正文提取')
    expect(text).toContain('attach 模式下 browser_get_content')
    expect(text.length).toBeGreaterThan(80)
    expect(text).not.toMatch(/Copyright 2026/)
  })

  it('prefers main over sidebar when no article tag', () => {
    const text = extractArticleTextFromHtml(SAMPLE_MAIN_HTML, 'https://example.com/', 'article')
    expect(text).toContain('文档正文标题')
    expect(text).toContain('main 标签内的正文')
  })

  it('full mode returns entire body text', () => {
    const text = extractArticleTextFromHtml(SAMPLE_ARTICLE_HTML, 'https://example.com/', 'full')
    expect(text).toContain('首页 关于 登录')
    expect(text).toContain('Copyright 2026')
  })

  it('extractHtml strips script/nav from article region', () => {
    const html = `<!DOCTYPE html><html><body><article>
      <script>alert(1)</script>
      <nav>skip</nav>
      <p>可见段落内容足够长以便通过评分阈值与测试断言。</p>
    </article></body></html>`
    const fragment = extractArticleHtmlFromHtml(html, 'https://example.com/', 'article')
    expect(fragment).toContain('可见段落')
    expect(fragment).not.toContain('<script')
    expect(fragment).not.toContain('<nav')
  })

  it('falls back to JSON-LD when DOM article region is too short', () => {
    const html = `<!DOCTYPE html><html><body>
<article><video></video><p>短</p></article>
<script type="application/ld+json">${JSON.stringify({
      '@type': 'NewsArticle',
      articleBody: '这是 JSON-LD 里的完整正文。' + '内容足够长。'.repeat(20),
    })}</script>
</body></html>`
    const text = extractArticleTextFromHtml(html, 'https://example.com/', 'article')
    expect(text).toContain('JSON-LD 里的完整正文')
    expect(text.length).toBeGreaterThan(100)
  })
})
