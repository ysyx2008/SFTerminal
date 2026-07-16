import { describe, expect, it } from 'vitest'
import {
  isLocalFilePath,
  matchBareFilePaths,
  trimPathOvermatch,
} from '../local-file-path'

describe('isLocalFilePath — UNC', () => {
  it('accepts \\\\server\\share and deeper paths', () => {
    expect(isLocalFilePath('\\\\fileserver\\docs')).toBe(true)
    expect(isLocalFilePath('\\\\fileserver\\docs\\报告.docx')).toBe(true)
    expect(isLocalFilePath('\\\\nas\\项目评估\\2026\\review.docx')).toBe(true)
  })

  it('accepts Markdown-collapsed single-backslash UNC', () => {
    expect(isLocalFilePath('\\nas\\media\\movies\\Inception.mkv')).toBe(true)
    expect(isLocalFilePath('\\server\\share')).toBe(true)
  })

  it('accepts forward-slash separators after UNC prefix', () => {
    expect(isLocalFilePath('\\\\fileserver/docs/report.docx')).toBe(true)
  })

  it('rejects incomplete UNC (server only)', () => {
    expect(isLocalFilePath('\\\\fileserver')).toBe(false)
    expect(isLocalFilePath('\\\\fileserver\\')).toBe(false)
    expect(isLocalFilePath('\\fileserver')).toBe(false)
  })

  it('still accepts drive / unix / home paths', () => {
    expect(isLocalFilePath('C:\\Users\\a\\b.docx')).toBe(true)
    expect(isLocalFilePath('/Users/a/b.docx')).toBe(true)
    expect(isLocalFilePath('~/Documents/a.docx')).toBe(true)
  })

  it('rejects CJK-first absolute paths (中文斜杠列举假阳性)', () => {
    expect(isLocalFilePath('/分类/问题/选项')).toBe(false)
    expect(isLocalFilePath('/填报说明/F/G')).toBe(false)
  })
})

