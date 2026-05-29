/**
 * 数据目录引导（bootstrap）
 *
 * 必须作为 main.ts 的**第一个 import**，以便在任何 service 实例化之前完成
 * `app.setPath('userData', ...)` 的重定向。
 *
 * 设计：
 * - 在**默认** userData 目录下放一个极小的指针文件 `data-location.json`，
 *   记录用户自定义的数据目录。指针文件本身永远留在默认位置，体积极小，
 *   不随数据迁移移动，避免“先有鸡还是先有蛋”的问题。
 * - 模块被 import 时（require 期，早于服务构造）立即执行 {@link applyDataDirRedirect}：
 *   先处理上一轮迁移遗留的旧目录清理，再按指针把 userData 重定向到自定义目录。
 * - 真正的数据迁移采用“重启时迁移”：在干净的启动早期（没有任何 agent/watch/sensor
 *   在运行、源目录无写入）复制数据并展示进度窗，复制完成后重启。详见
 *   {@link runStartupMigrationIfNeeded}。
 */
import { app, BrowserWindow } from 'electron'
import * as fs from 'fs'
import * as path from 'path'

/** 指针文件名（始终位于默认 userData 目录下） */
const POINTER_FILENAME = 'data-location.json'

/** 默认 userData 目录：必须在任何 setPath 之前捕获 */
const DEFAULT_USERDATA = app.getPath('userData')

/** 指针文件绝对路径（恒定在默认目录） */
const POINTER_PATH = path.join(DEFAULT_USERDATA, POINTER_FILENAME)

interface DataLocationPointer {
  /** 当前生效的自定义数据目录；缺省表示使用默认目录 */
  dataDir?: string
  /** 待执行的迁移目标目录（下次启动早期执行复制） */
  pendingMigration?: { target: string }
  /** 待清理的旧目录（迁移成功后延迟到下次启动删除，规避文件锁） */
  cleanupDir?: string
  /** 上一次迁移失败的错误信息（供前端读取后展示并清除） */
  lastError?: string
}

function readPointer(): DataLocationPointer {
  try {
    if (!fs.existsSync(POINTER_PATH)) return {}
    const raw = fs.readFileSync(POINTER_PATH, 'utf-8')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writePointer(pointer: DataLocationPointer): void {
  try {
    fs.mkdirSync(DEFAULT_USERDATA, { recursive: true })
    // 去掉空字段，保持文件干净
    const clean: DataLocationPointer = {}
    if (pointer.dataDir) clean.dataDir = pointer.dataDir
    if (pointer.pendingMigration) clean.pendingMigration = pointer.pendingMigration
    if (pointer.cleanupDir) clean.cleanupDir = pointer.cleanupDir
    if (pointer.lastError) clean.lastError = pointer.lastError
    fs.writeFileSync(POINTER_PATH, JSON.stringify(clean, null, 2), 'utf-8')
  } catch (e) {
    console.error('[bootstrap] 写入数据目录指针失败:', e)
  }
}

function samePath(a: string, b: string): boolean {
  return path.resolve(a) === path.resolve(b)
}

/** 判断 child 是否在 parent 目录内部（含相等以外的嵌套） */
function isInside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child))
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/**
 * 删除旧目录数据。若旧目录就是默认目录，则保留指针文件本身。
 */
