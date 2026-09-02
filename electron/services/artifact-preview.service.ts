/**
 * 产出物预览服务
 *
 * 两个职责：
 * 1. 预览重建 — 从历史/续聊恢复时按 filePath 重新生成预览 HTML（Word/Excel/md/html）
 * 2. webview 预览协议（sailfish-artifact://）— 为产出物面板的 <webview> 供给内容：
 *    - 主文档：渲染进程经 IPC 推送（sanitize/背景注入后的最终 HTML），主进程内存缓存
 *    - 相对资源（img/css/js）：受限映射到产出物 filePath 所在目录（防目录穿越）
 *    - 截图反馈：capturePage → 落盘 agent-workspace/scratch/feedback/（受既有过期清理管辖）
 *
 * URL 结构：sailfish-artifact://preview/<enc(tabId)>/<enc(artifactId)>/<...relPath>
 * （tabId/artifactId 各为一段 encodeURIComponent，artifactId 可能含斜杠如 file:/...）
 *
 * 不用 data: URL（大 HTML 超 URL 长度限制）与 file:// 直载（dev 模式 webSecurity
 * 拦截、且无法覆盖 PPT 这类"内容在内存、文件是 .pptx"的场景）的原因见 artifact/SPEC.md。
 */
import * as fs from 'fs'
import path from 'path'
import { pathToFileURL } from 'url'
import { app, ipcMain, net, protocol, shell, webContents } from 'electron'
import { ARTIFACT_PREVIEW_SCHEME } from '@shared/types'
import { createLogger } from '../utils/logger'
import { getScratchPath } from './agent/tools/file'
import {
  previewArtifactFromFile,
  tryPreviewArtifactFromFile
} from './artifact-file-preview'

export { previewArtifactFromFile, tryPreviewArtifactFromFile }

const log = createLogger('ArtifactPreview')

// ==================== sailfish-artifact:// webview 预览协议 ====================

interface PreviewEntry {
  /** sanitize 后的完整 HTML（主文档） */
  content: string
  /** 相对资源映射根（产出物 filePath 所在目录；纯内存产出物为 null） */
  baseDir: string | null
  updatedAt: number
}

/** key = `${tabId}/${artifactId}`（均为原始未编码值） */
const previewCache = new Map<string, PreviewEntry>()
/** 缓存上限：超出时淘汰最久未更新条目（面板单预览，正常工作集远小于此） */
const MAX_CACHE_ENTRIES = 20

function cacheKey(tabId: string, artifactId: string): string {
  return `${tabId}/${artifactId}`
}

/** app ready 前调用：注册特权 scheme（standard/secure 使其成为安全上下文，支持 fetch/流式） */
export function registerArtifactPreviewScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: ARTIFACT_PREVIEW_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true }
    }
  ])
}

function handlePreviewRequest(request: Request): Promise<Response> | Response {
  let url: URL
  try {
    url = new URL(request.url)
  } catch {
    return new Response('Bad request', { status: 400 })
  }
  if (url.host !== 'preview') {
    return new Response('Not found', { status: 404 })
  }
  // split 在 decode 前做：%2F 不会被误拆为路径分隔
  const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
  const [tabId, artifactId, ...rel] = segments
  if (!tabId || !artifactId) {
    return new Response('Not found', { status: 404 })
  }
  const entry = previewCache.get(cacheKey(tabId, artifactId))
  if (!entry) {
    return new Response('Not found', { status: 404 })
  }
  if (rel.length === 0) {
    return new Response(entry.content, {
      headers: { 'Content-Type': 'text/html; charset=utf-8' }
    })
  }
  // 相对资源：受限映射到产出物所在目录
  if (!entry.baseDir) {
    return new Response('Not found', { status: 404 })
  }
  // 两侧统一 normalize 后再比较，避免 baseDir 尾部分隔符/跨平台分隔符差异导致误判
  const baseDir = path.normalize(entry.baseDir)
  const filePath = path.normalize(path.join(baseDir, ...rel))
  if (!filePath.startsWith(baseDir + path.sep)) {
    return new Response('Forbidden', { status: 403 })
  }
  return net.fetch(pathToFileURL(filePath).href)
}

/**
 * 相对资源映射根由主进程从 artifactId（file:<绝对路径>）推导，
 * 不信任渲染进程传入的目录，防止被覆写为敏感目录后借相对资源读取任意文件。
 */
function resolveBaseDirFromArtifactId(artifactId: string): string | null {
  if (!artifactId.startsWith('file:')) {
    return null
  }
  const dir = path.dirname(artifactId.slice(5))
  return dir === '.' || dir === '' ? null : dir
}

