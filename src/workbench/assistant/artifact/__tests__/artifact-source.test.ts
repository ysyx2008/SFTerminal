/**
 * 来源区与空态相关单元测试
 */
import { describe, it, expect } from 'vitest'
import {
  applyCanvasData,
  createTabArtifactState,
  dismissEmptyPanel,
  hydrateArtifactsFromSteps,
  isArtifactEmptyState,
  isPanelVisible,
  removeArtifact
} from '../domain/artifact-registry'
import {
  enrichCanvasDataFromStep,
  resolveSourceStepIdById,
  resolveVisibleSourceStepId
} from '../domain/artifact-source'

describe('artifact source & empty state', () => {
  it('open 时填充 origin / editable / sourceStepId', () => {
    const state = applyCanvasData(createTabArtifactState(), {
      action: 'open',
      renderer: 'markdown',
      title: 'a.md',
      filePath: '/tmp/a.md',
      content: '# hi',
      sourceStepId: 'step-1',
      origin: 'agent'
    })
    const artifact = state.artifacts[0]
    expect(artifact.origin).toBe('agent')
    expect(artifact.editable).toBe(true)
    expect(artifact.sourceStepId).toBe('step-1')
  })

  it('enrichCanvasDataFromStep 将 tool_result 解析为 tool_call', () => {
    const steps = [
      { id: 'tc-1', type: 'tool_call', toolName: 'word_create', toolCallId: 'call-1' },
      { id: 'tr-1', type: 'tool_result', toolName: 'word_create', toolCallId: 'call-1' }
    ]
    expect(
      enrichCanvasDataFromStep(
        { action: 'open', renderer: 'document', title: 'a' },
        steps[1],
        steps
      ).sourceStepId
    ).toBe('tc-1')
  })

  it('resolveSourceStepIdById 兼容已存的 tool_result id', () => {
    const steps = [
      { id: 'tc-1', type: 'tool_call', toolName: 'markdown_write', toolCallId: 'call-2' },
      { id: 'tr-2', type: 'tool_result', toolName: 'markdown_write', toolCallId: 'call-2' }
    ]
    expect(resolveSourceStepIdById('tr-2', steps)).toBe('tc-1')
  })

  it('hydrateArtifactsFromSteps 回填可见 sourceStepId', () => {
    const state = hydrateArtifactsFromSteps([
      { id: 'tc-h', type: 'tool_call', toolName: 'word_create', toolCallId: 'c-h' },
      {
        id: 'tr-h',
        type: 'tool_result',
        toolName: 'word_create',
        toolCallId: 'c-h',
        canvasData: {
          action: 'open',
          renderer: 'document',
          title: 'doc.docx',
          filePath: '/tmp/doc.docx',
          content: '<p>x</p>'
        }
      }
    ])
    expect(state.artifacts[0].sourceStepId).toBe('tc-h')
  })

  it('最后一个 artifact 移除后进入空态占位', () => {
    let state = applyCanvasData(createTabArtifactState(), {
      action: 'open',
      renderer: 'markdown',
      title: 'a.md',
      filePath: '/a.md',
      content: 'x'
    })
    state = removeArtifact(state, state.artifacts[0].id)
    expect(state.artifacts).toHaveLength(0)
    expect(state.hadArtifacts).toBe(true)
    expect(isArtifactEmptyState(state)).toBe(false)
    expect(isPanelVisible(state)).toBe(false)
  })

  it('dismissEmptyPanel 重置面板', () => {
    let state = applyCanvasData(createTabArtifactState(), {
      action: 'open',
      renderer: 'markdown',
      title: 'a.md',
      filePath: '/a.md',
      content: 'x'
    })
    state = removeArtifact(state, state.artifacts[0].id)
    state = dismissEmptyPanel(state)
    expect(isPanelVisible(state)).toBe(false)
    expect(isArtifactEmptyState(state)).toBe(false)
  })
})

describe('resolveVisibleSourceStepId', () => {
  it('tool_call 直接使用自身 id', () => {
    expect(
      resolveVisibleSourceStepId(
        { id: 'tc-1', type: 'tool_call', toolName: 'read_file' },
        []
      )
    ).toBe('tc-1')
  })
})
