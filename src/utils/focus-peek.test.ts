import { describe, expect, it } from 'vitest'
import { lastSpokenBody, resolveFocusPeek } from './focus-peek'

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