function cleanupOldDir(dir: string): void {
  try {
    if (!fs.existsSync(dir)) return
    if (samePath(dir, DEFAULT_USERDATA)) {
      // 默认目录：逐项删除，保留指针文件
      for (const entry of fs.readdirSync(dir)) {
        if (entry === POINTER_FILENAME) continue
        fs.rmSync(path.join(dir, entry), { recursive: true, force: true })
      }
    } else {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  } catch (e) {
    console.error('[bootstrap] 清理旧数据目录失败:', e)
  }
}

/**
 * require 期立即执行：处理旧目录清理 + 应用 userData 重定向。
 * 注意：pendingMigration 不在此处理（需等 app ready 才能建进度窗），
 * 仅在此确保 source（当前生效目录）已正确指向。
 */
function applyDataDirRedirect(): void {
  let pointer = readPointer()

  // 1. 处理上一轮迁移遗留的旧目录清理（此时尚无 service 打开旧文件）
  if (pointer.cleanupDir) {
    const toClean = pointer.cleanupDir
    // 安全检查：不清理当前生效目录
    const active = pointer.dataDir || DEFAULT_USERDATA
    if (!samePath(toClean, active)) {
      cleanupOldDir(toClean)
    }
    pointer = { ...pointer, cleanupDir: undefined }
    writePointer(pointer)
  }

  // 2. 应用自定义目录重定向（pending 时也要指向当前生效目录，作为迁移源）
  if (pointer.dataDir && !samePath(pointer.dataDir, DEFAULT_USERDATA)) {
    try {
      fs.mkdirSync(pointer.dataDir, { recursive: true })
      app.setPath('userData', pointer.dataDir)
    } catch (e) {
      console.error('[bootstrap] 重定向 userData 失败，回退默认目录:', e)
    }
  }
}

// ==================== 立即执行（模块副作用） ====================
applyDataDirRedirect()

// ==================== 对外查询/操作 API ====================

export interface DataDirInfo {
  /** 当前生效的数据目录 */
  current: string
  /** 默认数据目录 */
  default: string
  /** 是否使用了自定义目录 */
  isCustom: boolean
  /** 上一次迁移失败信息（读取后即清除） */
  lastError?: string
}

/** 获取数据目录信息，并清除残留的 lastError */
export function getDataDirInfo(): DataDirInfo {
  const pointer = readPointer()
  const current = app.getPath('userData')
  const info: DataDirInfo = {
    current,
    default: DEFAULT_USERDATA,
    isCustom: !samePath(current, DEFAULT_USERDATA),
    lastError: pointer.lastError
  }
  if (pointer.lastError) {
    writePointer({ ...pointer, lastError: undefined })
  }
  return info
}

export interface MigrationRequestResult {
  ok: boolean
  error?: string
}

/**
 * 校验目标目录是否可作为迁移目的地。
 */
function validateTarget(target: string): MigrationRequestResult {
  if (!target || !path.isAbsolute(target)) {
    return { ok: false, error: 'invalid_path' }
  }
  const source = app.getPath('userData')
  if (samePath(target, source)) {
    return { ok: false, error: 'same_as_current' }
  }
  // 目标不能在源内部，源也不能在目标内部（否则复制/清理会自我吞噬）
  if (isInside(source, target) || isInside(target, source)) {
    return { ok: false, error: 'nested' }
  }
  // 可写性检查：尝试创建目录并写入探针
  try {
    fs.mkdirSync(target, { recursive: true })
    const probe = path.join(target, '.sft-write-probe')
    fs.writeFileSync(probe, '')
    fs.rmSync(probe, { force: true })
  } catch {
    return { ok: false, error: 'not_writable' }
  }
  return { ok: true }
}

/** 目标目录是否非空（用于前端提示混入风险） */
export function isTargetNonEmpty(target: string): boolean {
  try {
    return fs.existsSync(target) && fs.readdirSync(target).length > 0
  } catch {
    return false
  }
}

/**
 * 请求迁移到目标目录：仅校验并写入 pending 标记，由调用方触发重启。
 */
export function requestDataDirMigration(target: string): MigrationRequestResult {
  const result = validateTarget(target)
  if (!result.ok) return result
  const pointer = readPointer()
  writePointer({ ...pointer, pendingMigration: { target: path.resolve(target) } })
  return { ok: true }
}

/**
 * 请求恢复到默认数据目录。若当前已是默认目录则无需操作。
 */
export function requestDataDirReset(): MigrationRequestResult {
  const current = app.getPath('userData')
  if (samePath(current, DEFAULT_USERDATA)) {
    return { ok: false, error: 'already_default' }
  }
  const pointer = readPointer()
  writePointer({ ...pointer, pendingMigration: { target: DEFAULT_USERDATA } })
  return { ok: true }
}

/** 是否存在待执行的迁移 */
export function hasPendingMigration(): boolean {
  return !!readPointer().pendingMigration
}

// ==================== 迁移执行（进度窗 + 复制） ====================

interface FileEntry {
  abs: string
  rel: string
  size: number
}

/** 递归收集 source 下所有文件（排除指针文件与目标目录自身） */
function collectFiles(source: string, target: string): { files: FileEntry[]; totalBytes: number } {
  const files: FileEntry[] = []
  let totalBytes = 0
  const walk = (dir: string) => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name)
      // 跳过指针文件（仅顶层会出现）
      if (samePath(abs, POINTER_PATH)) continue
      // 跳过目标目录（理论上已校验非嵌套，双保险）
      if (samePath(abs, target)) continue
      if (entry.isSymbolicLink()) {
        // 符号链接按文件处理，复制链接指向的内容；失败则跳过
        try {
          const st = fs.statSync(abs)
          if (st.isDirectory()) { walk(abs); continue }
          files.push({ abs, rel: path.relative(source, abs), size: st.size })
          totalBytes += st.size
        } catch { /* 跳过失效链接 */ }
        continue
      }
      if (entry.isDirectory()) {
        walk(abs)
      } else if (entry.isFile()) {
        let size = 0
        try { size = fs.statSync(abs).size } catch { /* ignore */ }
        files.push({ abs, rel: path.relative(source, abs), size })
        totalBytes += size
      }
    }
  }
  walk(source)
  return { files, totalBytes }
}

