/**
 * tool-display.ts 单元测试
 *
 * 锁定 tool_call / tool_result 步骤在 UI 层的过滤策略，防止后续重构破坏「调试模式 OFF
 * 时的简化呈现」与「失败 / 富内容步骤始终展示」两条 UX 承诺。
 *
 * 重点覆盖：
 * - 用专用 step type 呈现的工具（plan / ask_user / wait）：非调试模式下双卡（tool_call +
 *   tool_result）都被隐藏
 * - 失败步骤（success === false）无视分类规则始终展示
 * - 富内容字段（images / webSearchResults / subAgents）始终展示
 * - 现有 ALWAYS_SHOW / HIDE_RESULT_WHEN_SUCCESS 行为不被新增的 tool_call 过滤改变
 */
import { describe, it, expect } from 'vitest'
import {
  shouldShowToolResultStep,
  TOOLS_WITH_DEDICATED_STEP_TYPE,
  ALWAYS_SHOW_RESULT_TOOLS,
  HIDE_RESULT_WHEN_SUCCESS_TOOLS,
} from './tool-display'

describe('shouldShowToolResultStep', () => {
  describe('非 tool_call/tool_result 的步骤永远展示', () => {
    it('plan_updated step 在非调试模式下也展示（专用 step type 是 UX 主体）', () => {
      expect(
        shouldShowToolResultStep({ type: 'plan_updated', toolName: 'plan' }, false)
      ).toBe(true)
    })

    it('asking step 永远展示', () => {
      expect(
        shouldShowToolResultStep({ type: 'asking', toolName: 'ask_user' }, false)
      ).toBe(true)
    })

    it('thinking / message 等步骤永远展示', () => {
      expect(shouldShowToolResultStep({ type: 'thinking' }, false)).toBe(true)
      expect(shouldShowToolResultStep({ type: 'message' }, false)).toBe(true)
      expect(shouldShowToolResultStep({ type: 'final_result' }, false)).toBe(true)
    })
  })

  describe('TOOLS_WITH_DEDICATED_STEP_TYPE：plan / ask_user / wait', () => {
    it('plan 的 tool_call 在非调试模式下隐藏（让位给 plan_* 专用卡）', () => {
      expect(
        shouldShowToolResultStep(
          { type: 'tool_call', toolName: 'plan', success: true },
          false
        )
      ).toBe(false)
    })

    it('plan 的 tool_result 在非调试模式下隐藏', () => {
      expect(
        shouldShowToolResultStep(
          { type: 'tool_result', toolName: 'plan', success: true },
          false
        )
      ).toBe(false)
    })

    it('plan 在调试模式下完整展示（保留排查链路）', () => {
      expect(
        shouldShowToolResultStep(
          { type: 'tool_call', toolName: 'plan', success: true },
          true
        )
      ).toBe(true)
      expect(
        shouldShowToolResultStep(
          { type: 'tool_result', toolName: 'plan', success: true },
          true
        )
      ).toBe(true)
    })

    it('plan 失败时仍始终展示（success === false 优先级最高）', () => {
      expect(
        shouldShowToolResultStep(
          { type: 'tool_call', toolName: 'plan', success: false },
          false
        )
      ).toBe(true)
      expect(
        shouldShowToolResultStep(
          { type: 'tool_result', toolName: 'plan', success: false },
          false
        )
      ).toBe(true)
    })

    it('ask_user 的双卡在非调试模式下隐藏（asking 专用卡承载语义）', () => {
      expect(
        shouldShowToolResultStep(
          { type: 'tool_call', toolName: 'ask_user', success: true },
          false
        )
      ).toBe(false)
      expect(
        shouldShowToolResultStep(
          { type: 'tool_result', toolName: 'ask_user', success: true },
          false
        )
      ).toBe(false)
    })

    it('wait 的双卡在非调试模式下隐藏（waiting 专用卡承载语义）', () => {
      expect(
        shouldShowToolResultStep(
          { type: 'tool_call', toolName: 'wait', success: true },
          false
        )
      ).toBe(false)
      expect(
        shouldShowToolResultStep(
          { type: 'tool_result', toolName: 'wait', success: true },
          false
        )
      ).toBe(false)
    })

    it('集合内容和文档约定一致', () => {
      expect(TOOLS_WITH_DEDICATED_STEP_TYPE.has('plan')).toBe(true)
      expect(TOOLS_WITH_DEDICATED_STEP_TYPE.has('ask_user')).toBe(true)
      expect(TOOLS_WITH_DEDICATED_STEP_TYPE.has('wait')).toBe(true)
    })
  })

  describe('失败步骤（success === false）始终展示', () => {
    it('execute_command 失败时 tool_result 即使在 HIDE_RESULT_WHEN_SUCCESS_TOOLS 也展示', () => {
      expect(
        shouldShowToolResultStep(
          { type: 'tool_result', toolName: 'execute_command', success: false },
          false
        )
      ).toBe(true)
    })

    it('read_file 失败时展示', () => {
      expect(
        shouldShowToolResultStep(
          { type: 'tool_result', toolName: 'read_file', success: false },
          false
        )
      ).toBe(true)
    })

    it('未知工具失败时展示', () => {
      expect(
        shouldShowToolResultStep(
          { type: 'tool_result', toolName: 'mystery_tool', success: false },
          false
        )
      ).toBe(true)
    })
  })

  describe('富内容字段（hasRichPayload）始终展示', () => {
    it('携带 images 的步骤始终展示', () => {
      expect(
        shouldShowToolResultStep(
          {
            type: 'tool_result',
            toolName: 'read_file', // 即便在 HIDE 集合中
            success: true,
            images: ['data:image/png;base64,...'],
          },
          false
        )
      ).toBe(true)
    })

    it('携带 webSearchResults 的步骤始终展示', () => {
      expect(
        shouldShowToolResultStep(
          {
            type: 'tool_result',
            toolName: 'web_search',
            success: true,
            webSearchResults: [{ title: 'r', url: 'u' }],
          },
          false
        )
      ).toBe(true)
    })

    it('dispatch_agents 的 tool_call 携带 subAgents 时始终展示', () => {
      expect(
        shouldShowToolResultStep(
          {
            type: 'tool_call',
            toolName: 'dispatch_agents',
            success: true,
            subAgents: [{ id: 'sa1', status: 'running' }],
          },
          false
        )
      ).toBe(true)
    })

    it('空数组不算富内容', () => {
      expect(
        shouldShowToolResultStep(
          {
            type: 'tool_result',
            toolName: 'read_file',
            success: true,
            images: [],
            webSearchResults: [],
            subAgents: [],
          },
          false
        )
      ).toBe(false)
    })
  })

  describe('ALWAYS_SHOW_RESULT_TOOLS：动作型工具结果始终展示', () => {
    it('write_text_file 的 tool_result 在非调试模式下展示', () => {
      expect(
        shouldShowToolResultStep(
          { type: 'tool_result', toolName: 'write_text_file', success: true },
          false
        )
      ).toBe(true)
    })

    it('edit_file 的 tool_result 在非调试模式下展示', () => {
      expect(
        shouldShowToolResultStep(
          { type: 'tool_result', toolName: 'edit_file', success: true },
          false
        )
      ).toBe(true)
    })

    it('集合内容和文档约定一致', () => {
      expect(ALWAYS_SHOW_RESULT_TOOLS.has('edit_file')).toBe(true)
      expect(ALWAYS_SHOW_RESULT_TOOLS.has('write_text_file')).toBe(true)
      expect(ALWAYS_SHOW_RESULT_TOOLS.has('remember_info')).toBe(true)
    })
  })

  describe('HIDE_RESULT_WHEN_SUCCESS_TOOLS：信息检索 / 命令型', () => {
    it('execute_command 的 tool_result 成功时隐藏', () => {
      expect(
        shouldShowToolResultStep(
          { type: 'tool_result', toolName: 'execute_command', success: true },
          false
        )
      ).toBe(false)
    })

    it('execute_command 的 tool_call 成功时仍展示（保留知情权）', () => {
      expect(
        shouldShowToolResultStep(
          { type: 'tool_call', toolName: 'execute_command', success: true },
          false
        )
      ).toBe(true)
    })

    it('read_file 的 tool_result 成功时隐藏', () => {
      expect(
        shouldShowToolResultStep(
          { type: 'tool_result', toolName: 'read_file', success: true },
          false
        )
      ).toBe(false)
    })

    it('read_file 的 tool_call 成功时仍展示', () => {
      expect(
        shouldShowToolResultStep(
          { type: 'tool_call', toolName: 'read_file', success: true },
          false
        )
      ).toBe(true)
    })

    it('web_fetch 的 tool_result 成功时隐藏（与 web_search / read_file 同类）', () => {
      expect(
        shouldShowToolResultStep(
          { type: 'tool_result', toolName: 'web_fetch', success: true },
          false
        )
      ).toBe(false)
    })

    it('web_fetch 失败时仍展示', () => {
      expect(
        shouldShowToolResultStep(
          { type: 'tool_result', toolName: 'web_fetch', success: false },
          false
        )
      ).toBe(true)
    })

    it('集合内容和文档约定一致', () => {
      expect(HIDE_RESULT_WHEN_SUCCESS_TOOLS.has('execute_command')).toBe(true)
      expect(HIDE_RESULT_WHEN_SUCCESS_TOOLS.has('read_file')).toBe(true)
      expect(HIDE_RESULT_WHEN_SUCCESS_TOOLS.has('web_search')).toBe(true)
      expect(HIDE_RESULT_WHEN_SUCCESS_TOOLS.has('web_fetch')).toBe(true)
    })
  })

  describe('调试模式：所有 tool_call / tool_result 都展示', () => {
    it('execute_command 成功时也展示', () => {
      expect(
        shouldShowToolResultStep(
          { type: 'tool_result', toolName: 'execute_command', success: true },
          true
        )
      ).toBe(true)
    })

    it('plan 的双卡都展示', () => {
      expect(
        shouldShowToolResultStep(
          { type: 'tool_call', toolName: 'plan', success: true },
          true
        )
      ).toBe(true)
      expect(
        shouldShowToolResultStep(
          { type: 'tool_result', toolName: 'plan', success: true },
          true
        )
      ).toBe(true)
    })
  })

  describe('保守兜底：未登记的工具默认展示', () => {
    it('未知工具的 tool_call 展示', () => {
      expect(
        shouldShowToolResultStep(
          { type: 'tool_call', toolName: 'mystery_tool', success: true },
          false
        )
      ).toBe(true)
    })

    it('未知工具的 tool_result 展示', () => {
      expect(
        shouldShowToolResultStep(
          { type: 'tool_result', toolName: 'mystery_tool', success: true },
          false
        )
      ).toBe(true)
    })

    it('toolName 缺失的步骤展示', () => {
      expect(
        shouldShowToolResultStep(
          { type: 'tool_call', success: true },
          false
        )
      ).toBe(true)
      expect(
        shouldShowToolResultStep(
          { type: 'tool_result', success: true },
          false
        )
      ).toBe(true)
    })
  })
})
