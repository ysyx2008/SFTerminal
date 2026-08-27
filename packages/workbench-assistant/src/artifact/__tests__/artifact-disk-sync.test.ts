import { describe, it, expect } from 'vitest'
import {
  artifactNeedsForcedPreviewRefresh,
  shouldRefreshPreviewAfterStep,
  shouldSkipPreviewRefresh,
  shouldSyncArtifactsAfterStep
} from '../domain/artifact-disk-sync'

describe('shouldSyncArtifactsAfterStep', () => {
  it('exec / await_exec 的 tool_result 触发同步', () => {
    expect(shouldSyncArtifactsAfterStep({
      type: 'tool_result',
      toolName: 'exec',
      content: 'done'
    } as never)).toBe(true)
    expect(shouldSyncArtifactsAfterStep({
      type: 'tool_result',
      toolName: 'await_exec',
      content: 'done'
    } as never)).toBe(true)
  })

  it('其它步骤不触发', () => {
    expect(shouldSyncArtifactsAfterStep({
      type: 'tool_call',
      toolName: 'exec',
      content: ''
    } as never)).toBe(false)
    expect(shouldSyncArtifactsAfterStep({
      type: 'tool_result',
      toolName: 'write_text_file',
      content: 'ok'
    } as never)).toBe(false)
  })
})

describe('shouldRefreshPreviewAfterStep', () => {
  it('脚本或写文件落地后触发预览重建', () => {
    for (const toolName of [
      'exec', 'await_exec', 'write_text_file', 'edit_file', 'word_save',
      'excel_save', 'excel_from_markdown', 'excel_merge_template'
    ]) {
      expect(shouldRefreshPreviewAfterStep({
        type: 'tool_result',
        toolName,
        content: 'ok'
      } as never)).toBe(true)
    }
  })

  it('只改内存、尚未写盘的 Word / Excel 步骤不从磁盘重建', () => {
    expect(shouldRefreshPreviewAfterStep({
      type: 'tool_result',
      toolName: 'word_replace',
      content: 'ok'
    } as never)).toBe(false)
    expect(shouldRefreshPreviewAfterStep({
      type: 'tool_result',
      toolName: 'excel_modify',
      content: 'ok'
    } as never)).toBe(false)
    expect(shouldRefreshPreviewAfterStep({
      type: 'tool_call',
      toolName: 'exec',
      content: ''
    } as never)).toBe(false)
  })
})

describe('artifactNeedsForcedPreviewRefresh', () => {
  it('已打开的 Word / 表格需要强制重建', () => {
    expect(artifactNeedsForcedPreviewRefresh({
      filePath: '/tmp/a.docx',
      renderer: 'document'
    })).toBe(true)
    expect(artifactNeedsForcedPreviewRefresh({
      filePath: '/tmp/a.xlsx',
      renderer: 'spreadsheet'
    })).toBe(true)
  })

  it('无路径或 Markdown 不强制重建', () => {
    expect(artifactNeedsForcedPreviewRefresh({
      filePath: null,
      renderer: 'document'
    })).toBe(false)
    expect(artifactNeedsForcedPreviewRefresh({
      filePath: '/tmp/a.md',
      renderer: 'markdown'
    })).toBe(false)
  })
})

describe('shouldSkipPreviewRefresh', () => {
  it('修改时间相同则跳过', () => {
    expect(shouldSkipPreviewRefresh(100, 100)).toBe(true)
  })

  it('修改时间变了或未知则重建', () => {
    expect(shouldSkipPreviewRefresh(100, 200)).toBe(false)
    expect(shouldSkipPreviewRefresh(undefined, 100)).toBe(false)
    expect(shouldSkipPreviewRefresh(100, undefined)).toBe(false)
  })
})
