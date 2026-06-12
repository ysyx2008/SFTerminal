import * as fs from 'fs'
import * as path from 'path'

/**
 * 若目标路径已存在，追加 " (1)" / " (2)" … 后缀，避免覆盖。
 * 适用于文件或目录。
 */
export function ensureUniquePath(targetPath: string): string {
  if (!fs.existsSync(targetPath)) {
    return targetPath
  }

  const parsed = path.parse(targetPath)
  let counter = 1
  let nextPath = path.join(parsed.dir, `${parsed.name} (${counter})${parsed.ext}`)

  while (fs.existsSync(nextPath)) {
    counter += 1
    nextPath = path.join(parsed.dir, `${parsed.name} (${counter})${parsed.ext}`)
  }

  return nextPath
}
