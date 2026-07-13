/**
 * OOP 边界护栏测试
 *
 * 这是 SPEC.md「工具元数据驱动模型」承诺的机械护栏：枚举所有已知工具名，
 * 断言 Agent 抽象层（agent.ts / streaming-tool-executor.ts /
 * tool-output-budget.ts / task-memory.ts / context-builder.ts / tool-metadata.ts）
 * 的源码里**不再出现**任何一个工具名字面量。
 *
 * 这层文件是"基类 / 跨工具的横切关注点"，按 OOP 原则不应知道具体子类（具体工具）
 * 的名字；任何"按工具名差异化"的逻辑都应通过 ToolDefinition._meta 声明
 * 让基类按元数据决策。
 *
 * 一旦后续重构（包括 AI 顺手加的代码）违反该原则，本测试在 CI 阶段会立刻失败。
 *
 * 例外：
 * - tools.ts 本身（工具定义就在这里）
 * - tools/ 目录（具体工具执行器）
 * - skills/ 目录（具体技能实现）
 * - i18n.ts（翻译键命名空间，不属于运行时分支）
 */
import { describe, it, expect, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn().mockReturnValue('/mock/user/data'),
    getName: vi.fn().mockReturnValue('SailFish'),
    getVersion: vi.fn().mockReturnValue('1.0.0')
  },
  BrowserWindow: vi.fn(),
  ipcMain: { on: vi.fn(), handle: vi.fn() }
}))

vi.mock('../../im/im.service', () => ({
  getIMService: vi.fn().mockReturnValue(null)
}))

vi.mock('../../user-skill.service', () => ({
  getUserSkillService: () => ({ getEnabledSkills: () => [] })
}))

vi.mock('../../config.service', () => ({
  getConfigService: () => ({ get: () => undefined })
}))

vi.mock('../../web-search/index', () => ({
  isConfigured: () => false,
  // web-fetch.service 通过 getApiKey('jina') 检测是否走 Jina Reader 增强
  getApiKey: () => '',
}))

import { getAgentTools } from '../tools'
import { getAllTerminalTools } from '../skills/terminal/tools'
import { wordTools } from '../skills/word/tools'
import { excelTools } from '../skills/excel/tools'
import { personalityTools } from '../skills/personality/tools'
import type { ToolDefinition } from '../../ai.service'

const AGENT_DIR = path.resolve(__dirname, '..')

/**
 * 收集所有"内置工具名"——任何抽象层都不该硬编码这些。
 *
 * 注意：这里收集的是工具名，不是行为模式；测试不依赖任何一份"已知违反清单"，
 * 工具列表由实际的 ToolDefinition 定义动态枚举（新工具自动进入护栏）。
 */
function collectAllToolNames(): string[] {
  const allTools: ToolDefinition[] = [
    ...getAgentTools(undefined, { mode: 'assistant' }),
    ...getAgentTools(undefined, { mode: 'ssh' }),
    ...getAllTerminalTools(),
    ...wordTools,
    ...excelTools,
    ...personalityTools
  ]
  return Array.from(new Set(allTools.map(t => t.function.name)))
}

/**
 * 这些工具名"可豁免"——它们不属于通过 _meta 决策的范畴：
 * - 历史遗留：曾经存在但已合并/重命名的工具名（如 deep_recall 被合并进 recall）
 * - 协议通用前缀（mcp_ / plugin_）走另外的通用机制
 * 本列表只用于 false positive 抑制，不构成"基类可以硬编码这些"的许可。
 */
const ALLOWED_LITERALS = new Set<string>([
  // 当前没有；如发现合理的例外再添加并解释原因
])

/**
 * 检查指定文件源码中是否出现某个工具名作为字符串字面量。
 *
 * 检测覆盖三种字符串字面量形式：单引号 / 双引号 / 反引号（template literal，无插值）。
 * 不覆盖刻意绕过的形式（字符串拼接、转义序列、动态拼接等）——那些不是日常会写出来的代码，
 * 真要绕也容易在 review 时发现。
 *
 * 字面量在注释里也会被匹配——这是有意为之，注释里也不该出现具体工具名（提示文除外，
 * 但提示文不属于本规则护栏的 6 个抽象层文件）。
 */
function findToolNameLiterals(sourceCode: string, toolNames: string[]): string[] {
  const found: string[] = []
  for (const name of toolNames) {
    if (ALLOWED_LITERALS.has(name)) continue
    if (
      sourceCode.includes(`'${name}'`) ||
      sourceCode.includes(`"${name}"`) ||
      sourceCode.includes(`\`${name}\``)
    ) {
      found.push(name)
    }
  }
  return found
}

describe('OOP 边界护栏：抽象层不应硬编码任何具体工具名', () => {
  // 抽象层文件清单：基类 + 横切关注点（不含 tools.ts 等工具定义聚合点）
  const ABSTRACT_LAYER_FILES = [
    'agent.ts',
    'streaming-tool-executor.ts',
    'tool-output-budget.ts',
    'task-memory.ts',
    'context-builder.ts',
    'tool-metadata.ts'
  ]

  for (const file of ABSTRACT_LAYER_FILES) {
    it(`${file} 不应包含任何工具名字符串字面量`, () => {
      const filePath = path.join(AGENT_DIR, file)
      expect(fs.existsSync(filePath)).toBe(true)
      const source = fs.readFileSync(filePath, 'utf-8')
      const toolNames = collectAllToolNames()
      const offenders = findToolNameLiterals(source, toolNames)

      if (offenders.length > 0) {
        const hint = [
          `${file} 出现了硬编码的工具名: ${offenders.join(', ')}`,
          '',
          'OOP 边界违反：抽象层不应知道具体工具名。',
          '修复方法：把"按工具名做行为分支"的逻辑改为通过 ToolDefinition._meta 声明',
          '（streamDisplay / parallelizable / phase / idempotencyKey / lifecycle / argRole），',
          '抽象层通过 tool-metadata.ts 的 helper 按需查询，不直接 switch 工具名。',
          '详见 SPEC.md「工具元数据驱动模型」一节。'
        ].join('\n')
        expect.fail(hint)
      }
    })
  }

  it('护栏本身要能枚举到工具（防止 mock / import 失败导致护栏静默失效）', () => {
    const names = collectAllToolNames()
    expect(names.length).toBeGreaterThan(20)
    // 至少应该包含若干基础工具，确认 import 链路正常
    expect(names).toContain('read_file')
    expect(names).toContain('execute_command')
    expect(names).toContain('write_text_file')
    expect(names).toContain('dispatch_agents')
  })
})
