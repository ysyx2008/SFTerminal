/**
 * 文档上传 composable
 * 处理文档选择、解析和管理
 */
import { ref } from 'vue'

// 文档类型定义
export interface ParsedDocument {
  filename: string
  fileType: string
  content: string
  fileSize: number
  parseTime: number
  pageCount?: number
  metadata?: Record<string, string>
  error?: string
}

// 支持的文件扩展名
const SUPPORTED_EXTENSIONS = ['.pdf', '.doc', '.docx', '.txt', '.md', '.json', '.xml', '.csv', '.html', '.htm']

export function useDocumentUpload() {
  // 已上传的文档列表
  const uploadedDocs = ref<ParsedDocument[]>([])
  // 上传中状态
  const isUploadingDocs = ref(false)
  // 拖放悬停状态
  const isDraggingOver = ref(false)

  // 检查文件是否支持
  const isSupportedFile = (filename: string): boolean => {
    const ext = filename.toLowerCase().slice(filename.lastIndexOf('.'))
    return SUPPORTED_EXTENSIONS.includes(ext)
  }

  // 选择并上传文档
  const selectAndUploadDocs = async () => {
    if (isUploadingDocs.value) return
    
    try {
      isUploadingDocs.value = true
      
      // 选择文件
      const documentAPI = (window.electronAPI as { document: typeof window.electronAPI.document }).document
      const { canceled, files } = await documentAPI.selectFiles()
      if (canceled || files.length === 0) {
        isUploadingDocs.value = false
        return
      }
      
      // 解析文档
      const parsedDocs = await documentAPI.parseMultiple(files)
      
      // 添加到已上传列表（追加而非替换）
      uploadedDocs.value = [...uploadedDocs.value, ...parsedDocs]
      
      // 显示解析结果摘要
      const successCount = parsedDocs.filter((d: ParsedDocument) => !d.error).length
      const errorCount = parsedDocs.filter((d: ParsedDocument) => d.error).length
      
      if (errorCount > 0) {
        console.warn(`文档解析: ${successCount} 成功, ${errorCount} 失败`)
      }
    } catch (error) {
      console.error('上传文档失败:', error)
    } finally {
      isUploadingDocs.value = false
    }
  }

  // 处理拖放的文件
  const handleDroppedFiles = async (files: FileList | File[]) => {
    if (isUploadingDocs.value) return
    
    // 过滤支持的文件并构造文件信息对象
    const fileInfos: Array<{ name: string; path: string; size: number; mimeType?: string }> = []
    for (const file of files) {
      if (isSupportedFile(file.name)) {
        // Electron 中的 File 对象有 path 属性
        const filePath = (file as File & { path?: string }).path
        if (filePath) {
          fileInfos.push({
            name: file.name,
            path: filePath,
            size: file.size,
            mimeType: file.type || undefined
          })
        }
      }
    }
    
    if (fileInfos.length === 0) {
      console.warn('没有支持的文件类型')
      return
    }
    
    try {
      isUploadingDocs.value = true
      
      // 解析文档
      const documentAPI = (window.electronAPI as { document: typeof window.electronAPI.document }).document
      const parsedDocs = await documentAPI.parseMultiple(fileInfos)
      
      // 添加到已上传列表
      uploadedDocs.value = [...uploadedDocs.value, ...parsedDocs]
      
      // 显示解析结果摘要
      const successCount = parsedDocs.filter((d: ParsedDocument) => !d.error).length
      const errorCount = parsedDocs.filter((d: ParsedDocument) => d.error).length
      
      if (errorCount > 0) {
        console.warn(`文档解析: ${successCount} 成功, ${errorCount} 失败`)
      }
    } catch (error) {
      console.error('处理拖放文档失败:', error)
    } finally {
      isUploadingDocs.value = false
    }
  }

  // 移除已上传的文档
  const removeUploadedDoc = (index: number) => {
    uploadedDocs.value.splice(index, 1)
  }

  // 清空所有上传的文档
  const clearUploadedDocs = () => {
    uploadedDocs.value = []
  }

  // 格式化文件大小
  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }

  // 获取文档上下文（用于发送给 AI）
  const getDocumentContext = async (): Promise<string> => {
    const validDocs = uploadedDocs.value.filter(d => !d.error && d.content)
    if (validDocs.length === 0) return ''
    
    // 将 Vue Proxy 对象转换为普通对象，避免 IPC 序列化错误
    const plainDocs = JSON.parse(JSON.stringify(validDocs))
    
    const documentAPI = (window.electronAPI as { document: typeof window.electronAPI.document }).document
    return await documentAPI.formatAsContext(plainDocs)
  }

  return {
    uploadedDocs,
    isUploadingDocs,
    isDraggingOver,
    selectAndUploadDocs,
    handleDroppedFiles,
    removeUploadedDoc,
    clearUploadedDocs,
    formatFileSize,
    getDocumentContext
  }
}
