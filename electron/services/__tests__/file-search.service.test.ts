/**
 * file-search.service.ts 单元测试
 * 重点测试 Spotlight (mdfind) 查询构建逻辑，确保通配符和纯文本查询正确处理
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn().mockReturnValue('/mock/user/data'),
    getName: vi.fn().mockReturnValue('SailFish'),
    getVersion: vi.fn().mockReturnValue('1.0.0'),
    isPackaged: false
  }
}))

vi.mock('child_process', () => ({
  spawn: vi.fn(),
  execFile: vi.fn()
}))

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(true),
    statSync: vi.fn().mockReturnValue({
      isDirectory: () => false,
      size: 1024,
      mtimeMs: Date.now(),
      birthtimeMs: Date.now()
    }),
    promises: {
      readdir: vi.fn().mockResolvedValue([]),
      stat: vi.fn()
    }
  }
})

import { FileSearchService } from '../file-search.service'
import { execFile } from 'child_process'
import * as fs from 'fs'

const mockExecFile = vi.mocked(execFile)

/**
 * 让 mock 的 execFile 返回指定输出
 */
function mockExecFileOutput(output: string) {
  mockExecFile.mockImplementation((_cmd, _args, _opts, callback: any) => {
    callback(null, output, '')
    return {} as any
  })
}

/**
 * 让 mock 的 execFile 返回错误
 */
function mockExecFileError(error: Error) {
  mockExecFile.mockImplementation((_cmd, _args, _opts, callback: any) => {
    callback(error, '', '')
    return {} as any
  })
}

