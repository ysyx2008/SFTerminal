import * as fs from 'fs'
import * as path from 'path'

/**
 * 原子写入：先写临时文件再 rename，崩溃时保留旧文件完整。
 */
export function writeFileAtomic(filePath: string, content: string | Buffer): void {
  const dir = path.dirname(filePath)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, content)
  fs.renameSync(tmp, filePath)
}
