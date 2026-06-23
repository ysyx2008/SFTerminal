import { describe, expect, it } from 'vitest'
import { extractArticleFromHtml } from '../readability-extract'

const NEWS_LIKE_HTML = `<!DOCTYPE html><html><head><title>让发展惠及人民_腾讯新闻</title></head><body>
<nav>首页 新闻 视频 登录</nav>
<div class="sidebar">
  <div class="video-player">精选视频 00:26 暂停 下一个</div>
  <a href="#">其他新闻链接</a>
</div>
<article>
  <h1>让发展惠及人民，把人权愿景落到实处</h1>
  <p>本报记者 李潇 李琰 万宇 宋豪新</p>
  <p>6月11日至12日，“2026·全球人权治理高端论坛”在北京举办。本次论坛由国务院新闻办公室、外交部共同主办，来自100多个国家和国际组织的400余位中外嘉宾参会研讨。</p>
  <p>与会嘉宾一致认为，发展权是一项不可剥夺的人权，各国应采取切实有效、团结一致的行动，让发展成果更多更公平惠及各国人民。</p>
  <p>冈比亚副总统穆罕默德·贾洛表示，《发展权利宣言》具有重大里程碑意义。伊拉克前总统阿卜杜勒·拉蒂夫·拉希德指出，发展对于人权事业具有不可或缺性。</p>
</article>
<footer>Copyright 腾讯网</footer>
</body></html>`

describe('extractArticleFromHtml (Readability)', () => {
  it('extracts main article and ignores sidebar video on news-like layout', async () => {
    const article = await extractArticleFromHtml(
      NEWS_LIKE_HTML,
      'https://news.qq.com/rain/a/20260613A02DBC00',
    )
    expect(article).not.toBeNull()
    const text = article!.textContent
    expect(text).toContain('全球人权治理高端论坛')
    expect(text).toContain('穆罕默德·贾洛')
    expect(text).not.toContain('精选视频')
    expect(text).not.toContain('00:26')
  })
})
