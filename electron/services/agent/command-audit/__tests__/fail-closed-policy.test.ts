/**
 * Fail-Closed 策略：解析失败 / 未知命令 / 间接执行 / 动态路径 按 executionMode + riskPolicy 选档位
 */
import { describe, it, expect } from 'vitest'
import { resolveFailClosedLevel } from '../fail-closed-policy'
import type { AuditContext } from '../types'
import type { CommandRiskPolicy } from '@shared/types/agent'
import { DEFAULT_COMMAND_RISK_POLICY } from '@shared/types/agent'

describe('resolveFailClosedLevel', () => {
  it('默认（无 ctx）：均为 moderate（按 relaxed）', () => {
    expect(resolveFailClosedLevel('unknownCmd')).toBe('moderate')
    expect(resolveFailClosedLevel('parseFail')).toBe('moderate')
    expect(resolveFailClosedLevel('indirection')).toBe('moderate')
    expect(resolveFailClosedLevel('dynamicPath')).toBe('moderate')
  })

  it('strict 默认：均为 dangerous', () => {
    const ctx: AuditContext = { executionMode: 'strict' }
    expect(resolveFailClosedLevel('unknownCmd', ctx)).toBe('dangerous')
    expect(resolveFailClosedLevel('parseFail', ctx)).toBe('dangerous')
    expect(resolveFailClosedLevel('indirection', ctx)).toBe('dangerous')
    expect(resolveFailClosedLevel('dynamicPath', ctx)).toBe('dangerous')
  })

  it('free 跟随 relaxed 配置', () => {
    const ctx: AuditContext = { executionMode: 'free' }
    expect(resolveFailClosedLevel('unknownCmd', ctx)).toBe('moderate')
    expect(resolveFailClosedLevel('indirection', ctx)).toBe('moderate')
  })

  it('用户自定义 policy 覆盖默认（部分字段也可）', () => {
    const policy = {
      strictUnknownCmd: 'blocked',
      relaxedParseFail: 'dangerous',
      relaxedIndirection: 'dangerous',
    } as CommandRiskPolicy
    expect(resolveFailClosedLevel('unknownCmd', { executionMode: 'strict', riskPolicy: policy })).toBe('blocked')
    expect(resolveFailClosedLevel('parseFail', { executionMode: 'relaxed', riskPolicy: policy })).toBe('dangerous')
    expect(resolveFailClosedLevel('indirection', { executionMode: 'relaxed', riskPolicy: policy })).toBe('dangerous')
    // 未覆盖字段回退默认
    expect(resolveFailClosedLevel('dynamicPath', { executionMode: 'relaxed', riskPolicy: policy })).toBe(
      DEFAULT_COMMAND_RISK_POLICY.relaxedDynamicPath,
    )
  })
})
