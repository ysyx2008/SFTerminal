/**
 * 文件搜索服务
 * 提供跨平台的快速文件搜索能力
 * - macOS: 使用 Spotlight (mdfind)
 * - Windows: 使用内置 Everything 便携版
 * - Linux: 使用 locate/plocate 或 fd
 */
import { spawn, execFile } from 'child_process'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import { app } from 'electron'
import { createLogger } from '../utils/logger'
import { createAbortError, isAbortError, throwIfAborted } from '../utils/abort'

const log = createLogger('FileSearch')

/**
 * 搜索结果
 */
export interface FileSearchResult {
  /** 文件完整路径 */
  path: string
  /** 文件名 */
  name: string
  /** 是否为目录 */
  isDirectory: boolean
  /** 文件大小（字节），可能为 undefined */
  size?: number
  /** 修改时间（毫秒时间戳），可能为 undefined */
  modifiedTime?: number
  /** 创建时间（毫秒时间戳），可能为 undefined */
  createdTime?: number
}

/**
 * 搜索选项
 */
export interface FileSearchOptions {
  /** 搜索关键词，支持通配符 * 和 ? */
  query: string
  /** 限制搜索目录（可选） */
  searchPath?: string
  /** 搜索类型：file（仅文件）、dir（仅目录）、all（全部，默认） */
  type?: 'file' | 'dir' | 'all'
  /** 最大结果数量，默认 50 */
  limit?: number
  /** 大小写敏感，默认 false */
  caseSensitive?: boolean
  /** 用户点停止时杀掉正在跑的搜索子进程 */
  signal?: AbortSignal
}

/**
 * 搜索后端类型
 */
type SearchBackend = 'spotlight' | 'everything' | 'locate' | 'fd' | 'native'

/**
 * 文件搜索服务
 */
export class FileSearchService {
  private everythingPath: string | null = null
  private everythingProcess: ReturnType<typeof spawn> | null = null
  private everythingReady: boolean = false
  private locateAvailable: boolean | null = null
  private fdAvailable: boolean | null = null

  constructor() {
    // 初始化 Everything 路径（仅 Windows）
    if (process.platform === 'win32') {
      this.everythingPath = this.getEverythingPath()
    }
  }

  /**
   * 获取内置 Everything 的路径
   */
  private getEverythingPath(): string {
    if (app.isPackaged) {
      return path.join(process.resourcesPath, 'everything')
    }
    return path.join(__dirname, '../../resources/everything')
  }

  /**
   * 检查 Everything 是否可用
   */
  private async checkEverythingAvailable(): Promise<boolean> {
    if (process.platform !== 'win32') {
      return false
    }

    if (!this.everythingPath) {
      return false
    }

    const esExe = path.join(this.everythingPath, 'es.exe')
    const everythingExe = path.join(this.everythingPath, 'Everything.exe')

    // 检查文件是否存在
    if (!fs.existsSync(esExe) || !fs.existsSync(everythingExe)) {
      log.info('Everything 文件不存在:', this.everythingPath)
      return false
    }

    return true
  }

  /**
   * 确保 Everything 正在运行
   */
  private async ensureEverythingRunning(signal?: AbortSignal): Promise<boolean> {
    if (process.platform !== 'win32' || !this.everythingPath) {
      return false
    }

    // 检查 Everything 进程是否已运行
    if (this.everythingReady) {
      return true
    }

    const everythingExe = path.join(this.everythingPath, 'Everything.exe')
    
    // 检查是否已有 Everything 进程运行
    try {
      const result = await this.execCommand('tasklist', ['/FI', 'IMAGENAME eq Everything.exe', '/NH'])
      if (result.includes('Everything.exe')) {
        this.everythingReady = true
        return true
      }
    } catch {
      // 忽略错误
    }

    // 启动 Everything（后台运行，最小化）
    log.info('启动 Everything...')
    this.everythingProcess = spawn(everythingExe, ['-startup', '-minimized'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    })
    this.everythingProcess.unref()

    // 等待 Everything 就绪（最多等待 30 秒）
    const startTime = Date.now()
    const maxWait = 30000
    
    while (Date.now() - startTime < maxWait) {
      throwIfAborted(signal)
      await new Promise(resolve => setTimeout(resolve, 1000))
      
      // 检查 es.exe 是否可以正常工作
      try {
        const esExe = path.join(this.everythingPath, 'es.exe')
        await this.execCommand(esExe, ['-n', '1', 'test'], signal)
        this.everythingReady = true
        log.info('Everything 已就绪')
        return true
      } catch (error) {
        if (isAbortError(error)) throw error
        // 继续等待
      }
    }

    log.info('Everything 启动超时')
    return false
  }

