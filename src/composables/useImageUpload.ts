/**
 * 图片上传 composable
 * 处理图片拖拽、选择和管理（粘贴分类见 useComposerPaste）
 * 将图片转为 base64 data URL 发送给 AI 用于视觉理解；
 * 没有磁盘路径的图落到历史目录，带上路径发给 Agent。
 */
import { ref, type Ref } from 'vue'
import type { AttachmentInfo } from '@shared/types'

// 支持的图片 MIME 类型（可直接作为视觉输入传给 AI）
export const SUPPORTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp']

// 限制配置
const IMAGE_LIMITS = {
  MAX_COUNT: 5,           // 最多同时上传 5 张图片
  MAX_SIZE_MB: 5,         // 单张图片最大 5MB（兼容 Anthropic 等 API 的请求体限制）
}

export interface PendingImage {
  id: string
  dataUrl: string      // base64 data URL
  name: string         // 文件名
  size: number         // 原始文件大小（字节）
  width?: number       // 图片宽度
  height?: number      // 图片高度
  /** 磁盘路径：本机文件用原路径，粘贴图落到历史目录 */
  filePath?: string
  /** 路径是这次粘贴落盘的，点掉未发送的预览时应删掉 */
  savedByApp?: boolean
}

/**
 * 将 File 对象转为 base64 data URL（不做缩放，保留原始质量）
 * AI API 会自行处理图片尺寸，客户端预压缩只会损失质量
 */
async function fileToDataUrl(file: File): Promise<{ dataUrl: string; width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = reader.result as string
      const img = new Image()
      img.onload = () => resolve({ dataUrl, width: img.width, height: img.height })
      img.onerror = () => resolve({ dataUrl, width: 0, height: 0 })
      img.src = dataUrl
    }
    reader.onerror = () => reject(new Error('Failed to read file'))
    reader.readAsDataURL(file)
  })
}

/**
 * 检查文件是否为支持的图片类型
 */
function isSupportedImage(file: File): boolean {
  return SUPPORTED_IMAGE_TYPES.includes(file.type)
}

function tryGetLocalPath(file: File): string | undefined {
  try {
    const p = window.electronAPI?.fileUtils?.getPathForFile?.(file)
    if (typeof p === 'string' && p.trim()) return p
  } catch {
    // 剪贴板 File 没有真实路径
  }
  const legacy = (file as File & { path?: string }).path
  return legacy && legacy.trim() ? legacy : undefined
}

async function persistIfNeeded(
  dataUrl: string,
  name: string,
  existingPath?: string,
): Promise<{ filePath?: string; savedByApp: boolean }> {
  if (existingPath) return { filePath: existingPath, savedByApp: false }
  const api = window.electronAPI?.workspace?.savePastedImage
  if (!api) return { savedByApp: false }
  try {
    const res = await api(dataUrl, name)
    if (res.success && res.filePath) return { filePath: res.filePath, savedByApp: true }
    console.warn('persist pasted image failed', res.error)
    return { savedByApp: false }
  } catch (error) {
    console.warn('persist pasted image failed', error)
    return { savedByApp: false }
  }
}

function extFromPath(p: string): string {
  const base = p.split(/[\\/]/).pop() || p
  const dot = base.lastIndexOf('.')
  if (dot <= 0 || dot === base.length - 1) return ''
  return base.slice(dot + 1).toLowerCase()
}

function discardSavedPastedImage(img?: PendingImage) {
  if (!img?.savedByApp || !img.filePath) return
  void window.electronAPI?.workspace?.deletePastedImage?.(img.filePath)
}

export function pendingImageToAttachment(img: PendingImage): AttachmentInfo | null {
  if (!img.filePath) return null
  const ext = extFromPath(img.filePath) || extFromPath(img.name) || 'png'
  const filename = extFromPath(img.name)
    ? img.name
    : (img.filePath.split(/[\\/]/).pop() || `image.${ext}`)
  return {
    filename,
    filePath: img.filePath,
    fileSize: img.size,
    fileType: ext,
  }
}

