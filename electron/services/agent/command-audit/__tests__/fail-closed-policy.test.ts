/**
 * Fail-Closed 策略：解析失败 / 未知命令 按 executionMode + riskPolicy 选档位
 */
import { describe, it, expect } from 'vitest'
import { resolveFailClosedLevel } from '../fail-closed-policy'
import type { AuditContext } from '../types'
import type { CommandRiskPolicy } from '@shared/types/agent'
import { DEFAULT_COMMAND_RISK_POLICY } from '@shared/types/agent'

describe('resolveFailClosedLevel', () => {
  it('默认（无 ctx）：未知命令 / 解析失败 都是 moderate（按 relaxed）', () => {
    expect(resolveFailClosedLevel('unknownCmd')).toBe('moderate')
    expect(resolveFailClosedLevel('parseFail')).toBe('moderate')
  })

  it('strict 默认：未知命令 / 解析失败 都是 dangerous', () => {
    const ctx: AuditContext = { executionMode: 'strict' }
    expect(resolveFailClosedLevel('unknownCmd', ctx)).toBe('dangerous')
    expect(resolveFailClosedLevel('parseFail', ctx)).toBe('dangerous')
  })

  it('relaxed 默认：未知命令 / 解析失败 都是 moderate', () => {
    const ctx: AuditContext = { executionMode: 'relaxed' }
    expect(resolveFailClosedLevel('unknownCmd', ctx)).toBe('moderate')
    expect(resolveFailClosedLevel('parseFail', ctx)).toBe('moderate')
  })

  it('free 跟随 relaxed 配置', () => {
    const ctx: AuditContext = { executionMode: 'free' }
    expect(resolveFailClosedLevel('unknownCmd', ctx)).toBe('moderate')
    expect(resolveFailClosedLevel('parseFail', ctx)).toBe('moderate')
  })

  it('用户自定义 policy 覆盖默认', () => {
    const policy: CommandRiskPolicy = {
      ...DEFAULT_COMMAND_RISK_POLICY,
      strictUnknownCmd: 'blocked',
      relaxedParseFail: 'dangerous',
    }
    expect(resolveFailClosedLevel('unknownCmd', { executionMode: 'strict', riskPolicy: policy })).toBe('blocked')
    expect(resolveFailClosedLevel('parseFail', { executionMode: 'relaxed', riskPolicy: policy })).toBe('dangerous')
    // free 跟随 relaxed
    expect(resolveFailClosedLevel('parseFail', { executionMode: 'free', riskPolicy: policy })).toBe('dangerous')
  })
})