  /**
   * 检查 locate 是否可用
   */
  private async checkLocateAvailable(): Promise<boolean> {
    if (this.locateAvailable !== null) {
      return this.locateAvailable
    }

    try {
      // 尝试 plocate（更现代的版本）
      await this.execCommand('plocate', ['--version'])
      this.locateAvailable = true
      return true
    } catch {
      try {
        // 尝试传统 locate
        await this.execCommand('locate', ['--version'])
        this.locateAvailable = true
        return true
      } catch {
        this.locateAvailable = false
        return false
      }
    }
  }

  /**
   * 检查 fd 是否可用
   */
  private async checkFdAvailable(): Promise<boolean> {
    if (this.fdAvailable !== null) {
      return this.fdAvailable
    }

    try {
      await this.execCommand('fd', ['--version'])
      this.fdAvailable = true
      return true
    } catch {
      try {
        // 有些系统上叫 fdfind
        await this.execCommand('fdfind', ['--version'])
        this.fdAvailable = true
        return true
      } catch {
        this.fdAvailable = false
        return false
      }
    }
  }

  /**
   * 执行命令并返回输出。传入 signal 时，中止会杀掉子进程。
   */
  private execCommand(command: string, args: string[], signal?: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(createAbortError())
        return
      }

      let settled = false
      let onAbort: (() => void) | undefined
      const finish = (fn: () => void) => {
        if (settled) return
        settled = true
        if (onAbort) signal?.removeEventListener('abort', onAbort)
        fn()
      }

      const child = execFile(command, args, { maxBuffer: 10 * 1024 * 1024 }, (error, stdout, _stderr) => {
        if (signal?.aborted) {
          finish(() => reject(createAbortError()))
          return
        }
        if (error) {
          finish(() => reject(error))
        } else {
          finish(() => resolve(stdout))
        }
      })