function syncPreview(payload: unknown): void {
  const p = payload as { tabId?: unknown; artifactId?: unknown; content?: unknown }
  if (typeof p?.tabId !== 'string' || typeof p?.artifactId !== 'string' || typeof p?.content !== 'string') {
    return
  }
  const key = cacheKey(p.tabId, p.artifactId)
  previewCache.set(key, {
    content: p.content,
    baseDir: resolveBaseDirFromArtifactId(p.artifactId),
    updatedAt: Date.now()
  })
  // LRU 淘汰
  if (previewCache.size > MAX_CACHE_ENTRIES) {
    let oldestKey: string | null = null
    let oldestAt = Infinity
    for (const [k, v] of previewCache) {
      if (v.updatedAt < oldestAt) {
        oldestAt = v.updatedAt
        oldestKey = k
      }
    }
    if (oldestKey) previewCache.delete(oldestKey)
  }
}

function clearPreview(payload: unknown): void {
  const p = payload as { tabId?: unknown; artifactId?: unknown }
  if (typeof p?.tabId !== 'string') return
  if (typeof p.artifactId === 'string') {
    previewCache.delete(cacheKey(p.tabId, p.artifactId))
    return
  }
  // 未指定 artifactId：清该 tab 全部（tab 关闭场景）
  const prefix = `${p.tabId}/`
  for (const key of previewCache.keys()) {
    if (key.startsWith(prefix)) previewCache.delete(key)
  }
}

/** 截图反馈：截取 webview 渲染结果，PNG 落盘 scratch/feedback/ 并返回 dataUrl（供 Composer 图片附件） */
async function capturePreview(payload: unknown): Promise<{
  success: boolean
  data?: { filePath: string; dataUrl: string; width: number; height: number }
  error?: string
}> {
  const p = payload as { webContentsId?: unknown; suggestedName?: unknown }
  if (typeof p?.webContentsId !== 'number') {
    return { success: false, error: 'webContentsId required' }
  }
  const wc = webContents.fromId(p.webContentsId)
  if (!wc || wc.isDestroyed()) {
    return { success: false, error: 'target webContents not found' }
  }
  try {
    const image = await wc.capturePage()
    const png = image.toPNG()
    if (!png.length) {
      return { success: false, error: 'empty capture' }
    }
    const dir = path.join(getScratchPath(), 'feedback')
    await fs.promises.mkdir(dir, { recursive: true })
    const safeName = typeof p.suggestedName === 'string' && p.suggestedName
      ? p.suggestedName.replace(/[^\w.-]+/g, '-').slice(0, 60)
      : 'artifact'
    const filePath = path.join(dir, `${safeName}-${Date.now()}.png`)
    await fs.promises.writeFile(filePath, png)
    const { width, height } = image.getSize()
    return { success: true, data: { filePath, dataUrl: image.toDataURL(), width, height } }
  } catch (err) {
    if (wc.isDestroyed()) {
      return { success: false, error: 'preview closed during capture' }
    }
    log.error('capturePreview failed:', err)
    return { success: false, error: err instanceof Error ? err.message : 'capture failed' }
  }
}

/** app ready 后调用：注册协议 handler 与 IPC */
export function initArtifactPreviewService(): void {
  protocol.handle(ARTIFACT_PREVIEW_SCHEME, (request) => handlePreviewRequest(request))
  // sync 用 invoke/handle：渲染进程 await 确认缓存就绪后再加载 webview，消除与协议请求的竞态
  ipcMain.handle('artifact-preview:sync', (_e, payload) => {
    syncPreview(payload)
    return { success: true }
  })
  ipcMain.on('artifact-preview:clear', (_e, payload) => clearPreview(payload))
  ipcMain.handle('artifact-preview:capture', (_e, payload) => capturePreview(payload))

  // webview guest 的 window.open / target=_blank：一律转系统浏览器（webview 已无 new-window 事件，
  // 只能在此统一设 handler）。仅放行 http/https，其余协议（含 file:）拒绝。
  app.on('web-contents-created', (_e, contents) => {
    if (contents.getType() !== 'webview') return
    contents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) {
        void shell.openExternal(url)
      }
      return { action: 'deny' }
    })
  })
  log.info(`Artifact preview service ready (${ARTIFACT_PREVIEW_SCHEME}://)`)
}

/** 测试用：清缓存 */
export function resetArtifactPreviewCacheForTest(): void {
  previewCache.clear()
}
