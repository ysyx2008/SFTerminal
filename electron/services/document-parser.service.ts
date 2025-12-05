/**
 * 文档解析服务
 * 用于解析用户上传的文档（PDF、Word、文本等），提取文本内容作为 AI 对话的上下文
 */

import * as fs from 'fs'
import * as path from 'path'

// 文档解析结果接口
export interface ParsedDocument {
  /** 原始文件名 */
  filename: string
  /** 文件类型 */
  fileType: DocumentType
  /** 解析后的文本内容 */
  content: string
  /** 文件大小（字节） */
  fileSize: number
  /** 解析时间（毫秒） */
  parseTime: number
  /** 页数（如果适用） */
  pageCount?: number
  /** 元数据 */
  metadata?: Record<string, string>
  /** 错误信息（如果解析失败） */
  error?: string
}

// 支持的文档类型
export type DocumentType = 
  | 'pdf'
  | 'docx'
  | 'doc'
  | 'txt'
  | 'md'
  | 'json'
  | 'xml'
  | 'html'
  | 'csv'
  | 'unknown'

// 上传的文件信息
export interface UploadedFile {
  /** 文件名 */
  name: string
  /** 文件路径（临时路径或完整路径） */
  path: string
  /** 文件大小 */
  size: number
  /** MIME 类型 */
  mimeType?: string
}

// 文档解析选项
export interface ParseOptions {
  /** 最大文件大小（字节），默认 10MB */
  maxFileSize?: number
  /** 最大提取文本长度（字符），默认 100000 */
  maxTextLength?: number
  /** 是否提取元数据，默认 true */
  extractMetadata?: boolean
}

// 默认选项
const DEFAULT_OPTIONS: Required<ParseOptions> = {
  maxFileSize: 10 * 1024 * 1024, // 10MB
  maxTextLength: 100000, // 100K 字符
  extractMetadata: true
}

export class DocumentParserService {
  private PDFParser: typeof import('pdf2json').default | null = null
  private mammoth: typeof import('mammoth') | null = null
  private WordExtractor: typeof import('word-extractor').default | null = null
  private isInitialized = false

  constructor() {
    // 延迟加载解析库
  }

  /**
   * 初始化解析器（延迟加载依赖）
   */
  private async init(): Promise<void> {
    if (this.isInitialized) return

    try {
      // 动态导入 pdf2json（纯 Node.js 实现，不依赖浏览器 API）
      const pdf2jsonModule = await import('pdf2json')
      this.PDFParser = pdf2jsonModule.default
    } catch (e) {
      console.warn('[DocumentParser] pdf2json 未安装，PDF 解析将不可用:', e)
    }

    try {
      // 动态导入 mammoth
      this.mammoth = await import('mammoth')
    } catch (e) {
      console.warn('[DocumentParser] mammoth 未安装，.docx 解析将不可用:', e)
    }

    try {
      // 动态导入 word-extractor（用于 .doc 格式）
      const wordExtractorModule = await import('word-extractor')
      this.WordExtractor = wordExtractorModule.default
    } catch (e) {
      console.warn('[DocumentParser] word-extractor 未安装，.doc 解析将不可用:', e)
    }

    this.isInitialized = true
  }

  /**
   * 检测文件类型
   */
  detectFileType(filename: string, mimeType?: string): DocumentType {
    const ext = path.extname(filename).toLowerCase()
    
    // 根据扩展名判断
    switch (ext) {
      case '.pdf':
        return 'pdf'
      case '.docx':
        return 'docx'
      case '.doc':
        return 'doc'
      case '.txt':
        return 'txt'
      case '.md':
      case '.markdown':
        return 'md'
      case '.json':
        return 'json'
      case '.xml':
        return 'xml'
      case '.html':
      case '.htm':
        return 'html'
      case '.csv':
        return 'csv'
      default:
        break
    }

    // 根据 MIME 类型判断
    if (mimeType) {
      if (mimeType === 'application/pdf') return 'pdf'
      if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return 'docx'
      if (mimeType === 'application/msword') return 'doc'
      if (mimeType.startsWith('text/')) return 'txt'
      if (mimeType === 'application/json') return 'json'
      if (mimeType === 'application/xml' || mimeType === 'text/xml') return 'xml'
      if (mimeType === 'text/html') return 'html'
      if (mimeType === 'text/csv') return 'csv'
    }

    return 'unknown'
  }

