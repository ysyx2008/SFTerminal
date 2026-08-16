import { describe, it, expect } from 'vitest'
import { parseLogLineTime, selectLogLines, truncateLogLine } from '../log-window'

describe('日志行时间', () => {
  it('读本应用的时刻前缀，日期来自日志文件名', () => {
    const ms = parseLogLineTime('[16:12:58.135] [info]  (Agent) search_history', '2026-08-16')
    expect(ms).toBe(Date.parse('2026-08-16T16:12:58.135'))
  })

  it('读带日期的完整前缀', () => {
    const ms = parseLogLineTime('[2026-08-16 16:01:22.292] [info] ready')
    expect(ms).toBe(Date.parse('2026-08-16T16:01:22.292'))
  })

  it('读这次启动写下的 App Started 时间', () => {
    const ms = parseLogLineTime(
      '[16:13:06.916] [info]  ========== App Started | v11.6.0 | 2026-08-16T08:13:06.916Z ==========',
      '2026-08-16'
    )
    expect(ms).toBe(Date.parse('2026-08-16T08:13:06.916Z'))
  })
})

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0')
}

/** 把 UTC 瞬间格式化成本机日志那种「只有时刻」的前缀，测试不绑死在东八区 */
function localClock(iso: string): string {
  const d = new Date(iso)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
}

function localFileDate(iso: string): string {
  const d = new Date(iso)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

describe('崩前日志窗口', () => {
  const from = '2026-08-16T08:11:48.000Z'
  const mid = '2026-08-16T08:12:54.000Z'
  const crash = '2026-08-16T08:12:58.135Z'
  const dying = '2026-08-16T08:13:00.000Z'
  const to = '2026-08-16T08:13:06.916Z'
  const after = '2026-08-16T08:13:10.000Z'
  const later = '2026-08-16T08:13:12.000Z'
  const fileDate = localFileDate(from)
  const previousRun = [
    `[${localClock(from)}] [info]  ========== App Started | v11.6.0 | ${from} ==========`,
    `[${localClock(mid)}] [info]  (Agent) 帮我办`,
    `[${localClock(crash)}] [info]  (Agent) search_history 语义搜索`,
    `[${localClock(dying)}] [error] 主进程即将消失`,
  ].join('\n')
  const thisRun = [
    `[${localClock(to)}] [info]  ========== App Started | v11.6.0 | ${to} ==========`,
    `[${localClock(after)}] [error] MCP prompts/list 失败 java.lang.NullPointerException`,
    `[${localClock(later)}] [info]  已连接妙想 MCP`,
  ].join('\n')

  it('补报上次异常退出时，只取上次运行时间窗内的行，不要这次启动后的 MCP 噪音', () => {
    const lines = selectLogLines(
      [{ text: `${previousRun}\n${thisRun}`, fileDate }],
      {
        window: { from, to },
      }
    )
    expect(lines.some(l => l.includes('search_history'))).toBe(true)
    expect(lines.some(l => l.includes('帮我办'))).toBe(true)
    expect(lines.some(l => l.includes('MCP'))).toBe(false)
  })

  it('时间戳对不上时，用最后一次 App Started 当界', () => {
    const lines = selectLogLines(
      [{ text: `${previousRun}\n${thisRun}` }],
      { window: { to: 'not-a-date' } }
    )
    expect(lines.some(l => l.includes('search_history'))).toBe(true)
    expect(lines.some(l => l.includes('MCP'))).toBe(false)
  })

  it('没有窗口时仍取尾部——当场崩溃用得上', () => {
    const lines = selectLogLines([{ text: `${previousRun}\n${thisRun}`, fileDate }])
    expect(lines.at(-1)).toContain('妙想 MCP')
  })

  it('超长单行截断，避免整段堆栈进摘要', () => {
    expect(truncateLogLine('x'.repeat(300)).length).toBe(241)
    expect(truncateLogLine('x'.repeat(300)).endsWith('…')).toBe(true)
  })
})
