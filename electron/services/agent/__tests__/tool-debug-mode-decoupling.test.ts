/**
 * 机械护栏：保证 tool_result 的 emit 与持久化和 debugMode 解耦。
 *
 * 历史背景：曾在 exec / execute_command / send_input / send_control_key / load_skill
 * 等工具里把 `executor.addStep({type:'tool_result', ...})` 用 `if (config.debugMode) {...}`
 * 包起来。这样在非调试模式下：
 *   1. 用户看不到工具执行结果（看似只是 UX 问题）
 *   2. 该 step 也不会进 run.steps，导致会话历史里整个工具结果消失（数据持久化问题）
 *   3. 事后开启调试模式也无法回看（不可逆数据丢失）
 *
 * 正确语义：
 *   - 后端永远 emit `tool_result`（`addStep` 同时写入 run.steps 和回调前端 IPC）
 *   - 是否在 UI 显示由 `src/utils/tool-display.ts::shouldShowToolResultStep` 在前端决策
 *   - debugMode 只控制前端呈现，不影响 emit/持久化
 *
 * 详见：electron/services/agent/SPEC.md「工具执行透明原则」
 */

import * as fs from 'fs'
import * as path from 'path'
import { describe, it, expect } from 'vitest'

const TOOLS_DIR = path.join(__dirname, '..', 'tools')

describe('tool_result emit ↔ debugMode decoupling', () => {
  it('no tool source file uses `config.debugMode` to gate emit/branching', () => {
    const files = fs.readdirSync(TOOLS_DIR).filter(f => f.endsWith('.ts'))

    const offenders: Array<{ file: string; matches: string[] }> = []
    for (const file of files) {
      const fullPath = path.join(TOOLS_DIR, file)
      const content = fs.readFileSync(fullPath, 'utf8')
      const lines = content.split('\n')
      const matches: string[] = []
      lines.forEach((line, idx) => {
        if (/\bconfig\.debugMode\b/.test(line)) {
          matches.push(`L${idx + 1}: ${line.trim()}`)
        }
      })
      if (matches.length > 0) offenders.push({ file, matches })
    }

    if (offenders.length > 0) {
      const detail = offenders
        .map(o => `  ${o.file}:\n    ${o.matches.join('\n    ')}`)
        .join('\n')
      throw new Error(
        `tool source file(s) reference \`config.debugMode\`. ` +
          `debugMode is a UI-only concern; tools must always emit tool_result.\n` +
          `See SPEC.md「工具执行透明原则」.\n${detail}`
      )
    }

    expect(offenders).toEqual([])
  })
})
