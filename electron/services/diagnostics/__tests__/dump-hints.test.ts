import { describe, it, expect } from 'vitest'
import { formatDumpHints, parseDumpHints } from '../dump-hints'

function buildMinidump(opts: { exceptionCode: number; annotations?: Buffer }): Buffer {
  const headerSize = 32
  const dirSize = 12
  const exceptionSize = 24
  const exceptionRva = headerSize + dirSize
  const annotationRva = exceptionRva + exceptionSize
  const annotations = opts.annotations ?? Buffer.alloc(0)
  const buf = Buffer.alloc(annotationRva + annotations.length)

  buf.writeUInt32LE(0x504d444d, 0)
  buf.writeUInt32LE(0xa793, 4)
  buf.writeUInt32LE(1, 8)
  buf.writeUInt32LE(headerSize, 12)

  buf.writeUInt32LE(6, headerSize)
  buf.writeUInt32LE(exceptionSize, headerSize + 4)
  buf.writeUInt32LE(exceptionRva, headerSize + 8)

  buf.writeUInt32LE(1, exceptionRva)
  buf.writeUInt32LE(0, exceptionRva + 4)
  buf.writeUInt32LE(opts.exceptionCode, exceptionRva + 8)

  annotations.copy(buf, annotationRva)
  return buf
}

function v8OomAnnotations(): Buffer {
  const location = 'CALL_AND_RETRY_LAST'
  const parts = [
    Buffer.from('electron.v8-oom.is_heap_oom\0', 'ascii'),
    Buffer.from([1, 0, 0, 0]),
    Buffer.from('electron.v8-oom.location\0\0\0\0', 'ascii'),
    Buffer.alloc(4),
    Buffer.from(`${location}\0`, 'ascii'),
  ]
  parts[3].writeUInt32LE(location.length, 0)
  return Buffer.concat(parts)
}

describe('转储标注', () => {
  it('读出 V8 堆内存耗尽与异常码——这是判断原生内存错误的关键', () => {
    const hints = parseDumpHints(buildMinidump({
      exceptionCode: 6,
      annotations: v8OomAnnotations(),
    }))
    expect(hints.heapOom).toBe(true)
    expect(hints.oomLocation).toBe('CALL_AND_RETRY_LAST')
    expect(hints.exceptionCode).toBe(6)

    const text = formatDumpHints(hints)
    expect(text).toContain('V8 堆内存耗尽')
    expect(text).toContain('CALL_AND_RETRY_LAST')
    expect(text).toContain('EXC_BREAKPOINT')
  })

  it('Windows 访问违例也翻成可读性质', () => {
    const text = formatDumpHints(parseDumpHints(buildMinidump({
      exceptionCode: 0xc0000005,
    })))
    expect(text).toContain('0xc0000005')
    expect(text).toContain('原生内存错误')
  })

  it('不是 minidump 就如实不编造', () => {
    expect(parseDumpHints(Buffer.alloc(1024, 7))).toEqual({})
    expect(formatDumpHints({})).toBeUndefined()
  })
})