function progressWindowHtml(): string {
  const zh = app.getLocale().toLowerCase().startsWith('zh')
  const title = zh ? '正在迁移数据…' : 'Migrating data…'
  const sub = zh ? '请勿关闭应用' : 'Please do not close the app'
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;height:100%;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
      background:#1e1e24;color:#e6e6ea;user-select:none;-webkit-user-select:none;overflow:hidden}
    .wrap{height:100%;display:flex;flex-direction:column;justify-content:center;padding:0 28px;box-sizing:border-box}
    .title{font-size:15px;font-weight:600;margin-bottom:4px}
    .sub{font-size:12px;color:#9a9aa5;margin-bottom:18px}
    .bar{height:8px;background:#34343c;border-radius:6px;overflow:hidden}
    .fill{height:100%;width:0;background:linear-gradient(90deg,#4f8cff,#a855f7);border-radius:6px;transition:width .15s ease}
    .meta{display:flex;justify-content:space-between;margin-top:10px;font-size:11px;color:#9a9aa5}
    .file{max-width:70%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;direction:rtl;text-align:left}
  </style></head><body><div class="wrap">
    <div class="title">${title}</div>
    <div class="sub">${sub}</div>
    <div class="bar"><div class="fill" id="fill"></div></div>
    <div class="meta"><span class="file" id="file"></span><span id="pct">0%</span></div>
  </div><script>
    window.__setProgress=function(pct,name){
      document.getElementById('fill').style.width=pct+'%';
      document.getElementById('pct').textContent=pct+'%';
      if(name!=null)document.getElementById('file').textContent=name;
    };
  </script></body></html>`
}

function createProgressWindow(): Promise<BrowserWindow> {
  const win = new BrowserWindow({
    width: 460,
    height: 200,
    frame: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    center: true,
    show: true,
    backgroundColor: '#1e1e24',
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  })
  const html = progressWindowHtml()
  return new Promise((resolve) => {
    win.webContents.once('did-finish-load', () => resolve(win))
    win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
  })
}

function setProgress(win: BrowserWindow | null, pct: number, name: string): Promise<unknown> {
  if (!win || win.isDestroyed()) return Promise.resolve()
  const safeName = JSON.stringify(name)
  // 返回 promise 并在调用处 await，让出事件循环以刷新 IPC、重绘进度窗
  return win.webContents.executeJavaScript(`window.__setProgress(${pct}, ${safeName})`).catch(() => {})
}

async function copyWithProgress(source: string, target: string, win: BrowserWindow | null): Promise<void> {
  const { files, totalBytes } = collectFiles(source, target)
  fs.mkdirSync(target, { recursive: true })
  let copied = 0
  let lastTick = 0
  let lastPct = -1
  for (const file of files) {
    const dest = path.join(target, file.rel)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    try {
      fs.copyFileSync(file.abs, dest)
    } catch (e) {
      // 个别文件（如被占用的日志）失败不应中断整体迁移
      console.warn('[bootstrap] 复制文件失败，跳过:', file.rel, e)
    }
    copied += file.size
    const pct = totalBytes > 0 ? Math.min(100, Math.floor((copied / totalBytes) * 100)) : 100
    const now = Date.now()
    if (pct !== lastPct && (now - lastTick > 120 || pct === 100)) {
      // await 让出事件循环：刷新 IPC、重绘进度窗
      await setProgress(win, pct, file.rel)
      lastTick = now
      lastPct = pct
    }
  }
  await setProgress(win, 100, '')
}

function relaunchApp(): void {
  app.relaunch()
  app.exit(0)
}

/**
 * 在启动早期执行待迁移任务（若有）。
 *
 * 必须在 `app.whenReady()` 之后、且在创建主窗口 / 初始化 sensor / watch / agent
 * 等一切重活之前调用。期间源目录无任何运行时写入，保证复制数据一致。
 *
 * @returns 若执行了迁移并触发了重启，返回 true（调用方应立即 return，停止后续初始化）
 */
export async function runStartupMigrationIfNeeded(): Promise<boolean> {
  const pointer = readPointer()
  if (!pointer.pendingMigration) return false

  const source = app.getPath('userData') // 已在 require 期重定向到当前生效目录
  const target = pointer.pendingMigration.target
  // 记录复制前目标是否已有内容：失败回滚时不能删用户原有的文件
  const targetPreexisted = isTargetNonEmpty(target)
  let win: BrowserWindow | null = null

  try {
    win = await createProgressWindow()
    await copyWithProgress(source, target, win)

    // 复制成功：更新指针，记录旧目录待清理，清除 pending
    const isDefaultTarget = samePath(target, DEFAULT_USERDATA)
    writePointer({
      dataDir: isDefaultTarget ? undefined : path.resolve(target),
      cleanupDir: samePath(source, target) ? undefined : source
    })

    if (win && !win.isDestroyed()) win.destroy()
    relaunchApp()
    return true
  } catch (e) {
    console.error('[bootstrap] 数据迁移失败:', e)
    // 失败回滚：仅当目标是“我们新建的空目录”时才删除残留，
    // 否则（默认目录 / 用户原本就非空的目录）保留，避免误删用户文件。
    try {
      if (!samePath(target, DEFAULT_USERDATA) && !targetPreexisted) {
        fs.rmSync(target, { recursive: true, force: true })
      }
    } catch { /* ignore */ }
    const prev = readPointer()
    writePointer({ dataDir: prev.dataDir, lastError: String((e as Error)?.message ?? e) })
    if (win && !win.isDestroyed()) win.destroy()
    return false // 在原目录上继续正常启动
  }
}
