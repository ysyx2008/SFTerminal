/**
 * Agent workspace 路径（唯一真相源）。
 *
 * 从 tools/file.ts 抽出：落盘 helper（tool-output-externalize）等基础设施需要
 * scratch 路径，若直接从 tools/file.ts 取会形成「工具 → helper → 工具」循环依赖。
 * tools/file.ts 仍 re-export 这两个函数，既有调用方无需改动。
 */
import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'

/**
 * 获取 Agent workspace 目录路径
 */
export function getWorkspacePath(): string {
  return path.join(app.getPath('userData'), 'agent-workspace')
}

/**
 * Agent 默认工作目录（临时脚本、草稿、中间产物）
 */
export function getScratchPath(): string {
  const scratch = path.join(getWorkspacePath(), 'scratch')
  fs.mkdirSync(scratch, { recursive: true })
  return scratch
}
