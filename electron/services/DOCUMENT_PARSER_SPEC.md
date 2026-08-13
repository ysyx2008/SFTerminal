# Document Parser Service SPEC

> Last verified: 2026-08-13

## 职责

本地文档解析引擎。将 PDF、DOCX、XLSX、CSV 等常用格式转为 Markdown 文本，供 Agent 引用分析。支持 PDF Worker 子进程解析和 Direct 解析双模式，PDF 可渲染为图片供视觉模型使用。

## 设计目标

### 抽给视觉模型的图必须是视觉模型能看的格式

Word 里经常嵌着 EMF/WMF 这类图表，视觉模型直接吃会报错。抽图时，已经是 png / jpeg / gif / webp / bmp 的原样保留（jpeg 不必转 png）；其余格式优先转成 png。转不了的才丢掉，正文照常给 AI。

### Office 矢量图没有有效画面就丢掉

Word 里的架构图常常是 EMF/WMF：真正的画面是矢量画出来的，文件里往往只有一张几乎空白的底图，再加几枚小图标。空白底图和小碎片不要发给视觉模型，缩略图也不要显示灰块。已经是正常照片或截图的（包括被包进 EMF 里的）照旧用。不为这类图去启动 Word，也不整篇转 PDF 再截页面。

## 文件 / 规模

单文件：`electron/services/document-parser.service.ts`（~1305 行）

## 公开 API

| 方法签名 | 用途 | 主要调用方 |
|---------|------|-----------|
| `detectFileType(filename, mimeType?): DocumentType` | 根据文件名/类型推断文档格式 | agent/tools |
| `async parseDocument(file, options?): Promise<ParsedDocument>` | 解析单个文件为文本 | agent/tools |
| `async parseDocuments(files, options?): Promise<ParsedDocument[]>` | 批量解析（含进度回调） | agent/tools |
| `destroyPdfWorker(): void` | 终止 PDF Worker 子进程 | 生命周期管理 |
| `generateSummary(doc): string` | 生成单文档人类可读摘要 | agent 上下文 |
| `formatAsContext(docs): string` | 多文档格式化为 AI 上下文块 | agent 上下文 |
| `getSupportedTypes(): {extension, description, available}[]` | 返回支持的格式列表及可用性 | UI/工具发现 |
| `async checkCapabilities(): Promise<{pdf, docx, doc, xlsx, ...}>` | 检测各格式当前是否可解析 | 启动诊断 |
| `async renderPdfPages(filePath, pageNumbers, options?, onPage?): Promise<{images[], totalPages}>` | PDF 页面渲染为图片（base64） | 视觉模型 |

## 核心类型 / 接口

```ts
interface ParsedDocument {
  filename: string; filePath?: string; fileType: DocumentType
  content: string; fileSize: number; parseTime: number
  pageCount?: number; totalPages?: number
  images?: string[]; metadata?: Record<string, string>
  error?: string
}
interface UploadedFile { name: string; path: string; size: number; mimeType?: string }
interface ParseOptions {
  maxFileSize?: number; maxTextLength?: number
  extractMetadata?: boolean; extractImages?: boolean; requestId?: string
}
interface PdfRenderOptions { dpi?: number; quality?: number }
type DocumentType = "pdf" | "docx" | "doc" | "xlsx" | "xls" | "txt" | "md" | "json" | "xml" | "html" | "csv" | "unknown"
```

## 依赖（跨 service）

无。完全自包含，通过 `mammoth`、`exceljs`、`pdfjs-dist`、`word-extractor` 等 npm 包直接解析。

## 关键行为 / 数据流

**双解析模式**：
- **PDF Worker 模式**（默认）：fork 子进程批量处理，支持进度回传，适合多文件
- **PDF Direct 模式**：主进程内 pdfjs-dist 直接解析，适合单文件/轻量场景

**格式路由**：`detectFileType` → 按扩展名 → 调用对应解析器（`parsePdf` / `parseDocx` / `parseExcel` / `parseTextFile` / `parseCsv`）

**图片提取**：DOCX 支持内嵌图片提取（`parseDocxWithImages`），PDF 通过 `renderPdfPages` 渲染

**PDF 字体 / CMap**：`getDocument` 统一经 `pdfjs-config.mjs` 注入 `cMapUrl`、`standardFontDataUrl`，Node 环境设 `disableFontFace: true`、`useSystemFonts: false`。缺 CMap 时 CJK 页面渲染会出现方框（tofu）。

## 关键约束

- **PDF Worker 子进程必须可终止**——`destroyPdfWorker()` 须在服务销毁时调用
- **大文件限制**：`MAX_RENDER_PAGES` + `MAX_PDF_FILE_SIZE` 硬限制，不得移除
- **解析失败不抛异常**——返回 `ParsedDocument.error` 字段，调用方自行判断
- **二进制检测在文本解析前**——`isLikelyBinary()` 先于 `parseTextFile()`，防止大二进制文件当文本读爆内存
