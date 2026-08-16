/**
 * 从崩溃转储里抽出能写进摘要的性质标注
 *
 * 转储本身不进摘要（它是内存快照，无法脱敏）。这里只读两样协议字段：
 * 1. 标准 minidump 异常流里的异常码
 * 2. Electron / Crashpad 写下的 `electron.v8-oom.*` 标注
 *
 * 这两样都是固定字段名与系统异常码，不是对转储里任意文本做关键词搜索。
 */

export interface DumpHints {
  heapOom?: boolean
  oomLocation?: string
  exceptionCode?: number
}

const MDMP_SIGNATURE = 0x504d444d
const EXCEPTION_STREAM = 6
const MAX_ANNOTATION_SKIP_NULLS = 8
const MAX_ANNOTATION_VALUE = 256

/** Darwin mach 异常码（小整数）。Windows 异常码是 0xC000xxxx 量级，不会撞车。 */
const DARWIN_EXCEPTION: Record<number, string> = {
  1: 'EXC_BAD_ACCESS（非法内存访问）',
  2: 'EXC_BAD_INSTRUCTION',
  3: 'EXC_ARITHMETIC',
  5: 'EXC_SOFTWARE',
  6: 'EXC_BREAKPOINT（断点/主动中止，常见于内存耗尽）',
  10: 'EXC_CRASH',
  11: 'EXC_RESOURCE',
  12: 'EXC_GUARD',
}

const WINDOWS_EXCEPTION: Record<string, string> = {
  '0xc0000005': '访问违例（原生内存错误，不是 JS 异常）',
  '0xc0000374': '堆损坏（原生内存错误）',
  '0xc00000fd': '栈溢出',
  '0xc0000409': '栈缓冲区溢出',
  '0xc000041d': '回调中发生未处理异常',
  '0x80000003': '触发断点',
}

export function formatDumpHints(hints: DumpHints): string | undefined {
  const parts: string[] = []
  if (hints.heapOom) {
    parts.push(hints.oomLocation ? `V8 堆内存耗尽（${hints.oomLocation}）` : 'V8 堆内存耗尽')
  } else if (hints.oomLocation) {
    parts.push(`V8 内存分配失败（${hints.oomLocation}）`)
  }
  if (hints.exceptionCode !== undefined) {
    parts.push(describeDumpException(hints.exceptionCode))
  }
  return parts.length > 0 ? parts.join('；') : undefined
}

export function parseDumpHints(buffer: Buffer): DumpHints {
  const hints: DumpHints = {}
  if (buffer.length < 32 || buffer.readUInt32LE(0) !== MDMP_SIGNATURE) return hints

  const exceptionCode = readExceptionCode(buffer)
  if (exceptionCode !== undefined) hints.exceptionCode = exceptionCode

  const heapOom = readAnnotationUint32(buffer, 'electron.v8-oom.is_heap_oom')
  if (heapOom === 1) hints.heapOom = true

  const location = readAnnotationString(buffer, 'electron.v8-oom.location')
  if (location) hints.oomLocation = location

  return hints
}

function readExceptionCode(buffer: Buffer): number | undefined {
  const streamCount = buffer.readUInt32LE(8)
  const directoryRva = buffer.readUInt32LE(12)
  if (streamCount > 64 || directoryRva + streamCount * 12 > buffer.length) return undefined

  for (let i = 0; i < streamCount; i++) {
    const entry = directoryRva + i * 12
    const type = buffer.readUInt32LE(entry)
    const size = buffer.readUInt32LE(entry + 4)
    const rva = buffer.readUInt32LE(entry + 8)
    if (type !== EXCEPTION_STREAM || size < 12 || rva + 12 > buffer.length) continue
    // thread_id + alignment 之后是 exception_code
    return buffer.readUInt32LE(rva + 8)
  }
  return undefined
}

function readAnnotationUint32(buffer: Buffer, key: string): number | undefined {
  const valueAt = annotationValueOffset(buffer, key)
  if (valueAt === undefined || valueAt + 4 > buffer.length) return undefined
  return buffer.readUInt32LE(valueAt)
}

function readAnnotationString(buffer: Buffer, key: string): string | undefined {
  const valueAt = annotationValueOffset(buffer, key)
  if (valueAt === undefined || valueAt + 4 > buffer.length) return undefined
  const length = buffer.readUInt32LE(valueAt)
  if (length <= 0 || length > MAX_ANNOTATION_VALUE || valueAt + 4 + length > buffer.length) {
    return undefined
  }
  const raw = buffer.slice(valueAt + 4, valueAt + 4 + length).toString('latin1').replace(/\0+$/, '')
  return /^[\x20-\x7e]+$/.test(raw) ? raw : undefined
}

/** 标注键是 Electron 写死的字段名；其后为 0 填充，再跟 uint32 值或「长度 + 字符串」 */
function annotationValueOffset(buffer: Buffer, key: string): number | undefined {
  const start = buffer.indexOf(key, 0, 'ascii')
  if (start < 0) return undefined
  let i = start + key.length
  let skipped = 0
  while (i < buffer.length && buffer[i] === 0 && skipped < MAX_ANNOTATION_SKIP_NULLS) {
    i += 1
    skipped += 1
  }
  return skipped > 0 ? i : undefined
}

function describeDumpException(code: number): string {
  const darwin = DARWIN_EXCEPTION[code]
  if (darwin) return `${darwin} (0x${code.toString(16)})`
  const hex = `0x${(code >>> 0).toString(16)}`
  const windows = WINDOWS_EXCEPTION[hex]
  return windows ? `${hex} ${windows}` : hex
}