describe('FileSearchService', () => {
  let service: FileSearchService

  beforeEach(() => {
    vi.clearAllMocks()
    service = new FileSearchService()
  })

  afterEach(() => {
    service.cleanup()
  })

  // =========================================================================
  // buildSpotlightArgs - Spotlight 查询参数构建
  // =========================================================================
  describe('buildSpotlightArgs', () => {
    describe('纯文本查询（无通配符）', () => {
      it('应使用 -name 参数进行子串匹配', () => {
        const { args, hasWildcard } = service.buildSpotlightArgs('package.json')
        expect(args).toEqual(['-name', 'package.json'])
        expect(hasWildcard).toBe(false)
      })

      it('指定搜索路径时应添加 -onlyin', () => {
        const { args } = service.buildSpotlightArgs('config', '/Users/test/project')
        expect(args).toEqual(['-onlyin', '/Users/test/project', '-name', 'config'])
      })

      it('纯文本查询不应在参数中包含类型过滤（由代码层过滤）', () => {
        const { args: argsFile } = service.buildSpotlightArgs('readme', undefined, 'file')
        expect(argsFile).toEqual(['-name', 'readme'])

        const { args: argsDir } = service.buildSpotlightArgs('readme', undefined, 'dir')
        expect(argsDir).toEqual(['-name', 'readme'])
      })
    })

    describe('通配符查询', () => {
      it('包含 * 时应使用 kMDItemFSName 查询语法', () => {
        const { args, hasWildcard } = service.buildSpotlightArgs('*.ts')
        expect(args).toEqual(["kMDItemFSName == '*.ts'c"])
        expect(hasWildcard).toBe(true)
      })

      it('包含 ? 时应使用 kMDItemFSName 查询语法', () => {
        const { args, hasWildcard } = service.buildSpotlightArgs('config?.json')
        expect(args).toEqual(["kMDItemFSName == 'config?.json'c"])
        expect(hasWildcard).toBe(true)
      })

      it('通配符模式 + 搜索路径', () => {
        const { args } = service.buildSpotlightArgs('*.service.ts', '/Users/test/project')
        expect(args).toEqual(['-onlyin', '/Users/test/project', "kMDItemFSName == '*.service.ts'c"])
      })

      it('通配符模式 + type=file 应在查询中排除文件夹', () => {
        const { args } = service.buildSpotlightArgs('*.ts', undefined, 'file')
        expect(args).toEqual(["kMDItemFSName == '*.ts'c && kMDItemContentType != 'public.folder'"])
      })

      it('通配符模式 + type=dir 应在查询中只匹配文件夹', () => {
        const { args } = service.buildSpotlightArgs('project*', undefined, 'dir')
        expect(args).toEqual(["kMDItemFSName == 'project*'c && kMDItemContentType == 'public.folder'"])
      })

      it('通配符模式 + type=all 不应添加类型条件', () => {
        const { args } = service.buildSpotlightArgs('*.json', undefined, 'all')
        expect(args).toEqual(["kMDItemFSName == '*.json'c"])
      })

      it('通配符模式 + 搜索路径 + 类型过滤', () => {
        const { args } = service.buildSpotlightArgs('config*.json', '/Users/test', 'file')
        expect(args).toEqual([
          '-onlyin', '/Users/test',
          "kMDItemFSName == 'config*.json'c && kMDItemContentType != 'public.folder'"
        ])
      })
    })

    describe('安全性 - 单引号转义', () => {
      it('查询中包含单引号应被转义', () => {
        const { args } = service.buildSpotlightArgs("file'name*")
        expect(args).toEqual(["kMDItemFSName == 'file\\'name*'c"])
      })

      it('多个单引号应全部被转义', () => {
        const { args } = service.buildSpotlightArgs("it's*a'test*")
        expect(args).toEqual(["kMDItemFSName == 'it\\'s*a\\'test*'c"])
      })

      it('纯文本中的单引号不需要转义（-name 参数安全传递）', () => {
        // 单关键词路径（无空格），mdfind -name 通过 execFile 直接传参，无需转义
        const { args } = service.buildSpotlightArgs("it's_a_file")
        expect(args).toEqual(['-name', "it's_a_file"])
      })
    })

    describe('边界情况', () => {
      it('查询中间包含 * 的情况', () => {
        const { args } = service.buildSpotlightArgs('my*file.txt')
        expect(args).toEqual(["kMDItemFSName == 'my*file.txt'c"])
      })

      it('多个通配符的情况', () => {
        const { args } = service.buildSpotlightArgs('*config*')
        expect(args).toEqual(["kMDItemFSName == '*config*'c"])
      })

      it('同时包含 * 和 ? 的情况', () => {
        const { args } = service.buildSpotlightArgs('test?.log*')
        expect(args).toEqual(["kMDItemFSName == 'test?.log*'c"])
      })
    })

    describe('多关键词查询（空格分隔，AND 关系）', () => {
      it('两个关键词应构建 AND 复合查询', () => {
        const { args, hasWildcard } = service.buildSpotlightArgs('员工 奖惩')
        expect(args).toEqual([
          "kMDItemFSName == '*员工*'cd && kMDItemFSName == '*奖惩*'cd"
        ])
        expect(hasWildcard).toBe(false)
      })

      it('三个关键词应全部 AND', () => {
        const { args } = service.buildSpotlightArgs('金融科技部 Q1 报告')
        expect(args).toEqual([
          "kMDItemFSName == '*金融科技部*'cd && kMDItemFSName == '*Q1*'cd && kMDItemFSName == '*报告*'cd"
        ])
      })

      it('多关键词 + 搜索路径', () => {
        const { args } = service.buildSpotlightArgs('员工 奖惩', '/Users/test')
        expect(args).toEqual([
          '-onlyin', '/Users/test',
          "kMDItemFSName == '*员工*'cd && kMDItemFSName == '*奖惩*'cd"
        ])
      })

      it('多关键词 + type=file 应在查询中排除目录', () => {
        const { args, typeFilteredInQuery } = service.buildSpotlightArgs('员工 奖惩', undefined, 'file')
        expect(args).toEqual([
          "kMDItemFSName == '*员工*'cd && kMDItemFSName == '*奖惩*'cd && kMDItemContentType != 'public.folder'"
        ])
        expect(typeFilteredInQuery).toBe(true)
      })

      it('多关键词 + type=dir 应在查询中只匹配目录', () => {
        const { args } = service.buildSpotlightArgs('项目 笔记', undefined, 'dir')
        expect(args).toEqual([
          "kMDItemFSName == '*项目*'cd && kMDItemFSName == '*笔记*'cd && kMDItemContentType == 'public.folder'"
        ])
      })

      it('多关键词中的单引号应被转义', () => {
        const { args } = service.buildSpotlightArgs("it's report")
        expect(args).toEqual([
          "kMDItemFSName == '*it\\'s*'cd && kMDItemFSName == '*report*'cd"
        ])
      })

      it('多个连续空格应被规范化为单一分隔', () => {
        const { args } = service.buildSpotlightArgs('员工   奖惩')
        expect(args).toEqual([
          "kMDItemFSName == '*员工*'cd && kMDItemFSName == '*奖惩*'cd"
        ])
      })

      it('单关键词（trim 后）仍走 -name 高效路径', () => {
        const { args, typeFilteredInQuery } = service.buildSpotlightArgs('  package.json  ')
        expect(args).toEqual(['-name', 'package.json'])
        expect(typeFilteredInQuery).toBe(false)
      })
    })
  })

  // =========================================================================
  // buildNativePatterns - 原生递归搜索的多关键词 AND 匹配
  // =========================================================================
  describe('buildNativePatterns (原生搜索)', () => {
    function buildPatterns(query: string): RegExp[] {
      return (service as any).buildNativePatterns(query)
    }

    it('单关键词应返回单个 wildcard regex', () => {
      const patterns = buildPatterns('readme')
      expect(patterns).toHaveLength(1)
      expect(patterns[0].test('README.md')).toBe(true)
    })

    it('通配符模式应返回单个 wildcard regex', () => {
      const patterns = buildPatterns('*.ts')
      expect(patterns).toHaveLength(1)
      expect(patterns[0].test('app.ts')).toBe(true)
      expect(patterns[0].test('app.js')).toBe(false)
    })

    it('多关键词应返回多个字面量 regex（AND）', () => {
      const patterns = buildPatterns('员工 奖惩')
      expect(patterns).toHaveLength(2)
      const allMatch = (name: string) => patterns.every(re => re.test(name))
      expect(allMatch('员工奖惩管理.docx')).toBe(true)
      expect(allMatch('2024员工奖惩明细.xlsx')).toBe(true)
      // 缺一个关键词不算命中
      expect(allMatch('员工花名册.xlsx')).toBe(false)
      expect(allMatch('奖惩制度.pdf')).toBe(false)
    })

    it('多关键词应不区分大小写', () => {
      const patterns = buildPatterns('Annual Report')
      const allMatch = (name: string) => patterns.every(re => re.test(name))
      expect(allMatch('annual_report_2024.pdf')).toBe(true)
      expect(allMatch('ANNUAL-REPORT.docx')).toBe(true)
      expect(allMatch('annual.pdf')).toBe(false)
    })

    it('多关键词应转义正则元字符', () => {
      const patterns = buildPatterns('a.b c+d')
      // 关键词中的 . + 应被当字面量
      const allMatch = (name: string) => patterns.every(re => re.test(name))
      expect(allMatch('a.b-and-c+d.txt')).toBe(true)
      expect(allMatch('aXb-cYd.txt')).toBe(false)
    })
  })

  // =========================================================================
  // search - 完整搜索流程（macOS / Spotlight）
  // =========================================================================
  describe('search (Spotlight 路径)', () => {
    // 跳过非 macOS 平台
    const isMacOS = process.platform === 'darwin'
    const describeOnMac = isMacOS ? describe : describe.skip

    describeOnMac('searchWithSpotlight 集成', () => {
      it('纯文本查询应调用 mdfind -name', async () => {
        mockExecFileOutput('/Users/test/package.json\n/Users/test/sub/package.json\n')
        vi.mocked(fs.statSync).mockReturnValue({
          isDirectory: () => false,
          size: 512,
          mtimeMs: 1700000000000,
          birthtimeMs: 1690000000000
        } as any)

        const results = await service.search({ query: 'package.json' })

        // 验证使用了 -name 参数
        const callArgs = mockExecFile.mock.calls[0]
        expect(callArgs[0]).toBe('mdfind')
        expect(callArgs[1]).toContain('-name')
        expect(callArgs[1]).toContain('package.json')

        expect(results).toHaveLength(2)
        expect(results[0].path).toBe('/Users/test/package.json')
        expect(results[0].name).toBe('package.json')
        expect(results[0].isDirectory).toBe(false)
        expect(results[0].size).toBe(512)
      })

      it('通配符查询应调用 mdfind 并使用 kMDItemFSName 语法', async () => {
        mockExecFileOutput('/Users/test/src/app.ts\n/Users/test/src/index.ts\n')
        vi.mocked(fs.statSync).mockReturnValue({
          isDirectory: () => false,
          size: 1024,
          mtimeMs: Date.now(),
          birthtimeMs: Date.now()
        } as any)

        const results = await service.search({ query: '*.ts' })

        // 验证使用了 kMDItemFSName 查询语法
        const callArgs = mockExecFile.mock.calls[0]
        expect(callArgs[0]).toBe('mdfind')
        expect(callArgs[1]).toEqual(["kMDItemFSName == '*.ts'c"])

        expect(results).toHaveLength(2)
      })

      it('通配符查询 + searchPath 应添加 -onlyin', async () => {
        mockExecFileOutput('/Users/test/project/config.json\n')
        vi.mocked(fs.statSync).mockReturnValue({
          isDirectory: () => false,
          size: 256,
          mtimeMs: Date.now(),
          birthtimeMs: Date.now()
        } as any)

        await service.search({
          query: 'config*.json',
          searchPath: '/Users/test/project'
        })

        const callArgs = mockExecFile.mock.calls[0]
        expect(callArgs[0]).toBe('mdfind')
        expect(callArgs[1]).toEqual([
          '-onlyin', '/Users/test/project',
          "kMDItemFSName == 'config*.json'c"
        ])
      })

      it('通配符查询 + type=dir 应在查询中过滤类型', async () => {
        mockExecFileOutput('/Users/test/project-a\n/Users/test/project-b\n')
        vi.mocked(fs.statSync).mockReturnValue({
          isDirectory: () => true,
          size: 0,
          mtimeMs: Date.now(),
          birthtimeMs: Date.now()
        } as any)

        const results = await service.search({ query: 'project*', type: 'dir' })

        const callArgs = mockExecFile.mock.calls[0]
        expect(callArgs[0]).toBe('mdfind')
        expect(callArgs[1]).toEqual([
          "kMDItemFSName == 'project*'c && kMDItemContentType == 'public.folder'"
        ])
        expect(results).toHaveLength(2)
        expect(results[0].isDirectory).toBe(true)
      })

      it('纯文本查询 + type=file 应在代码中过滤掉目录', async () => {
        mockExecFileOutput('/Users/test/readme\n/Users/test/readme-dir\n')
        const statMock = vi.mocked(fs.statSync)
        statMock
          .mockReturnValueOnce({
            isDirectory: () => false,
            size: 100,
            mtimeMs: Date.now(),
            birthtimeMs: Date.now()
          } as any)
          .mockReturnValueOnce({
            isDirectory: () => true,
            size: 0,
            mtimeMs: Date.now(),
            birthtimeMs: Date.now()
          } as any)

        const results = await service.search({ query: 'readme', type: 'file' })

        // 应过滤掉目录，只保留文件
        expect(results).toHaveLength(1)
        expect(results[0].path).toBe('/Users/test/readme')
      })

      it('mdfind 失败时应返回空数组', async () => {
        mockExecFileError(new Error('mdfind failed'))

        const results = await service.search({ query: '*.ts' })
        expect(results).toEqual([])
      })

      it('空查询应返回空数组', async () => {
        const results = await service.search({ query: '' })
        expect(results).toEqual([])
      })

      it('应遵守 limit 限制', async () => {
        const paths = Array.from({ length: 100 }, (_, i) => `/Users/test/file${i}.ts`).join('\n')
        mockExecFileOutput(paths)
        vi.mocked(fs.statSync).mockReturnValue({
          isDirectory: () => false,
          size: 100,
          mtimeMs: Date.now(),
          birthtimeMs: Date.now()
        } as any)

        const results = await service.search({ query: '*.ts', limit: 10 })
        expect(results).toHaveLength(10)
      })

      it('stat 失败的文件应被跳过', async () => {
        mockExecFileOutput('/Users/test/exists.ts\n/Users/test/deleted.ts\n/Users/test/also-exists.ts\n')
        const statMock = vi.mocked(fs.statSync)
        statMock
          .mockReturnValueOnce({
            isDirectory: () => false,
            size: 100,
            mtimeMs: Date.now(),
            birthtimeMs: Date.now()
          } as any)
          .mockImplementationOnce(() => { throw new Error('ENOENT') })
          .mockReturnValueOnce({
            isDirectory: () => false,
            size: 200,
            mtimeMs: Date.now(),
            birthtimeMs: Date.now()
          } as any)

        const results = await service.search({ query: '*.ts' })
        expect(results).toHaveLength(2)
        expect(results[0].path).toBe('/Users/test/exists.ts')
        expect(results[1].path).toBe('/Users/test/also-exists.ts')
      })

      it('mdfind 输出为空时应返回空数组', async () => {
        mockExecFileOutput('')

        const results = await service.search({ query: 'nonexistent' })
        expect(results).toEqual([])
      })

      it('mdfind 输出包含空行时应正确过滤', async () => {
        mockExecFileOutput('/Users/test/file.ts\n\n\n/Users/test/other.ts\n')
        vi.mocked(fs.statSync).mockReturnValue({
          isDirectory: () => false,
          size: 100,
          mtimeMs: Date.now(),
          birthtimeMs: Date.now()
        } as any)

        const results = await service.search({ query: '*.ts' })
        expect(results).toHaveLength(2)
      })
    })
  })

  // =========================================================================
  // wildcardToRegex
  // =========================================================================
  describe('wildcardToRegex', () => {
    // 使用 searchNative 间接测试 wildcardToRegex（它是 private 的）
    // 这里直接通过类型转换访问
    function toRegex(pattern: string): RegExp {
      return (service as any).wildcardToRegex(pattern)
    }

    it('应将 * 转换为 .*', () => {
      const regex = toRegex('*.ts')
      expect(regex.test('app.ts')).toBe(true)
      expect(regex.test('index.ts')).toBe(true)
      expect(regex.test('app.js')).toBe(false)
    })

    it('应将 ? 转换为 .', () => {
      const regex = toRegex('file?.txt')
      expect(regex.test('file1.txt')).toBe(true)
      expect(regex.test('fileA.txt')).toBe(true)
      expect(regex.test('file12.txt')).toBe(false)
    })

    it('应转义正则特殊字符', () => {
      const regex = toRegex('my.file(1).txt')
      expect(regex.test('my.file(1).txt')).toBe(true)
      expect(regex.test('myXfile(1)Xtxt')).toBe(false)
    })

    it('应进行大小写不敏感匹配', () => {
      const regex = toRegex('README')
      expect(regex.test('README')).toBe(true)
      expect(regex.test('readme')).toBe(true)
      expect(regex.test('ReadMe')).toBe(true)
    })

    it('复杂通配符模式', () => {
      const regex = toRegex('*config*.json')
      expect(regex.test('config.json')).toBe(true)
      expect(regex.test('app-config-dev.json')).toBe(true)
      expect(regex.test('config.yaml')).toBe(false)
    })
  })

  // =========================================================================
  // getBackendInfo
  // =========================================================================
  describe('getBackendInfo', () => {
    it('macOS 应返回 spotlight 后端', async () => {
      if (process.platform !== 'darwin') return

      const info = await service.getBackendInfo()
      expect(info.platform).toBe('macOS')
      expect(info.backend).toBe('spotlight')
      expect(info.ready).toBe(true)
    })
  })
})
