/**
 * thinking-block.ts 单元测试
 *
 * 锁定 parseThinking 对后端 ai.service.ts 输出的两种 details 模板的解析行为，
 * 防止后续模板调整时静默失配（一旦失配，思考块会重新落入 v-html 渲染，
 * 又会引发 DynamicScroller 高度抖动）。
 */
import { describe, it, expect } from 'vitest'
import { parseThinking, estimateMessageStepVirtualSize } from './thinking-block'

describe('parseThinking', () => {
  it('返回 null 当内容不含思考块', () => {
    const result = parseThinking('Hello world')
    expect(result.thinking).toBeNull()
    expect(result.body).toBe('Hello world')
  })

  it('空字符串安全处理', () => {
    expect(parseThinking('')).toEqual({ thinking: null, body: '' })
  })

  it('解析流式中的未闭合思考块（<details open>）', () => {
    const content = `<details open>\n<summary>🤔 <strong>思考过程</strong>（点击折叠）</summary>\n\n<blockquote>\n\n用户希望我先读取配置文件\n再决定下一步`
    const result = parseThinking(content)
    expect(result.thinking).not.toBeNull()
    expect(result.thinking!.isDone).toBe(false)
    expect(result.thinking!.reasoning).toContain('用户希望我先读取配置文件')
    expect(result.thinking!.reasoning).toContain('再决定下一步')
    expect(result.body).toBe('')
  })

  it('解析完成后的闭合思考块（<details>）', () => {
    const content = `<details>\n<summary>🤔 <strong>思考过程</strong></summary>\n\n<blockquote>\n\n这是完整的推理\n\n</blockquote>\n</details>\n\n这是正文`
    const result = parseThinking(content)
    expect(result.thinking).not.toBeNull()
    expect(result.thinking!.isDone).toBe(true)
    expect(result.thinking!.reasoning).toBe('这是完整的推理')
    expect(result.body).toBe('这是正文')
  })

  it('思考块在中间时正确剥离前后内容', () => {
    const content = `开头\n<details>\n<summary>🤔 思考过程</summary>\n\n<blockquote>\n\nreasoning\n\n</blockquote>\n</details>\n结尾`
    const result = parseThinking(content)
    expect(result.thinking!.reasoning).toBe('reasoning')
    expect(result.body).toBe('开头\n\n结尾')
  })

  it('优先匹配闭合块——避免误把已闭合块识别为流式中', () => {
    const content = `<details>\n<summary>🤔 思考过程</summary>\n\n<blockquote>\n\nA\n\n</blockquote>\n</details>`
    const result = parseThinking(content)
    expect(result.thinking!.isDone).toBe(true)
  })

  it('没有 🤔 标记的 details 不会被识别为思考块', () => {
    const content = `<details>\n<summary>普通折叠</summary>\n\n<blockquote>\n\n内容\n\n</blockquote>\n</details>`
    const result = parseThinking(content)
    expect(result.thinking).toBeNull()
    expect(result.body).toBe(content)
  })

  it('流式刚开始（reasoning 为空）也能正确识别', () => {
    const content = `<details open>\n<summary>🤔 <strong>思考过程</strong>（点击折叠）</summary>\n\n<blockquote>\n\n`
    const result = parseThinking(content)
    expect(result.thinking).not.toBeNull()
    expect(result.thinking!.isDone).toBe(false)
    expect(result.thinking!.reasoning).toBe('')
  })

  it('details open 属性未被替换但已闭合 + 后续 divider/正文：CLOSED 优先命中，body 含 divider', () => {
    // 模拟 agent.ts:1765 替换尚未触发但流式数据已包含 </details> 闭合 + divider + 正文的边缘场景
    // （这是 claude review 担心的"OPEN 正则吞掉 divider"场景，需要确保 CLOSED 优先匹配）
    const content = `<details open>\n<summary>🤔 <strong>思考过程</strong></summary>\n\n<blockquote>\n\n推理内容\n\n</blockquote>\n</details>\n\n---\n\n### 💬 回复\n\n实际正文`
    const result = parseThinking(content)
    expect(result.thinking).not.toBeNull()
    expect(result.thinking!.isDone).toBe(true)
    expect(result.thinking!.reasoning).toBe('推理内容')
    expect(result.body).toContain('实际正文')
    expect(result.body).not.toContain('推理内容')
    expect(result.body).not.toContain('<details>')
    expect(result.body).not.toContain('<details open>')
  })
})

describe('estimateMessageStepVirtualSize', () => {
  const streamingThinking = `<details open>\n<summary>🤔 <strong>思考过程</strong></summary>\n\n<blockquote>\n\n` + '很长的推理'.repeat(200)

  it('流式思考中 reasoning 变长时预估高度保持稳定（折叠态）', () => {
    const short = estimateMessageStepVirtualSize({
      type: 'message',
      content: streamingThinking.slice(0, 120),
      isStreaming: true,
    })
    const long = estimateMessageStepVirtualSize({
      type: 'message',
      content: streamingThinking,
      isStreaming: true,
    })
    expect(short).toBe(long)
    expect(short).toBeLessThanOrEqual(80)
  })

  it('正文开始输出后随 body 增长', () => {
    const base = estimateMessageStepVirtualSize({
      type: 'message',
      content: `<details>\n<summary>🤔 思考</summary>\n\n<blockquote>\n\nr\n\n</blockquote>\n</details>\n\n短`,
      isStreaming: true,
    })
    const longer = estimateMessageStepVirtualSize({
      type: 'message',
      content: `<details>\n<summary>🤔 思考</summary>\n\n<blockquote>\n\nr\n\n</blockquote>\n</details>\n\n` + '正文'.repeat(100),
      isStreaming: true,
    })
    expect(longer).toBeGreaterThan(base)
  })

  it('用户展开思考块时计入额外高度', () => {
    const collapsed = estimateMessageStepVirtualSize(
      { type: 'message', content: streamingThinking, isStreaming: true },
      { thinkingExpanded: false }
    )
    const expanded = estimateMessageStepVirtualSize(
      { type: 'message', content: streamingThinking, isStreaming: true },
      { thinkingExpanded: true }
    )
    expect(expanded).toBeGreaterThan(collapsed)
  })
})
