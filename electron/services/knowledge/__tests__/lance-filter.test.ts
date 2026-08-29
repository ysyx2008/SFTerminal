import { describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { lanceEquals } from '../lance-filter'

describe('lanceEquals', () => {
  it('quotes camelCase columns with backticks', () => {
    expect(lanceEquals('docId', 'b14ad6c4-ab9a-47f9-9ee8-642a13b96164'))
      .toBe("`docId` = 'b14ad6c4-ab9a-47f9-9ee8-642a13b96164'")
  })

  it('escapes single quotes in values', () => {
    expect(lanceEquals('id', "o'reilly")).toBe("`id` = 'o''reilly'")
  })

  it('rejects unsafe column names', () => {
    expect(() => lanceEquals('docId; drop', 'x')).toThrow(/invalid LanceDB column/)
  })
})

describe('LanceDB delete predicate', () => {
  it('double-quoted camelCase column matches nothing; backtick predicate deletes', async () => {
    const { connect } = await import('@lancedb/lancedb')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sailfish-lance-filter-'))
    try {
      const db = await connect(dir)
      const table = await db.createTable('knowledge_vectors', [{
        id: 'chunk-1',
        docId: 'b14ad6c4-ab9a-47f9-9ee8-642a13b96164',
        content: 'orphan',
        vector: [0, 1],
        filename: 'conv_test',
        hostId: 'personal',
        tags: 'conversation',
        chunkIndex: 0,
        createdAt: 1,
      }])

      const before = await table.countRows()
      await table.delete(`"docId" = 'b14ad6c4-ab9a-47f9-9ee8-642a13b96164'`)
      expect(await table.countRows()).toBe(before)

      await table.delete(lanceEquals('docId', 'b14ad6c4-ab9a-47f9-9ee8-642a13b96164'))
      expect(await table.countRows()).toBe(0)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