export function useImageUpload() {
  // 待发送的图片列表
  const pendingImages: Ref<PendingImage[]> = ref([])
  
  // 是否正在处理图片
  const isProcessingImage = ref(false)
  
  /**
   * 添加图片文件
   */
  const addImageFile = async (file: File): Promise<boolean> => {
    // 检查是否为支持的图片类型
    if (!isSupportedImage(file)) {
      console.warn(`不支持的图片类型: ${file.type}`)
      return false
    }
    
    // 检查数量限制
    if (pendingImages.value.length >= IMAGE_LIMITS.MAX_COUNT) {
      console.warn(`图片数量已达上限 (${IMAGE_LIMITS.MAX_COUNT})`)
      return false
    }
    
    // 检查文件大小
    if (file.size > IMAGE_LIMITS.MAX_SIZE_MB * 1024 * 1024) {
      console.warn(`图片文件过大: ${(file.size / 1024 / 1024).toFixed(1)}MB，上限 ${IMAGE_LIMITS.MAX_SIZE_MB}MB`)
      return false
    }
    
    try {
      isProcessingImage.value = true
      const { dataUrl, width, height } = await fileToDataUrl(file)
      const saved = await persistIfNeeded(dataUrl, file.name || 'pasted-image', tryGetLocalPath(file))
      
      pendingImages.value.push({
        id: `img_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
        dataUrl,
        name: file.name || 'pasted-image',
        size: file.size,
        width,
        height,
        filePath: saved.filePath,
        savedByApp: saved.savedByApp,
      })
      
      return true
    } catch (error) {
      console.error('处理图片失败:', error)
      return false
    } finally {
      isProcessingImage.value = false
    }
  }
  
  /**
   * 直接添加 data URL 图片（产出物截图反馈等场景，无 File 对象）
   */
  const addImageDataUrl = async (
    dataUrl: string,
    name: string,
    width = 0,
    height = 0,
    filePath?: string,
  ): Promise<boolean> => {
    if (pendingImages.value.length >= IMAGE_LIMITS.MAX_COUNT) {
      console.warn(`图片数量已达上限 (${IMAGE_LIMITS.MAX_COUNT})`)
      return false
    }
    // dataUrl 形态：data:image/png;base64,xxxx —— 体积约为原始二进制的 4/3
    const approxSize = Math.floor(dataUrl.length * 0.75)
    if (approxSize > IMAGE_LIMITS.MAX_SIZE_MB * 1024 * 1024) {
      console.warn(`图片过大: 约 ${(approxSize / 1024 / 1024).toFixed(1)}MB，上限 ${IMAGE_LIMITS.MAX_SIZE_MB}MB`)
      return false
    }
    const saved = await persistIfNeeded(dataUrl, name, filePath)
    pendingImages.value.push({
      id: `img_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
      dataUrl,
      name,
      size: approxSize,
      width,
      height,
      filePath: saved.filePath,
      savedByApp: saved.savedByApp,
    })
    return true
  }

  /**
   * 处理拖拽的文件中的图片
   * 返回处理的图片数量
   */
  const handleDroppedImages = async (files: FileList | File[]): Promise<number> => {
    let count = 0
    for (const file of files) {
      if (isSupportedImage(file)) {
        const added = await addImageFile(file)
        if (added) count++
      }
    }
    return count
  }
  
  /**
   * 移除指定图片
   */
  const removeImage = (id: string) => {
    const index = pendingImages.value.findIndex(img => img.id === id)
    if (index < 0) return
    const [removed] = pendingImages.value.splice(index, 1)
    discardSavedPastedImage(removed)
  }
  
  /**
   * 清空所有待发送图片（发送后用：文件已交给对话，不要删）
   */
  const clearImages = () => {
    pendingImages.value = []
  }

  /** 丢掉未发送的预览：只删我们落下的文件，不动用户本机图 */
  const discardImages = () => {
    for (const img of pendingImages.value) {
      discardSavedPastedImage(img)
    }
    pendingImages.value = []
  }

  /** 从欢迎页等外部暂存恢复待发送图片（进入助手 tab 前 handoff） */
  const loadPendingImages = (images: PendingImage[]) => {
    pendingImages.value = images.map(img => ({ ...img }))
  }

  /** 发送前补落盘：编辑填回等场景可能只有 dataUrl */
  const ensurePendingImagePaths = async () => {
    for (const img of pendingImages.value) {
      if (img.filePath) continue
      const saved = await persistIfNeeded(img.dataUrl, img.name)
      if (saved.filePath) {
        img.filePath = saved.filePath
        if (saved.savedByApp) img.savedByApp = true
      }
    }
  }

  const getImageAttachments = (): AttachmentInfo[] => {
    return pendingImages.value
      .map(pendingImageToAttachment)
      .filter((a): a is AttachmentInfo => a !== null)
  }
  
  /**
   * 获取所有待发送图片的 data URL 列表
   */
  const getImageDataUrls = (): string[] => {
    return pendingImages.value.map(img => img.dataUrl)
  }
  
  /**
   * 是否有待发送的图片
   */
  const hasImages = (): boolean => {
    return pendingImages.value.length > 0
  }
  
  /**
   * 检查是否还能添加更多图片
   */
  const canAddMore = (): boolean => {
    return pendingImages.value.length < IMAGE_LIMITS.MAX_COUNT
  }
  
  /**
   * 通过文件选择器选择图片
   */
  const selectImages = () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = SUPPORTED_IMAGE_TYPES.join(',')
    input.multiple = true
    input.onchange = async () => {
      if (input.files) {
        for (const file of input.files) {
          await addImageFile(file)
        }
      }
    }
    input.click()
  }
  
  return {
    pendingImages,
    isProcessingImage,
    addImageFile,
    addImageDataUrl,
    handleDroppedImages,
    removeImage,
    clearImages,
    discardImages,
    loadPendingImages,
    ensurePendingImagePaths,
    getImageAttachments,
    getImageDataUrls,
    hasImages,
    canAddMore,
    selectImages,
    IMAGE_LIMITS
  }
}
