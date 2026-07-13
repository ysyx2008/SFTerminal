/**
 * tool-call-link.ts 单元测试
 *
 * 锁定 tool_call content 中 URL / 本地路径自动拆分为可点击片段的行为。
 */
import { describe, it, expect } from 'vitest'
import { splitContentByUrl, splitToolCallContent } from './tool-call-link'

describe('splitContentByUrl', () => {
  it('typical web_fetch: content 含 http(s) URL → 拆成三段', () => {
    const result = splitContentByUrl(
      '阅读网页: https://example.com/foo',
      { url: 'https://example.com/foo' }
    )
    expect(result).toEqual({
      before: '阅读网页: ',
      url: 'https://example.com/foo',
      after: '',
    })
  })

  it('http URL 也通过', () => {
    const result = splitContentByUrl(
      'fetch: http://example.com/',
      { url: 'http://example.com/' }
    )
    expect(result?.url).toBe('http://example.com/')
  })

  it('URL 后还有文本（如尾缀字符数）→ after 非空', () => {
    const result = splitContentByUrl(
      '阅读网页: https://example.com/x · 1234 字符',
      { url: 'https://example.com/x' }
    )
    expect(result?.before).toBe('阅读网页: ')
    expect(result?.url).toBe('https://example.com/x')
    expect(result?.after).toBe(' · 1234 字符')
  })

  it('URL 在最前面 → before 为空串', () => {
    const result = splitContentByUrl(
      'https://example.com/x rest',
      { url: 'https://example.com/x' }
    )
    expect(result?.before).toBe('')
    expect(result?.url).toBe('https://example.com/x')
    expect(result?.after).toBe(' rest')
  })

  it('toolArgs 缺失 url 字段 → null（命令型工具走纯文本）', () => {
    expect(splitContentByUrl('执行命令: ls', { command: 'ls' })).toBeNull()
    expect(splitContentByUrl('any', undefined)).toBeNull()
    expect(splitContentByUrl('any', {})).toBeNull()
  })

  it('url 字段非字符串 → null', () => {
    expect(splitContentByUrl('x', { url: 123 })).toBeNull()
    expect(splitContentByUrl('x', { url: null })).toBeNull()
    expect(splitContentByUrl('x', { url: { nested: 'https://x.y' } })).toBeNull()
  })

  it('url 字段空串 → null（避免拆出来的链接是空 href）', () => {
    expect(splitContentByUrl('x', { url: '' })).toBeNull()
  })

  it('非 http(s) scheme → null（防 javascript: / data: / file: 注入）', () => {
    expect(splitContentByUrl('a javascript:alert(1)', { url: 'javascript:alert(1)' })).toBeNull()
    expect(splitContentByUrl('a data:text/html,x', { url: 'data:text/html,x' })).toBeNull()
    expect(splitContentByUrl('a file:///etc/passwd', { url: 'file:///etc/passwd' })).toBeNull()
    expect(splitContentByUrl('a vbscript:foo', { url: 'vbscript:foo' })).toBeNull()
  })

  it('url 字段是 http(s) 但 content 中找不到该 URL → null（避免错误标记）', () => {
    expect(splitContentByUrl(
      '阅读网页: https://example.com/short...',
      { url: 'https://example.com/short/very/long/path' }
    )).toBeNull()
  })

  it('http(s) 大小写不敏感', () => {
    const result = splitContentByUrl(
      'go HTTPS://Example.com/x',
      { url: 'HTTPS://Example.com/x' }
    )
    expect(result?.url).toBe('HTTPS://Example.com/x')
  })

  it('content 含多个相同 URL → 仅匹配第一个出现', () => {
    const result = splitContentByUrl(
      'https://x.com/a then https://x.com/a again',
      { url: 'https://x.com/a' }
    )
    expect(result?.before).toBe('')
    expect(result?.after).toBe(' then https://x.com/a again')
  })
})

describe('splitToolCallContent — path', () => {
  it('read_file: toolArgs.path 在 content 中 → path 片段可点击', () => {
    const path =
      '~/Library/Application Support/SailFish/agent-workspace/scratch/volcano_aicc_security.txt'
    const segs = splitToolCallContent(`读取文件: ${path}`, { path })
    expect(segs).toEqual([
      { kind: 'text', text: '读取文件: ' },
      { kind: 'path', path, display: path },
    ])
  })

  it('execute_command: 裸路径（含 Application\\ Support）可点击，打开时反转义空格', () => {
    const content =
      '执行命令: cd /Users/yushen/Library/Application\\ Support/SailFish/agent-workspace/scratch'
    const segs = splitToolCallContent(content, { command: 'cd ...' })
    const pathSeg = segs.find((s) => s.kind === 'path')
    expect(pathSeg).toEqual({
      kind: 'path',
      path: '/Users/yushen/Library/Application Support/SailFish/agent-workspace/scratch',
      display:
        '/Users/yushen/Library/Application\\ Support/SailFish/agent-workspace/scratch',
    })
  })

  it('url + path 可同时存在', () => {
    const segs = splitToolCallContent(
      'fetch https://example.com/x into /Users/a/b/out.txt',
      { url: 'https://example.com/x', path: '/Users/a/b/out.txt' }
    )
    expect(segs).toEqual([
      { kind: 'text', text: 'fetch ' },
      { kind: 'url', url: 'https://example.com/x' },
      { kind: 'text', text: ' into ' },
      { kind: 'path', path: '/Users/a/b/out.txt', display: '/Users/a/b/out.txt' },
    ])
  })

  it('无链接时退化为单段 text', () => {
    expect(splitToolCallContent('执行命令: ls -la', { command: 'ls -la' })).toEqual([
      { kind: 'text', text: '执行命令: ls -la' },
    ])
  })
})
