# 文档解析服务集成说明

本服务用于解析用户上传的文档（PDF、Word、文本等），提取文本内容作为 AI 对话的上下文。

## 1. 安装依赖

需要在 `package.json` 的 `dependencies` 中添加：

```json
{
  "dependencies": {
    "pdfjs-dist": "^4.x",
    "mammoth": "^1.8.0",
    "word-extractor": "^1.0.4"
  }
}
```

然后运行：

```bash
npm install pdfjs-dist mammoth word-extractor
```

## 2. 在 main.ts 中添加 IPC 处理器

在 `electron/main.ts` 文件的适当位置添加以下代码：

```typescript
// 导入文档解析服务
import { getDocumentParserService, UploadedFile, ParseOptions } from './services/document-parser.service'

// 获取服务实例
const documentParserService = getDocumentParserService()

// ==================== 文档解析相关 ====================

// 选择文件对话框
ipcMain.handle('document:selectFiles', async () => {
  const result = await dialog.showOpenDialog({
    title: '选择文档',
    filters: [
      { name: '支持的文档', extensions: ['pdf', 'docx', 'doc', 'txt', 'md', 'json', 'xml', 'html', 'csv'] },
      { name: 'PDF 文档', extensions: ['pdf'] },
      { name: 'Word 文档', extensions: ['docx', 'doc'] },
      { name: '文本文件', extensions: ['txt', 'md'] },
      { name: '所有文件', extensions: ['*'] }
    ],
    properties: ['openFile', 'multiSelections']
  })
  
  if (result.canceled || result.filePaths.length === 0) {
    return { canceled: true, files: [] }
  }
  
  // 获取文件信息
  const files: UploadedFile[] = result.filePaths.map(filePath => {
    const stats = fs.statSync(filePath)
    return {
      name: path.basename(filePath),
      path: filePath,
      size: stats.size
    }
  })
  
  return { canceled: false, files }
})

// 解析单个文档
ipcMain.handle('document:parse', async (_event, file: UploadedFile, options?: ParseOptions) => {
  return documentParserService.parseDocument(file, options)
})

// 批量解析文档
ipcMain.handle('document:parseMultiple', async (_event, files: UploadedFile[], options?: ParseOptions) => {
  return documentParserService.parseDocuments(files, options)
})

// 格式化为 AI 上下文
ipcMain.handle('document:formatAsContext', async (_event, docs) => {
  return documentParserService.formatAsContext(docs)
})

// 生成文档摘要
ipcMain.handle('document:generateSummary', async (_event, doc) => {
  return documentParserService.generateSummary(doc)
})

// 检查解析能力
ipcMain.handle('document:checkCapabilities', async () => {
  return documentParserService.checkCapabilities()
})

// 获取支持的文件类型
ipcMain.handle('document:getSupportedTypes', async () => {
  return documentParserService.getSupportedTypes()
})
```

注意：需要在文件顶部添加 `import * as fs from 'fs'`（如果尚未导入）。

## 3. 在 preload.ts 中添加 API

在 `electron/preload.ts` 的 `electronAPI` 对象中添加：

