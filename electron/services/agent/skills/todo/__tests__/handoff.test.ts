import { describe, it, expect } from 'vitest'
import type { TodoItem } from '@sailfish/shared-types'
import { buildTodoHandoffPrompt } from '../handoff'

const item: TodoItem = {
  id: 'todo-1',
  title: '给老王交预算表',
  description: '上周联络里提过，附件在桌面',
  status: 'pending',
  priority: 'high',
  dueDate: '2026-08-20T18:00:00.000Z',
  tags: ['财务'],
  createdAt: '2026-08-10T00:00:00.000Z',
  updatedAt: '2026-08-10T00:00:00.000Z',
  sources: [{
    id: 'src-1',
    kind: 'conversation',
    at: '2026-08-10T00:00:00.000Z',
    sessionId: 'sess-9',
  }],
  journal: [{
    id: 'j-1',
    kind: 'scheduled',
    at: '2026-08-16T00:00:00.000Z',
    start: '2026-08-18T14:00:00.000Z',
    end: '2026-08-18T15:00:00.000Z',
  }],
}

describe('buildTodoHandoffPrompt', () => {
  it('handle prompt carries verbatim fields and no SOP', () => {
    const prompt = buildTodoHandoffPrompt(item, 'handle', { locale: 'zh-CN' })
    expect(prompt).toContain('给老王交预算表')
    expect(prompt).toContain('上周联络里提过，附件在桌面')
    expect(prompt).toContain('todo-1')
    expect(prompt).toContain('sess-9')
    expect(prompt).toContain('2026-08-18T14:00:00.000Z')
    expect(prompt).not.toContain('不许假装')
    expect(prompt).not.toContain('三种')
    expect(prompt).not.toContain('别硬猜')
  })

  it('schedule prompt includes duration and no scheduling SOP', () => {
    const prompt = buildTodoHandoffPrompt(item, 'schedule', { locale: 'en-US', minutes: 60 })
    expect(prompt).toContain('60')
    expect(prompt).toContain('Help me schedule')
    expect(prompt).toContain('给老王交预算表')
    expect(prompt).not.toContain('9:00')
    expect(prompt).not.toContain('2–3')
    expect(prompt).not.toContain('2-3')
  })

  it('localizes url source kind', () => {
    const withUrl: TodoItem = {
      ...item,
      sources: [{
        id: 'src-2',
        kind: 'url',
        at: '2026-08-10T00:00:00.000Z',
        url: 'https://example.com',
      }],
    }
    expect(buildTodoHandoffPrompt(withUrl, 'handle', { locale: 'zh-CN' })).toContain('网页')
    expect(buildTodoHandoffPrompt(withUrl, 'handle', { locale: 'en-US' })).toContain('url')
  })
})
