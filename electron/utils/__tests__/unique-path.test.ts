import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { ensureUniquePath } from '../unique-path'

describe('ensureUniquePath', () => {
  it('returns original path when it does not exist', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unique-path-'))
    const target = path.join(dir, 'new-file.txt')
    expect(ensureUniquePath(target)).toBe(target)
  })

  it('appends numeric suffix for existing files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unique-path-'))
    const target = path.join(dir, 'report.zip')
    fs.writeFileSync(target, 'v1')

    expect(ensureUniquePath(target)).toBe(path.join(dir, 'report (1).zip'))
  })

  it('appends numeric suffix for existing directories', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unique-path-'))
    const target = path.join(dir, 'report')
    fs.mkdirSync(target)

    expect(ensureUniquePath(target)).toBe(path.join(dir, 'report (1)'))
  })
})
