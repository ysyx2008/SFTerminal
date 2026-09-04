import { describe, expect, it } from 'vitest'
import { describeLiveProcess } from './process-fold'
import { buildPeekProcessView, countPeekNeedsYou, lastSpokenBody, overlayReservePx, pickPeekExpandSteps, pickPeekLiveFold, pickPeekLiveSteps, pickPeekProcessItems, resolveFocusPeek, resolvePeekOverlay, resolvePeekSurface } from './focus-peek'

describe('lastSpokenBody', () => {
  it('takes the last message body, skipping thinking', () => {
    expect(lastSpokenBody([
      { type: 'message', content: '先说的' },
      { type: 'tool_call', content: 'read' },
      { type: 'message', content: '后说的' },
    ])).toBe('后说的')
  })

  it('ignores empty spoken bodies', () => {
    expect(lastSpokenBody([
      { type: 'message', content: '留下这句' },
      { type: 'message', content: '   ' },
    ])).toBe('留下这句')
  })
})

describe('resolveFocusPeek', () => {
  it('hides the card when the user must act', () => {
    expect(resolveFocusPeek({
      needsYou: true,
      isRunning: true,
      liveText: '在改第三章',
      spoken: '改好了',
    })).toEqual({ kind: 'none', text: '' })
  })

  it('shows the live line while running', () => {
    expect(resolveFocusPeek({
      needsYou: false,
      isRunning: true,
      liveText: '在改第三章',
      spoken: '上一句',
    })).toEqual({ kind: 'busy', text: '在改第三章' })
  })

  it('shows the last spoken line when idle', () => {
    expect(resolveFocusPeek({
      needsYou: false,
      isRunning: false,
      spoken: '扩写了结尾',
    })).toEqual({ kind: 'spoken', text: '扩写了结尾' })
  })

  it('shows nothing when idle and nobody has spoken', () => {
    expect(resolveFocusPeek({
      needsYou: false,
      isRunning: false,
    })).toEqual({ kind: 'none', text: '' })
  })
})

describe('pickPeekProcessItems', () => {
  it('keeps only the live fold from this run', () => {
    const items = [
      { id: 'old', type: 'folded_turn', fold: { live: false } },
      { id: 'live', type: 'folded_turn', fold: { live: true } },
    ]
    expect(pickPeekProcessItems(items, true).map(item => item.id)).toEqual(['live'])
  })

  it('after a pin, keeps only the stretch that started afterwards', () => {
    const items = [
      { id: 'before', type: 'folded_turn', fold: { live: false } },
      { id: 'think', type: 'step' },
    ]
    expect(pickPeekProcessItems(items, true).map(item => item.id)).toEqual(['think'])
  })

  it('without folds, keeps only the last moving step', () => {
    const items = [
      { id: 't1', type: 'step' },
      { id: 't2', type: 'step' },
      { id: 'think', type: 'step' },
    ]
    expect(pickPeekProcessItems(items, true).map(item => item.id)).toEqual(['think'])
  })

  it('while running with only a finished fold, waits for the next stretch', () => {
    const items = [
      { id: 'done', type: 'folded_turn', fold: { live: false } },
    ]
    expect(pickPeekProcessItems(items, true)).toEqual([])
  })

  it('hides process when the run is over', () => {
    expect(pickPeekProcessItems(
      [{ id: 'done', type: 'folded_turn', fold: { live: false } }],
      false,
    )).toEqual([])
  })
})

describe('resolvePeekSurface', () => {
  it('shows the ask when there is something to answer', () => {
    expect(resolvePeekSurface({
      needsYou: true,
      needsYouCount: 1,
      processCount: 1,
      kind: 'none',
    })).toBe('needs-you')
  })

  it('after the ask is gone, goes back to the live process line', () => {
    expect(resolvePeekSurface({
      needsYou: true,
      needsYouCount: 0,
      processCount: 1,
      kind: 'busy',
    })).toBe('process')
  })

  it('keeps the process line while running even before the next fold arrives', () => {
    expect(resolvePeekSurface({
      needsYou: true,
      needsYouCount: 0,
      processCount: 0,
      kind: 'busy',
    })).toBe('process')
  })

  it('keeps the process line while running even if needs-you is stale and the busy kind was cleared', () => {
    expect(resolvePeekSurface({
      needsYou: true,
      needsYouCount: 0,
      processCount: 0,
      kind: 'none',
      isRunning: true,
    })).toBe('process')
  })

  it('shows the last spoken line when idle', () => {
    expect(resolvePeekSurface({
      needsYou: false,
      needsYouCount: 0,
      processCount: 0,
      kind: 'spoken',
    })).toBe('spoken')
  })
})

describe('pickPeekLiveFold', () => {
  it('keeps only the fold that is still running', () => {
    const items = [
      { id: 'done', type: 'folded_turn', fold: { live: false } },
      { id: 'live', type: 'folded_turn', fold: { live: true } },
      { id: 'step', type: 'step' },
    ]
    expect(pickPeekLiveFold(items)?.id).toBe('live')
  })

  it('returns nothing when the last fold already finished', () => {
    expect(pickPeekLiveFold([
      { id: 'done', type: 'folded_turn', fold: { live: false } },
    ])).toBeNull()
  })
})