      onAbort = () => {
        child.kill()
        finish(() => reject(createAbortError()))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted) onAbort()
    })
  }

  /**
   * 主搜索方法
   */
  async search(options: FileSearchOptions): Promise<FileSearchResult[]> {
    const { query, searchPath, type = 'all', limit = 50, signal } = options

    if (!query || query.trim() === '') {
      return []
    }
    throwIfAborted(signal)

    // 根据平台选择搜索后端
    let backend: SearchBackend
    let results: FileSearchResult[]

    if (process.platform === 'darwin') {
      // macOS: 使用 Spotlight
      backend = 'spotlight'
      results = await this.searchWithSpotlight(query, searchPath, type, limit, signal)
    } else if (process.platform === 'win32') {
      // Windows: 优先使用 Everything
      const everythingAvailable = await this.checkEverythingAvailable()
      if (everythingAvailable) {
        const running = await this.ensureEverythingRunning(signal)
        if (running) {
          backend = 'everything'
          results = await this.searchWithEverything(query, searchPath, type, limit, signal)
        } else {
          // Everything 未就绪，使用原生搜索
          backend = 'native'
          results = await this.searchNative(query, searchPath || os.homedir(), type, limit, signal)
        }
      } else {
        // Everything 不可用，使用原生搜索
        backend = 'native'
        results = await this.searchNative(query, searchPath || os.homedir(), type, limit, signal)
      }
    } else {
      // Linux: 优先使用 locate，其次 fd
      // 如果都不可用，抛出错误提示用户安装或使用 find 命令
      const locateAvailable = await this.checkLocateAvailable()
      if (locateAvailable) {
        backend = 'locate'
        results = await this.searchWithLocate(query, searchPath, type, limit, signal)
      } else {
        const fdAvailable = await this.checkFdAvailable()
        if (fdAvailable) {
          backend = 'fd'
          results = await this.searchWithFd(query, searchPath || os.homedir(), type, limit, signal)
        } else {
          // Linux 上没有 locate 或 fd，抛出错误
          // 不使用 native 搜索（深度限制且性能差，用户体验不佳）
          throw new Error(
            'Linux 系统未安装 locate 或 fd 工具。\n' +
            '请使用 find 命令搜索，例如: find /path -name "*.txt"\n' +
            '或安装搜索工具:\n' +
            '  - Ubuntu/Debian: sudo apt install plocate\n' +
            '  - Fedora: sudo dnf install plocate\n' +
            '  - Arch: sudo pacman -S plocate\n' +
            '  - 或安装 fd: sudo apt install fd-find'
          )
        }
      }
    }

    log.info(`使用 ${backend} 搜索 "${query}"，找到 ${results.length} 个结果`)
    return results
  }

  /**
   * 转义 Spotlight 查询中的单引号，防止查询语法被破坏
   */
  private escapeSpotlightQuery(query: string): string {
    // 先转义反斜杠，再转义单引号，防止输入中已有的 \ 导致转义失效
    return query.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
  }

  /**
   * 解析查询字符串：
   * - 含通配符（*?）：作为整体 glob 模式
   * - 纯文本：按空白拆分为多个关键词（AND 关系）
   */
  private parseKeywords(query: string): {
    hasWildcard: boolean
    keywords: string[]
  } {
    const trimmed = query.trim()
    const hasWildcard = trimmed.includes('*') || trimmed.includes('?')
    if (hasWildcard) {
      return { hasWildcard: true, keywords: [trimmed] }
    }
    return {
      hasWildcard: false,
      keywords: trimmed.split(/\s+/).filter(Boolean)
    }
  }

  /**
   * 转义正则特殊字符，把字符串变为字面量正则
   */
  private escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }

  /**
   * 在内存中按关键词 AND 过滤 basename（不区分大小写）
   */
  private filenameMatchesAll(name: string, keywords: string[]): boolean {
    const lower = name.toLowerCase()
    return keywords.every(kw => lower.includes(kw.toLowerCase()))
  }

  /**
   * 构建 Spotlight 查询参数
   *
   * 三种模式：
   * - 含通配符：使用 kMDItemFSName 查询语法（glob 匹配）
   * - 单关键词纯文本：使用 -name（子串匹配，简单高效）
   * - 多关键词纯文本：使用 kMDItemFSName == '*kw*'cd && ... 复合 AND 查询
   *
   * @returns args 参数数组；hasWildcard 是否含通配符；typeFilteredInQuery 类型过滤是否已写入查询（true 表示无需代码层再过滤）
   */
  buildSpotlightArgs(
    query: string,
    searchPath?: string,
    type?: 'file' | 'dir' | 'all'
  ): { args: string[]; hasWildcard: boolean; typeFilteredInQuery: boolean } {
    const args: string[] = []

    if (searchPath) {
      args.push('-onlyin', searchPath)
    }

    const { hasWildcard, keywords } = this.parseKeywords(query)

    const appendTypeCondition = (conditions: string[]) => {
      if (type === 'dir') {
        conditions.push("kMDItemContentType == 'public.folder'")
      } else if (type === 'file') {
        conditions.push("kMDItemContentType != 'public.folder'")
      }
    }

    if (hasWildcard) {
      const escaped = this.escapeSpotlightQuery(query)
      const conditions: string[] = [`kMDItemFSName == '${escaped}'c`]
      appendTypeCondition(conditions)
      args.push(conditions.join(' && '))
      return { args, hasWildcard: true, typeFilteredInQuery: true }
    }

    if (keywords.length <= 1) {
      args.push('-name', keywords[0] ?? query)
      return { args, hasWildcard: false, typeFilteredInQuery: false }
    }

    // 多关键词：构建复合 AND 查询，每个关键词作为子串匹配文件名
    const conditions = keywords.map(
      kw => `kMDItemFSName == '*${this.escapeSpotlightQuery(kw)}*'cd`
    )
    appendTypeCondition(conditions)
    args.push(conditions.join(' && '))
    return { args, hasWildcard: false, typeFilteredInQuery: true }
  }

  /**
   * 使用 Spotlight (mdfind) 搜索 - macOS
   */
  private async searchWithSpotlight(
    query: string,
    searchPath?: string,
    type?: 'file' | 'dir' | 'all',
    limit?: number,
    signal?: AbortSignal
  ): Promise<FileSearchResult[]> {
    const { args, typeFilteredInQuery } = this.buildSpotlightArgs(query, searchPath, type)

    try {
      const output = await this.execCommand('mdfind', args, signal)
      const paths = output.trim().split('\n').filter(p => p.length > 0)
      
      // 获取文件信息并过滤，直到达到 limit 数量
      const results: FileSearchResult[] = []
      const maxResults = limit || 50
      for (const filePath of paths) {
        if (results.length >= maxResults) break
        
        try {
          const stats = fs.statSync(filePath)
          const isDir = stats.isDirectory()

          // 类型过滤已在查询条件中完成时跳过代码层过滤
          if (!typeFilteredInQuery) {
            if (type === 'file' && isDir) continue
            if (type === 'dir' && !isDir) continue
          }

          results.push({
            path: filePath,
            name: path.basename(filePath),
            isDirectory: isDir,
            size: stats.size,
            modifiedTime: stats.mtimeMs,
            createdTime: stats.birthtimeMs
          })
        } catch {
          // 文件可能已被删除或无权限访问
          continue
        }
      }

      return results
    } catch (error) {
      if (isAbortError(error)) throw error
      log.error('Spotlight 搜索失败:', error)
      return []
    }
  }

  /**
   * 使用 Everything (es.exe) 搜索 - Windows
   */
  private async searchWithEverything(
    query: string,
    searchPath?: string,
    type?: 'file' | 'dir' | 'all',
    limit?: number,
    signal?: AbortSignal
  ): Promise<FileSearchResult[]> {
    if (!this.everythingPath) {
      return []
    }

    const esExe = path.join(this.everythingPath, 'es.exe')
    const args: string[] = []

    // 限制结果数量
    args.push('-n', String(limit || 50))

    // 类型过滤
    if (type === 'dir') {
      args.push('-ad')  // 仅目录
    } else if (type === 'file') {
      args.push('-a-d') // 仅文件（排除目录）
    }

    // 构建搜索查询
    let searchQuery = query
    if (searchPath) {
      // 限制搜索路径
      searchQuery = `"${searchPath}" ${query}`
    }
    args.push(searchQuery)

    try {
      const output = await this.execCommand(esExe, args, signal)
      const paths = output.trim().split('\n').filter(p => p.length > 0)
      
      // 获取文件信息
      const results: FileSearchResult[] = []
      for (const filePath of paths) {
        try {
          const stats = fs.statSync(filePath)
          results.push({
            path: filePath,
            name: path.basename(filePath),
            isDirectory: stats.isDirectory(),
            size: stats.size,
            modifiedTime: stats.mtimeMs,
            createdTime: stats.birthtimeMs
          })
        } catch {
          // 文件可能已被删除
          results.push({
            path: filePath,
            name: path.basename(filePath),
            isDirectory: false
          })
        }
      }

      return results
    } catch (error) {
      if (isAbortError(error)) throw error
      log.error('Everything 搜索失败:', error)
      return []
    }
  }

  /**
   * 使用 locate/plocate 搜索 - Linux
   */
  private async searchWithLocate(
    query: string,
    searchPath?: string,
    type?: 'file' | 'dir' | 'all',
    limit?: number,
    signal?: AbortSignal
  ): Promise<FileSearchResult[]> {
    // 优先使用 plocate
    const locateCmd = await this.checkPlocateOrLocate()
    const { hasWildcard, keywords } = this.parseKeywords(query)
    const maxResults = limit || 50

    // locate 只支持单 pattern，多关键词时挑最长的当 pattern，剩余关键词在内存过滤
    const isMultiKeyword = !hasWildcard && keywords.length > 1
    const primaryPattern = hasWildcard
      ? query
      : isMultiKeyword
        ? [...keywords].sort((a, b) => b.length - a.length)[0]
        : keywords[0] ?? query
    const filterKeywords = isMultiKeyword
      ? keywords.filter(kw => kw !== primaryPattern)
      : []

    // 多关键词时上游需多抓些再过滤
    const fetchLimit = isMultiKeyword ? Math.max(maxResults * 10, 500) : maxResults

    const args: string[] = ['-i', '-l', String(fetchLimit), primaryPattern]

    try {
      const output = await this.execCommand(locateCmd, args, signal)
      let paths = output.trim().split('\n').filter(p => p.length > 0)
      
      // 路径过滤
      if (searchPath) {
        paths = paths.filter(p => p.startsWith(searchPath))
      }

      // 获取文件信息并过滤，直到达到 limit 数量
      const results: FileSearchResult[] = []
      for (const filePath of paths) {
        if (results.length >= maxResults) break

        const baseName = path.basename(filePath)
        if (filterKeywords.length > 0 && !this.filenameMatchesAll(baseName, filterKeywords)) {
          continue
        }

        try {
          const stats = fs.statSync(filePath)
          const isDir = stats.isDirectory()

          // 类型过滤
          if (type === 'file' && isDir) continue
          if (type === 'dir' && !isDir) continue

          results.push({
            path: filePath,
            name: baseName,
            isDirectory: isDir,
            size: stats.size,
            modifiedTime: stats.mtimeMs,
            createdTime: stats.birthtimeMs
          })
        } catch {
          continue
        }
      }

      return results
    } catch (error) {
      if (isAbortError(error)) throw error
      log.error('locate 搜索失败:', error)
      return []
    }
  }

  /**
   * 检查 plocate 或 locate 可用性
   */
  private async checkPlocateOrLocate(): Promise<string> {
    try {
      await this.execCommand('plocate', ['--version'])
      return 'plocate'
    } catch {
      return 'locate'
    }
  }

  /**
   * 使用 fd 搜索
   */
  private async searchWithFd(
    query: string,
    searchPath: string,
    type?: 'file' | 'dir' | 'all',
    limit?: number,
    signal?: AbortSignal
  ): Promise<FileSearchResult[]> {
    // 检测 fd 命令名（有些系统叫 fdfind）
    let fdCmd = 'fd'
    try {
      await this.execCommand('fd', ['--version'])
    } catch {
      fdCmd = 'fdfind'
    }

    const { hasWildcard, keywords } = this.parseKeywords(query)
    const maxResults = limit || 50

    // fd 只支持单 pattern。多关键词时挑最长的当 pattern，剩余关键词在内存过滤
    const isMultiKeyword = !hasWildcard && keywords.length > 1
    const primaryPattern = hasWildcard
      ? query
      : isMultiKeyword
        ? [...keywords].sort((a, b) => b.length - a.length)[0]
        : keywords[0] ?? query
    const filterKeywords = isMultiKeyword
      ? keywords.filter(kw => kw !== primaryPattern)
      : []

    // fd 默认使用正则，纯文本关键词需要转义；通配符模式保持原样（不严格 glob，但兼容现有行为）
    const fdPattern = hasWildcard ? primaryPattern : this.escapeRegex(primaryPattern)

    // 多关键词时上游需多抓些再过滤
    const fetchLimit = isMultiKeyword ? Math.max(maxResults * 10, 500) : maxResults

    const args: string[] = ['-i']
    if (type === 'file') {
      args.push('-t', 'f')
    } else if (type === 'dir') {
      args.push('-t', 'd')
    }
    args.push('--max-results', String(fetchLimit))
    args.push(fdPattern)
    args.push(searchPath)

    try {
      const output = await this.execCommand(fdCmd, args, signal)
      const paths = output.trim().split('\n').filter(p => p.length > 0)
      
      // 获取文件信息
      const results: FileSearchResult[] = []
      for (const filePath of paths) {
        if (results.length >= maxResults) break

        const baseName = path.basename(filePath)
        if (filterKeywords.length > 0 && !this.filenameMatchesAll(baseName, filterKeywords)) {
          continue
        }

        try {
          const stats = fs.statSync(filePath)
          results.push({
            path: filePath,
            name: baseName,
            isDirectory: stats.isDirectory(),
            size: stats.size,
            modifiedTime: stats.mtimeMs,
            createdTime: stats.birthtimeMs
          })
        } catch {
          continue
        }
      }

      return results
    } catch (error) {
      if (isAbortError(error)) throw error
      log.error('fd 搜索失败:', error)
      return []
    }
  }

  /**
   * 原生搜索（Fallback）
   * 使用 Node.js 递归遍历文件系统
   */
  private async searchNative(
    query: string,
    searchPath: string,
    type?: 'file' | 'dir' | 'all',
    limit?: number,
    signal?: AbortSignal
  ): Promise<FileSearchResult[]> {
    const results: FileSearchResult[] = []
    const maxResults = limit || 50
    const maxDepth = 5 // 限制搜索深度
    const maxDirEntries = 1000 // 每个目录最多读取的条目数

    // 多关键词 AND：每个关键词转独立 regex，全部命中才算匹配
    const patterns = this.buildNativePatterns(query)
    const matches = (name: string) => patterns.every(re => re.test(name))

    const searchDir = async (dir: string, depth: number) => {
      throwIfAborted(signal)
      if (depth > maxDepth || results.length >= maxResults) {
        return
      }

      try {
        const entries = await fs.promises.readdir(dir, { withFileTypes: true })
        let count = 0

        for (const entry of entries) {
          throwIfAborted(signal)
          if (count >= maxDirEntries || results.length >= maxResults) {
            break
          }
          count++

          // 跳过隐藏文件和系统目录
          if (entry.name.startsWith('.') || 
              entry.name === 'node_modules' || 
              entry.name === '$RECYCLE.BIN') {
            continue
          }

          const fullPath = path.join(dir, entry.name)
          const isDir = entry.isDirectory()

          // 类型过滤
          if (type === 'file' && isDir) {
            // 仍需递归搜索子目录
            await searchDir(fullPath, depth + 1)
            continue
          }
          if (type === 'dir' && !isDir) {
            continue
          }

          // 名称匹配（多关键词 AND）
          if (matches(entry.name)) {
            try {
              const stats = await fs.promises.stat(fullPath)
              results.push({
                path: fullPath,
                name: entry.name,
                isDirectory: isDir,
                size: stats.size,
                modifiedTime: stats.mtimeMs,
                createdTime: stats.birthtimeMs
              })
            } catch {
              results.push({
                path: fullPath,
                name: entry.name,
                isDirectory: isDir
              })
            }
          }

          // 递归搜索子目录
          if (isDir && results.length < maxResults) {
            await searchDir(fullPath, depth + 1)
          }
        }
      } catch (error) {
        if (isAbortError(error)) throw error
        // 无权限访问，跳过
      }
    }

    await searchDir(searchPath, 0)
    return results
  }

  /**
   * 将通配符转换为正则表达式
   * - * → .*
   * - ? → .
   */
  private wildcardToRegex(pattern: string): RegExp {
    // 转义特殊字符
    const regex = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.')

    return new RegExp(regex, 'i')
  }

  /**
   * 为原生递归搜索构建匹配 regex 列表
   * - 单关键词或通配符模式：返回单个 regex（保持兼容）
   * - 多关键词纯文本：每个关键词转字面量 regex（子串匹配，不区分大小写），AND 关系
   */
  private buildNativePatterns(query: string): RegExp[] {
    const { hasWildcard, keywords } = this.parseKeywords(query)
    if (hasWildcard) {
      return [this.wildcardToRegex(query)]
    }
    if (keywords.length <= 1) {
      return [this.wildcardToRegex(keywords[0] ?? query)]
    }
    return keywords.map(kw => new RegExp(this.escapeRegex(kw), 'i'))
  }

  /**
   * 获取当前使用的搜索后端信息
   */
  async getBackendInfo(): Promise<{
    platform: string
    backend: SearchBackend
    ready: boolean
    message: string
  }> {
    const platform = process.platform

    if (platform === 'darwin') {
      return {
        platform: 'macOS',
        backend: 'spotlight',
        ready: true,
        message: '使用 Spotlight 索引，毫秒级搜索'
      }
    }

    if (platform === 'win32') {
      const available = await this.checkEverythingAvailable()
      if (available) {
        const ready = this.everythingReady
        return {
          platform: 'Windows',
          backend: 'everything',
          ready,
          message: ready 
            ? '使用 Everything 索引，毫秒级搜索' 
            : 'Everything 正在初始化索引...'
        }
      } else {
        return {
          platform: 'Windows',
          backend: 'native',
          ready: true,
          message: 'Everything 未找到，使用原生搜索（较慢）'
        }
      }
    }

    // Linux
    const locateAvailable = await this.checkLocateAvailable()
    if (locateAvailable) {
      return {
        platform: 'Linux',
        backend: 'locate',
        ready: true,
        message: '使用 locate 索引'
      }
    }

    const fdAvailable = await this.checkFdAvailable()
    if (fdAvailable) {
      return {
        platform: 'Linux',
        backend: 'fd',
        ready: true,
        message: '使用 fd 实时搜索'
      }
    }

    return {
      platform: 'Linux',
      backend: 'native',
      ready: true,
      message: '使用原生搜索（较慢）'
    }
  }

  /**
   * 清理资源
   */
  cleanup(): void {
    // Windows: 不需要关闭 Everything，让它保持运行
    // 用户可能还需要使用它
  }
}

// 单例
let fileSearchService: FileSearchService | null = null

/**
 * 获取文件搜索服务实例
 */
export function getFileSearchService(): FileSearchService {
  if (!fileSearchService) {
    fileSearchService = new FileSearchService()
  }
  return fileSearchService
}

