/**
 * Migration v10: MCP whenToUse 升级通知锚点。
 *
 * 本 migration 无数据改写；仅推进 schemaVersion，供启动逻辑判断
 * 「本启是否刚跨过 v10」从而 one-shot 联络通知。无专用 marker 文件。
 *
 * @see electron/services/MCP_SPEC.md
 */
import { createLogger } from '../utils/logger'
import type { Migration } from './types'

const log = createLogger('Migration:v10')

export const migrationV10: Migration = {
  version: 10,
  name: 'mcp-when-to-use-notice',
  phase: 'services',
  async migrate() {
    log.info('v10 mcp-when-to-use-notice: schema bump only (companion notice is deferred one-shot)')
  },
}