describe('pickPeekLiveSteps', () => {
  it('starts after the last question, so the live line is this stretch', () => {
    expect(pickPeekLiveSteps([
      { type: 'thinking' },
      { type: 'tool_call' },
      { type: 'asking' },
      { type: 'tool_call' },
    ]).map(step => step.type)).toEqual(['tool_call'])
  })

  it('starts after a password or wait pin the same way', () => {
    expect(pickPeekLiveSteps([
      { type: 'tool_call' },
      { type: 'waiting_password' },
      { type: 'thinking' },
    ]).map(step => step.type)).toEqual(['thinking'])
    expect(pickPeekLiveSteps([
      { type: 'tool_call' },
      { type: 'waiting' },
      { type: 'tool_call' },
    ]).map(step => step.type)).toEqual(['tool_call'])
  })

  it('keeps the whole launch when nobody has asked yet', () => {
    expect(pickPeekLiveSteps([
      { type: 'thinking' },
      { type: 'tool_call' },
    ]).map(step => step.type)).toEqual(['thinking', 'tool_call'])
  })
})

describe('pickPeekExpandSteps', () => {
  it('keeps this run\'s thinking and tools, skips spoken lines and asks', () => {
    expect(pickPeekExpandSteps([
      { type: 'message' },
      { type: 'tool_call' },
      { type: 'asking' },
      { type: 'thinking' },
      { type: 'tool_result' },
    ]).map(step => step.type)).toEqual(['tool_call', 'thinking', 'tool_result'])
  })
})

describe('overlayReservePx', () => {
  it('reserves a capsule-sized band when the overlay has no height yet', () => {
    expect(overlayReservePx()).toBe(160)
    expect(overlayReservePx(0)).toBe(160)
  })

  it('never shrinks below a tap target, and rounds measured height up', () => {
    expect(overlayReservePx(80)).toBe(120)
    expect(overlayReservePx(200.2)).toBe(201)
  })
})

describe('countPeekNeedsYou', () => {
  it('counts confirm and password even when there is no ask in the list', () => {
    expect(countPeekNeedsYou({
      interactiveAskCount: 0,
      hasConfirm: true,
    })).toBe(1)
    expect(countPeekNeedsYou({
      interactiveAskCount: 0,
      hasSecure: true,
    })).toBe(1)
  })

  it('adds the remaining ask on top of confirm', () => {
    expect(countPeekNeedsYou({
      interactiveAskCount: 1,
      hasConfirm: true,
    })).toBe(2)
  })
})

describe('resolvePeekOverlay', () => {
  it('keeps a process card while running after an ask, even with no fold yet', () => {
    expect(resolvePeekOverlay({
      needsYou: false,
      needsYouCount: 0,
      processCount: 0,
      isRunning: true,
      spoken: '上一行改好了',
    })).toBe('process')
  })

  it('shows the ask when there is a question to answer', () => {
    expect(resolvePeekOverlay({
      needsYou: true,
      needsYouCount: 1,
      processCount: 0,
      isRunning: true,
    })).toBe('needs-you')
  })

  it('shows confirm while running even if no ask row is in the list', () => {
    expect(resolvePeekOverlay({
      needsYou: true,
      needsYouCount: countPeekNeedsYou({
        interactiveAskCount: 0,
        hasConfirm: true,
      }),
      processCount: 1,
      isRunning: true,
    })).toBe('needs-you')
  })

  it('shows the last spoken line when the run is over', () => {
    expect(resolvePeekOverlay({
      needsYou: false,
      needsYouCount: 0,
      processCount: 0,
      isRunning: false,
      spoken: '表改完了',
    })).toBe('spoken')
  })

  it('after an ask, hidden excel edits still keep a live process view', () => {
    const view = buildPeekProcessView({
      isRunning: true,
      steps: [
        { id: 't1', type: 'thinking' },
        { id: 'e1', type: 'tool_call', toolName: 'excel_modify' },
        { id: 'ask', type: 'asking' },
        { id: 'e2', type: 'tool_call', toolName: 'excel_modify' },
        { id: 'r2', type: 'tool_result', toolName: 'excel_modify' },
      ],
      items: [
        { id: 'done', type: 'folded_turn', fold: { live: false } },
      ],
    })
    expect(view.liveFold).toBeNull()
    expect(view.liveSteps.map(step => step.id)).toEqual(['e2', 'r2'])
    expect(view.expandSteps.map(step => step.id)).toEqual(['t1', 'e1', 'e2', 'r2'])
    expect(describeLiveProcess(view.liveSteps).liveAction).toBe('edit')
    expect(resolvePeekOverlay({
      needsYou: false,
      needsYouCount: 0,
      processCount: view.items.length,
      isRunning: true,
    })).toBe('process')
  })

  it('walks ask → answer → keep working → done without an empty surface', () => {
    expect(resolvePeekOverlay({
      needsYou: true,
      needsYouCount: 1,
      processCount: 0,
      isRunning: true,
    })).toBe('needs-you')
    expect(resolvePeekOverlay({
      needsYou: false,
      needsYouCount: 0,
      processCount: 0,
      isRunning: true,
    })).toBe('process')
    expect(resolvePeekOverlay({
      needsYou: false,
      needsYouCount: 0,
      processCount: 0,
      isRunning: true,
      liveText: '',
    })).toBe('process')
    expect(resolvePeekOverlay({
      needsYou: false,
      needsYouCount: 0,
      processCount: 0,
      isRunning: false,
      spoken: '表改完了',
    })).toBe('spoken')
  })
})
