import { describe, it, expect } from 'vitest'
import { buildRedactor } from '../redact'

describe('脱敏', () => {
  it('家目录换成 ~，路径分隔符与大小写都不影响', () => {
    const redact = buildRedactor({ homeDir: 'C:\\Users\\Alice' })
    expect(redact('读取 C:\\Users\\Alice\\AppData\\log.txt 失败')).toBe('读取 ~\\AppData\\log.txt 失败')
    expect(redact('读取 c:/users/alice/AppData 失败')).toBe('读取 ~/AppData 失败')
  })

  it('登录名与主机名换成占位符', () => {
    const redact = buildRedactor({ homeDir: '/Users/alice', hostName: 'alice-macbook', userName: 'alice' })
    expect(redact('/Users/alice/x 由 alice 在 alice-macbook 上打开'))
      .toBe('~/x 由 <USER> 在 <HOST> 上打开')
  })

  it('长值先换，短值是长值子串时不会把长值拆坏', () => {
    // 登录名是主机名的子串，若先换短的，主机名就再也匹配不上了
    const redact = buildRedactor({ hostName: 'alice-macbook', userName: 'alice' })
    expect(redact('host=alice-macbook user=alice')).toBe('host=<HOST> user=<USER>')
  })

  it('过短的值不替换，避免波及无关文本', () => {
    const redact = buildRedactor({ userName: 'yu' })
    expect(redact('yu 的 yubikey 与 yunpan')).toBe('yu 的 yubikey 与 yunpan')
  })

  it('已配置的远端主机与登录名也脱敏', () => {
    const redact = buildRedactor({ values: ['prod-db-01.internal', 'deployer'] })
    expect(redact('ssh deployer@prod-db-01.internal')).toBe('ssh <REDACTED>@<REDACTED>')
  })

  it('日志里意外打印的密钥被兜住', () => {
    const redact = buildRedactor({})
    expect(redact('key=sk-abcdefghijklmnopqrstuvwxyz123')).toBe('key=<REDACTED-KEY>')
    expect(redact('Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'))
      .toBe('Authorization: Bearer <REDACTED-KEY>')
    expect(redact('https://vip.example.com/mcp?api_key=xn_4147eaf4d25e118cde1d9806cd5a44f4'))
      .toBe('https://vip.example.com/mcp?api_key=<REDACTED-KEY>')
  })

  it('没有已知真实值时不动文本', () => {
    expect(buildRedactor({})('普通日志一行')).toBe('普通日志一行')
  })
})
