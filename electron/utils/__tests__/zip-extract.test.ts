import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import iconv from 'iconv-lite'
import {
  decodeZipEntryName,
  extractZipBuffer,
  resolveSafeExtractPath,
  resolveUniqueExtractDirForZip
} from '../zip-extract'

/**
 * 构造无 EFS 标志、GBK 文件名的最小 ZIP（模拟 Windows 中文版压缩）
 */
function createGbkFilenameZip(): Buffer {
  const filenameGbk = iconv.encode('测试文件.txt', 'gbk')
  const contentGbk = iconv.encode('你好世界', 'gbk')

  const crc32 = (data: Buffer): number => {
    let crc = 0xffffffff
    for (const byte of data) {
      crc ^= byte
      for (let i = 0; i < 8; i++) {
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
      }
    }
    return (crc ^ 0xffffffff) >>> 0
  }

  const dosTime = 0
  const dosDate = 0
  const flags = 0
  const method = 0
  const crc = crc32(contentGbk)

  const localHeader = Buffer.alloc(30)
  localHeader.writeUInt32LE(0x04034b50, 0)
  localHeader.writeUInt16LE(20, 4)
  localHeader.writeUInt16LE(flags, 6)
  localHeader.writeUInt16LE(method, 8)
  localHeader.writeUInt16LE(dosTime, 10)
  localHeader.writeUInt16LE(dosDate, 12)
  localHeader.writeUInt32LE(crc, 14)
  localHeader.writeUInt32LE(contentGbk.length, 18)
  localHeader.writeUInt32LE(contentGbk.length, 22)
  localHeader.writeUInt16LE(filenameGbk.length, 26)
  localHeader.writeUInt16LE(0, 28)

  const centralHeader = Buffer.alloc(46)
  centralHeader.writeUInt32LE(0x02014b50, 0)
  centralHeader.writeUInt16LE(20, 4)
  centralHeader.writeUInt16LE(20, 6)
  centralHeader.writeUInt16LE(flags, 8)
  centralHeader.writeUInt16LE(method, 10)
  centralHeader.writeUInt16LE(dosTime, 12)
  centralHeader.writeUInt16LE(dosDate, 14)
  centralHeader.writeUInt32LE(crc, 16)
  centralHeader.writeUInt32LE(contentGbk.length, 20)
  centralHeader.writeUInt32LE(contentGbk.length, 24)
  centralHeader.writeUInt16LE(filenameGbk.length, 28)
  centralHeader.writeUInt16LE(0, 30)
  centralHeader.writeUInt16LE(0, 32)
  centralHeader.writeUInt16LE(0, 34)
  centralHeader.writeUInt16LE(0, 36)
  centralHeader.writeUInt32LE(0, 38)
  centralHeader.writeUInt32LE(0, 42)

  const localRecord = Buffer.concat([localHeader, filenameGbk, contentGbk])
  const centralRecord = Buffer.concat([centralHeader, filenameGbk])

  const endRecord = Buffer.alloc(22)
  endRecord.writeUInt32LE(0x06054b50, 0)
  endRecord.writeUInt16LE(0, 4)
  endRecord.writeUInt16LE(0, 6)
  endRecord.writeUInt16LE(1, 8)
  endRecord.writeUInt16LE(1, 10)
  endRecord.writeUInt32LE(centralRecord.length + localRecord.length, 12)
  endRecord.writeUInt32LE(localRecord.length, 16)
  endRecord.writeUInt16LE(0, 20)

  return Buffer.concat([localRecord, centralRecord, endRecord])
}

describe('decodeZipEntryName', () => {
  it('decodes GBK filenames when EFS flag is not set', () => {
    const raw = iconv.encode('测试文件.txt', 'gbk')
    expect(decodeZipEntryName(raw, false)).toBe('测试文件.txt')
  })

  it('uses UTF-8 when EFS flag is set', () => {
    const raw = Buffer.from('测试文件.txt', 'utf8')
    expect(decodeZipEntryName(raw, true)).toBe('测试文件.txt')
  })
})

describe('resolveSafeExtractPath', () => {
  it('rejects path traversal entries', () => {
    expect(() => resolveSafeExtractPath('/tmp/safe', '../escape.txt'))
      .toThrow(/Unsafe zip entry path/)
  })
})

describe('extractZipBuffer', () => {
  it('extracts Windows GBK zip with correct Chinese filenames', () => {
    const destDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zip-extract-test-'))
    const result = extractZipBuffer(createGbkFilenameZip(), destDir)

    expect(result.files).toHaveLength(1)
    expect(path.basename(result.files[0])).toBe('测试文件.txt')
    expect(fs.readFileSync(result.files[0]).equals(iconv.encode('你好世界', 'gbk'))).toBe(true)
  })

  it('does not overwrite an existing extracted file', () => {
    const destDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zip-extract-test-'))
    const zip = createGbkFilenameZip()

    const first = extractZipBuffer(zip, destDir)
    fs.writeFileSync(first.files[0], 'old content')

    const second = extractZipBuffer(zip, destDir)
    expect(second.files).toHaveLength(1)
    expect(second.files[0]).not.toBe(first.files[0])
    expect(path.basename(second.files[0])).toBe('测试文件 (1).txt')
    expect(fs.readFileSync(first.files[0], 'utf8')).toBe('old content')
  })
})

describe('resolveUniqueExtractDirForZip', () => {
  it('appends suffix when extract directory already exists', () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zip-extract-dir-'))
    const zipPath = path.join(baseDir, 'report.zip')
    fs.writeFileSync(zipPath, '')

    const firstDir = resolveUniqueExtractDirForZip(zipPath)
    fs.mkdirSync(firstDir)

    const secondDir = resolveUniqueExtractDirForZip(zipPath)
    expect(secondDir).toBe(path.join(baseDir, 'report (1)'))
    expect(secondDir).not.toBe(firstDir)
  })
})