  /**
   * 解析单个文档
   */
  async parseDocument(file: UploadedFile, options?: ParseOptions): Promise<ParsedDocument> {
    await this.init()
    
    const opts = { ...DEFAULT_OPTIONS, ...options }
    const startTime = Date.now()
    const fileType = this.detectFileType(file.name, file.mimeType)

    // 基础结果对象
    const result: ParsedDocument = {
      filename: file.name,
      fileType,
      content: '',
      fileSize: file.size,
      parseTime: 0
    }

    try {
      // 检查文件大小
      if (file.size > opts.maxFileSize) {
        throw new Error(`文件大小 ${this.formatFileSize(file.size)} 超过限制 ${this.formatFileSize(opts.maxFileSize)}`)
      }

      // 检查文件是否存在
      if (!fs.existsSync(file.path)) {
        throw new Error(`文件不存在: ${file.path}`)
      }

      // 根据文件类型选择解析方法
      switch (fileType) {
        case 'pdf':
          await this.parsePdf(file.path, result, opts)
          break
        case 'docx':
          await this.parseDocx(file.path, result, opts)
          break
        case 'doc':
          await this.parseDoc(file.path, result, opts)
          break
        case 'txt':
        case 'md':
        case 'json':
        case 'xml':
        case 'html':
        case 'csv':
          await this.parseTextFile(file.path, result, opts)
          break
        default:
          // 尝试作为文本解析
          try {
            await this.parseTextFile(file.path, result, opts)
          } catch {
            result.error = `不支持的文件类型: ${fileType}`
          }
      }

      // 截断过长的内容
      if (result.content.length > opts.maxTextLength) {
        result.content = result.content.substring(0, opts.maxTextLength)
        result.content += `\n\n... [内容已截断，原文共 ${result.content.length} 字符]`
      }

    } catch (error) {
      result.error = error instanceof Error ? error.message : '解析失败'
    }

    result.parseTime = Date.now() - startTime
    return result
  }

  /**
   * 批量解析文档
   */
  async parseDocuments(files: UploadedFile[], options?: ParseOptions): Promise<ParsedDocument[]> {
    const results: ParsedDocument[] = []
    
    for (const file of files) {
      const result = await this.parseDocument(file, options)
      results.push(result)
    }
    
    return results
  }

  /**
   * 解析 PDF 文件
   */
  private async parsePdf(filePath: string, result: ParsedDocument, _opts: Required<ParseOptions>): Promise<void> {
    if (!this.PDFParser) {
      throw new Error('PDF 解析库未安装，请运行: npm install pdf2json')
    }

    return new Promise((resolve, reject) => {
      const pdfParser = new this.PDFParser!(null, true)  // null = no password, true = return raw text
      
      pdfParser.on('pdfParser_dataError', (errData: { parserError: Error }) => {
        reject(new Error(`PDF 解析错误: ${errData.parserError.message}`))
      })
      
      pdfParser.on('pdfParser_dataReady', (pdfData: { Pages: Array<{ Texts: Array<{ R: Array<{ T: string }> }> }> }) => {
        try {
          // 提取所有文本
          const textContent: string[] = []
          let pageCount = 0
          
          if (pdfData.Pages) {
            pageCount = pdfData.Pages.length
            for (const page of pdfData.Pages) {
              const pageTexts: string[] = []
              if (page.Texts) {
                for (const text of page.Texts) {
                  if (text.R) {
                    for (const r of text.R) {
                      if (r.T) {
                        // 解码 URL 编码的文本
                        pageTexts.push(decodeURIComponent(r.T))
                      }
                    }
                  }
                }
              }
              textContent.push(pageTexts.join(' '))
            }
          }
          
          result.content = textContent.join('\n\n')
          result.pageCount = pageCount
          resolve()
        } catch (e) {
          reject(new Error(`PDF 文本提取失败: ${e instanceof Error ? e.message : '未知错误'}`))
        }
      })
      
      pdfParser.loadPDF(filePath)
    })
  }

  /**
   * 解析 Word 文档 (.docx)
   */
  private async parseDocx(filePath: string, result: ParsedDocument, _opts: Required<ParseOptions>): Promise<void> {
    if (!this.mammoth) {
      throw new Error('Word 解析库未安装，请运行: npm install mammoth')
    }

    const docxResult = await this.mammoth.extractRawText({ path: filePath })
    result.content = docxResult.value

    // 记录警告信息
    if (docxResult.messages && docxResult.messages.length > 0) {
      const warnings = docxResult.messages
        .filter((m: { type: string }) => m.type === 'warning')
        .map((m: { message: string }) => m.message)
        .join('; ')
      if (warnings) {
        result.metadata = { warnings }
      }
    }
  }