describe('matchBareFilePaths', () => {
  it('links directory with trailing slash and Application Support spaces', () => {
    const p =
      '/Users/yushen/Library/Application Support/SailFish/agent-workspace/scratch/'
    expect(matchBareFilePaths(p)).toEqual([p])
  })

  it('links binary path without extension', () => {
    expect(matchBareFilePaths('/opt/homebrew/bin/python3')).toEqual([
      '/opt/homebrew/bin/python3',
    ])
  })

  it('links full .app bundle executable path (not truncated at .app)', () => {
    const p =
      '/Applications/Visual Studio Code.app/Contents/MacOS/Electron'
    expect(matchBareFilePaths(p)).toEqual([p])
  })

  it('still links paths with extensions and CJK after ASCII root', () => {
    expect(matchBareFilePaths('/Users/yushen/Desktop/test.txt')).toEqual([
      '/Users/yushen/Desktop/test.txt',
    ])
    expect(
      matchBareFilePaths('/Users/yushen/项目资料/国元证券/a.docx')
    ).toEqual(['/Users/yushen/项目资料/国元证券/a.docx'])
  })

  it('does not link single-segment paths without extension', () => {
    expect(matchBareFilePaths('/etc')).toEqual([])
    expect(matchBareFilePaths('/tmp')).toEqual([])
  })

  it('cuts space+CJK prose but keeps Application Support', () => {
    expect(trimPathOvermatch('/Users/yushen/Documents 下还有')).toBe(
      '/Users/yushen/Documents'
    )
    expect(
      matchBareFilePaths(
        '目录 /Users/yushen/Library/Application Support/SailFish 下'
      )
    ).toEqual(['/Users/yushen/Library/Application Support/SailFish'])
  })

  it('does not swallow shell redirection after home path', () => {
    const cmd =
      'ls -la ~/.qclaw/skills/evernote-yinxiang/ 2>/dev/null || echo "not installed"'
    expect(matchBareFilePaths(cmd)).toEqual([
      '~/.qclaw/skills/evernote-yinxiang/',
    ])
  })

  it('does not swallow CLI flags after path (Desktop -maxdepth)', () => {
    const cmd =
      'find /Users/yushen/Desktop -maxdepth 2 -name "*.html" -newer /Users/yushen/Desktop/.'
    expect(matchBareFilePaths(cmd)).toEqual([
      '/Users/yushen/Desktop',
      // Desktop/. 的尾点被当作标点裁掉，等价打开该目录
      '/Users/yushen/Desktop/',
    ])
  })

  it('glob: do not link paths followed by wildcard', () => {
    expect(
      matchBareFilePaths(
        'ls /Users/yushen/Desktop/sailfish-oem-strategy*.html 2>/dev/null'
      )
    ).toEqual([])
    expect(
      matchBareFilePaths('ls /Users/yushen/Desktop/*oem* 2>/dev/null')
    ).toEqual([])
  })

  it('does not link /dev/null', () => {
    expect(matchBareFilePaths('2>/dev/null')).toEqual([])
    expect(isLocalFilePath('/dev/null')).toBe(false)
  })

  it('does not link /dev/stderr /dev/stdout (stdio devices)', () => {
    expect(isLocalFilePath('/dev/stderr')).toBe(false)
    expect(isLocalFilePath('/dev/stdout')).toBe(false)
    expect(isLocalFilePath('/dev/stdin')).toBe(false)
    expect(matchBareFilePaths('-D /dev/stderr')).toEqual([])
  })

  it('still links other /dev paths (e.g. disk nodes)', () => {
    expect(isLocalFilePath('/dev/disk0')).toBe(true)
    expect(matchBareFilePaths('inspect /dev/disk0')).toEqual(['/dev/disk0'])
  })

  it('does not swallow https URL after /dev/stderr', () => {
    const cmd =
      'curl -D /dev/stderr https://cwbx.gyzq.com.cn:8068/service/OAlogin 2>&1'
    expect(matchBareFilePaths(cmd)).toEqual([])
  })

  it('does not link Chinese slash-delimited prose', () => {
    expect(
      matchBareFilePaths('表头（序号/分类/问题/选项/填报说明/F/G）')
    ).toEqual([])
  })

  it('links UNC with extension and directory share', () => {
    expect(matchBareFilePaths('\\\\nas\\media\\movies\\Inception.mkv')).toEqual([
      '\\\\nas\\media\\movies\\Inception.mkv',
    ])
    expect(matchBareFilePaths('\\nas\\media\\movies\\Inception.mkv')).toEqual([
      '\\nas\\media\\movies\\Inception.mkv',
    ])
    expect(matchBareFilePaths('\\\\server\\share')).toEqual(['\\\\server\\share'])
  })

  it('does not treat URL path segments as local paths', () => {
    expect(
      matchBareFilePaths(
        'curl -s "https://open.kuaicha365.com/skills/" 2>/dev/null | head -100'
      )
    ).toEqual([])
    expect(
      matchBareFilePaths('see http://example.com/a/b/c.txt for details')
    ).toEqual([])
  })

  it('still finds local path after a URL in the same line', () => {
    expect(
      matchBareFilePaths('curl https://example.com/x -o /Users/a/b/out.txt')
    ).toEqual(['/Users/a/b/out.txt'])
  })

  it('still links absolute paths after delimiters (space / equals / colon)', () => {
    expect(matchBareFilePaths('cd /Users/a/b/c')).toEqual(['/Users/a/b/c'])
    expect(matchBareFilePaths('PATH=/Users/a/bin/tool')).toEqual([
      '/Users/a/bin/tool',
    ])
    expect(matchBareFilePaths('读取文件:/Users/a/b/out.txt')).toEqual([
      '/Users/a/b/out.txt',
    ])
  })

  it('links paths whose basename contains fullwidth parentheses', () => {
    const p =
      '/Users/yushen/Library/CloudStorage/OneDrive-个人/文档/2026年7月-金融科技部-AI赋能培训方案（含Agent高阶班与编程实战班）'
    expect(matchBareFilePaths(p)).toEqual([p])
    expect(
      matchBareFilePaths(
        `mv "/Users/a/旧名" "${p}"`
      )
    ).toEqual(['/Users/a/旧名', p])
  })

  it('links paths with curly quotes and common fullwidth punctuation', () => {
    const names = [
      '《报告》“终稿”',
      '说‘你好’',
      '方案，修订版',
      '说明：v1',
      '注意！',
      '待定？',
      'A－B',
      '草稿～',
      '张·三',
      'A—B',
      '等等…',
    ]
    for (const name of names) {
      const p = `/Users/a/文档/${name}`
      expect(matchBareFilePaths(p), p).toEqual([p])
    }
  })

  it('still does not treat ASCII quotes as path characters', () => {
    expect(matchBareFilePaths('/Users/a/文档/file"name"')).toEqual([
      '/Users/a/文档/file',
    ])
    expect(matchBareFilePaths("/Users/a/文档/file'name")).toEqual([
      '/Users/a/文档/file',
    ])
  })

  it('still strips unmatched trailing fullwidth closer (prose wrap)', () => {
    expect(matchBareFilePaths('见 /Users/a/b/out.txt）')).toEqual([
      '/Users/a/b/out.txt',
    ])
  })
})