```typescript
// 文档解析操作
document: {
  // 选择文件
  selectFiles: () => ipcRenderer.invoke('document:selectFiles') as Promise<{
    canceled: boolean
    files: Array<{
      name: string
      path: string
      size: number
    }>
  }>,

  // 解析单个文档
  parse: (file: {
    name: string
    path: string
    size: number
    mimeType?: string
  }, options?: {
    maxFileSize?: number
    maxTextLength?: number
    extractMetadata?: boolean
  }) => ipcRenderer.invoke('document:parse', file, options) as Promise<{
    filename: string
    fileType: string
    content: string
    fileSize: number
    parseTime: number
    pageCount?: number
    metadata?: Record<string, string>
    error?: string
  }>,

  // 批量解析文档
  parseMultiple: (files: Array<{
    name: string
    path: string
    size: number
    mimeType?: string
  }>, options?: {
    maxFileSize?: number
    maxTextLength?: number
    extractMetadata?: boolean
  }) => ipcRenderer.invoke('document:parseMultiple', files, options) as Promise<Array<{
    filename: string
    fileType: string
    content: string
    fileSize: number
    parseTime: number
    pageCount?: number
    metadata?: Record<string, string>
    error?: string
  }>>,

  // 格式化为 AI 上下文
  formatAsContext: (docs: Array<{
    filename: string
    fileType: string
    content: string
    fileSize: number
    parseTime: number
    pageCount?: number
    metadata?: Record<string, string>
    error?: string
  }>) => ipcRenderer.invoke('document:formatAsContext', docs) as Promise<string>,

  // 生成文档摘要
  generateSummary: (doc: {
    filename: string
    fileType: string
    content: string
    fileSize: number
    parseTime: number
    pageCount?: number
    error?: string
  }) => ipcRenderer.invoke('document:generateSummary', doc) as Promise<string>,

  // 检查解析能力
  checkCapabilities: () => ipcRenderer.invoke('document:checkCapabilities') as Promise<{
    pdf: boolean
    docx: boolean
    doc: boolean
    text: boolean
  }>,

  // 获取支持的文件类型
  getSupportedTypes: () => ipcRenderer.invoke('document:getSupportedTypes') as Promise<Array<{
    extension: string
    description: string
    available: boolean
  }>>
}
```

## 4. 前端使用示例

### 选择并解析文档

```typescript
async function uploadDocuments() {
  // 选择文件
  const { canceled, files } = await window.electronAPI.document.selectFiles()
  if (canceled || files.length === 0) return

  // 解析文件
  const parsedDocs = await window.electronAPI.document.parseMultiple(files)
  
  // 格式化为 AI 上下文
  const context = await window.electronAPI.document.formatAsContext(parsedDocs)
  
  // 将 context 添加到对话中...
}
```

### 检查支持的类型

```typescript
async function checkSupport() {
  const capabilities = await window.electronAPI.document.checkCapabilities()
  console.log('PDF 支持:', capabilities.pdf)
  console.log('Word 支持:', capabilities.docx)
  console.log('文本支持:', capabilities.text)
}
```

## 5. 在 AI 对话中使用文档上下文

推荐在用户消息中包含文档内容：

```typescript
// 假设 parsedDocs 是解析后的文档数组
const documentContext = await window.electronAPI.document.formatAsContext(parsedDocs)

// 构建用户消息
const userMessage = {
  role: 'user',
  content: `${documentContext}\n\n用户问题: ${userInput}`
}

// 或者作为系统消息的一部分
const systemPrompt = `你是一个专业的助手。以下是用户提供的参考文档：\n\n${documentContext}\n\n请根据文档内容回答用户的问题。`
```

## 6. 支持的文件格式

| 格式 | 扩展名 | 依赖 | 说明 |
|------|--------|------|------|
| PDF | .pdf | pdfjs-dist | 完整支持（逐页提取，大文件友好） |
| Word (新) | .docx | mammoth | 完整支持 |
| Word (旧) | .doc | word-extractor | 完整支持 |
| 纯文本 | .txt | 内置 | 完整支持 |
| Markdown | .md | 内置 | 完整支持 |
| JSON | .json | 内置 | 完整支持 |
| XML | .xml | 内置 | 完整支持 |
| HTML | .html | 内置 | 完整支持 |
| CSV | .csv | 内置 | 完整支持 |

## 7. 配置选项

```typescript
interface ParseOptions {
  // 最大文件大小（字节），默认 10MB
  maxFileSize?: number
  
  // 最大提取文本长度（字符），默认 100000
  maxTextLength?: number
  
  // 是否提取元数据，默认 true
  extractMetadata?: boolean
}
```

## 8. 注意事项

1. **大文件处理**: 默认限制 10MB，可通过 `maxFileSize` 调整。超过限制时**不会抛出异常**，而是优雅降级：`content` 字段返回结构化说明文字，`skipped` 字段设为 `true`，供调用方（Agent）区分"解析出错"和"主动跳过"
2. **编码问题**: 文本文件默认使用 UTF-8 编码
3. **旧版 Word**: .doc 格式暂不支持，建议用户转换为 .docx
4. **依赖安装**: PDF 和 Word 解析需要安装对应的 npm 包