  /**
   * 解析 Word 文档 (.doc - 旧版格式)
   */
  private async parseDoc(filePath: string, result: ParsedDocument, _opts: Required<ParseOptions>): Promise<void> {
    if (!this.WordExtractor) {
      throw new Error('Word (.doc) 解析库未安装，请运行: npm install word-extractor')
    }

    const extractor = new this.WordExtractor()
    const doc = await extractor.extract(filePath)
    
    // 获取文档正文
    result.content = doc.getBody()
    
    // 提取元数据（如果有）
    const headers = doc.getHeaders()
    const footers = doc.getFooters()
    
    if (headers || footers) {
      result.metadata = {}
      if (headers) result.metadata.headers = headers
      if (footers) result.metadata.footers = footers
    }
  }

  /**
   * 解析文本文件
   */
  private async parseTextFile(filePath: string, result: ParsedDocument, _opts: Required<ParseOptions>): Promise<void> {
    // 尝试检测编码并读取
    const content = fs.readFileSync(filePath, 'utf-8')
    result.content = content
  }

  /**
   * 格式化文件大小
   */
  private formatFileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }

  /**
   * 生成文档摘要（用于显示给用户）
   */
  generateSummary(doc: ParsedDocument): string {
    const lines: string[] = []
    
    lines.push(`📄 **${doc.filename}**`)
    lines.push(`- 类型: ${doc.fileType.toUpperCase()}`)
    lines.push(`- 大小: ${this.formatFileSize(doc.fileSize)}`)
    
    if (doc.pageCount) {
      lines.push(`- 页数: ${doc.pageCount}`)
    }
    
    lines.push(`- 内容长度: ${doc.content.length} 字符`)
    
    if (doc.error) {
      lines.push(`- ⚠️ 错误: ${doc.error}`)
    }
    
    return lines.join('\n')
  }

  /**
   * 将解析结果格式化为 AI 上下文
   */
  formatAsContext(docs: ParsedDocument[]): string {
    if (docs.length === 0) return ''

    const parts: string[] = []
    
    parts.push('=== 用户上传的参考文档（内容已包含在下方，请直接阅读，无需使用工具读取）===\n')
    
    for (let i = 0; i < docs.length; i++) {
      const doc = docs[i]
      
      if (doc.error) {
        parts.push(`[文档 ${i + 1}: ${doc.filename}]\n⚠️ 解析失败: ${doc.error}\n`)
        continue
      }
      
      parts.push(`[文档 ${i + 1}: ${doc.filename}]`)
      if (doc.pageCount) {
        parts.push(`(共 ${doc.pageCount} 页)`)
      }
      parts.push('\n')
      parts.push(doc.content)
      parts.push('\n')
      
      if (i < docs.length - 1) {
        parts.push('\n---\n\n')
      }
    }
    
    parts.push('\n=== 文档内容结束 ===\n')
    
    return parts.join('')
  }

  /**
   * 获取支持的文件类型列表
   */
  getSupportedTypes(): { extension: string; description: string; available: boolean }[] {
    return [
      { extension: '.pdf', description: 'PDF 文档', available: !!this.PDFParser },
      { extension: '.docx', description: 'Word 文档 (2007+)', available: !!this.mammoth },
      { extension: '.doc', description: 'Word 文档 (97-2003)', available: !!this.WordExtractor },
      { extension: '.txt', description: '纯文本', available: true },
      { extension: '.md', description: 'Markdown', available: true },
      { extension: '.json', description: 'JSON', available: true },
      { extension: '.xml', description: 'XML', available: true },
      { extension: '.html', description: 'HTML', available: true },
      { extension: '.csv', description: 'CSV', available: true }
    ]
  }

  /**
   * 检查解析能力
   */
  async checkCapabilities(): Promise<{
    pdf: boolean
    docx: boolean
    doc: boolean
    text: boolean
  }> {
    await this.init()
    
    return {
      pdf: !!this.PDFParser,
      docx: !!this.mammoth,
      doc: !!this.WordExtractor,
      text: true
    }
  }
}

// 导出单例
let documentParserService: DocumentParserService | null = null

export function getDocumentParserService(): DocumentParserService {
  if (!documentParserService) {
    documentParserService = new DocumentParserService()
  }
  return documentParserService
}
