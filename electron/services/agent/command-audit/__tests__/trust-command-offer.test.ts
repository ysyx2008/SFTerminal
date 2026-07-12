import { describe, it, expect } from 'vitest'
import type { CommandRiskAssessment } from '../types'
import { resolveTrustCommandOffer } from '../trust-command-offer'

function assessment(partial: Partial<CommandRiskAssessment> & Pick<CommandRiskAssessment, 'calls'>): CommandRiskAssessment {
  return {
    level: 'moderate',
    parsed: true,
    ...partial,
  }
}

describe('resolveTrustCommandOffer', () => {
  it('未知单命令提供 moderate 要约', () => {
    const offer = resolveTrustCommandOffer(
      assessment({
        calls: [{
          level: 'moderate',
          commandLevel: 'moderate',
          reasons: ['unknown'],
          unknown: true,
          cmd: 'fd',
          inferredWritesTo: false,
        }],
      }),
      'moderate',
    )
    expect(offer).toEqual({
      cmd: 'fd',
      writesTo: false,
      baseLevel: 'moderate',
    })
  })

  it('写重定向推断 writesTo', () => {
    const offer = resolveTrustCommandOffer(
      assessment({
        calls: [{
          level: 'dangerous',
          commandLevel: 'moderate',
          reasons: ['unknown'],
          unknown: true,
          cmd: 'mycli',
          inferredWritesTo: true,
        }],
      }),
      'dangerous',
    )
    expect(offer?.writesTo).toBe(true)
  })

  it('内置命令不提供（即便误标 unknown）', () => {
    const offer = resolveTrustCommandOffer(
      assessment({
        calls: [{
          level: 'moderate',
          commandLevel: 'moderate',
          reasons: ['x'],
          unknown: true,
          cmd: 'rm',
        }],
      }),
      'moderate',
    )
    expect(offer).toBeNull()
  })

  it('多子命令不提供', () => {
    const offer = resolveTrustCommandOffer(
      assessment({
        calls: [
          {
            level: 'moderate',
            commandLevel: 'moderate',
            reasons: ['a'],
            unknown: true,
            cmd: 'fd',
          },
          {
            level: 'safe',
            commandLevel: 'safe',
            reasons: ['b'],
            cmd: 'head',
          },
        ],
      }),
      'moderate',
    )
    expect(offer).toBeNull()
  })

  it('解析失败 / blocked 不提供', () => {
    expect(resolveTrustCommandOffer(
      assessment({
        parsed: false,
        calls: [{
          level: 'dangerous',
          commandLevel: 'dangerous',
          reasons: ['parse'],
          unknown: true,
          cmd: 'fd',
        }],
      }),
      'dangerous',
    )).toBeNull()

    expect(resolveTrustCommandOffer(
      assessment({
        calls: [{
          level: 'blocked',
          commandLevel: 'blocked',
          reasons: ['x'],
          unknown: true,
          cmd: 'fd',
        }],
      }),
      'blocked',
    )).toBeNull()
  })

  it('非 unknown 不提供', () => {
    expect(resolveTrustCommandOffer(
      assessment({
        calls: [{
          level: 'moderate',
          commandLevel: 'moderate',
          reasons: ['flag'],
          cmd: 'fd',
        }],
      }),
      'moderate',
    )).toBeNull()
  })
})
