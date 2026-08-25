/**
 * Gateway 插件路由安全边界集成测试
 *
 * 与 plugin-contract.test.ts 的纯函数测试互补：这里直接驱动 GatewayService 实例，
 * 通过真实 HTTP 请求验证「鉴权 -> 插件路由校验 -> 核心 handler」的完整链路，
 * 确保 Gateway 作为最终安全边界真的生效。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockLogError } = vi.hoisted(() => ({ mockLogError: vi.fn() }))

vi.mock('../../utils/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: mockLogError,
    debug: vi.fn()
  })
}))

// 模块加载层面打桩：这些重依赖不参与本测试的断言，仅避免 import 链拉进业务运行时
vi.mock('../web-chat.service', () => ({
  WebChatService: class {},
  VISIBLE_STEP_TYPES: new Set()
}))
vi.mock('../watch/store', () => ({ getWatchStore: () => ({}) }))
vi.mock('../sensor/event-bus', () => ({ getEventBus: () => ({ emit: vi.fn() }) }))

import { GatewayService } from '../gateway.service'
import type { HttpRouteEntry } from '../plugin/types'

const TEST_TOKEN = 'test-gateway-token'

function makeRoute(pluginId: string, method: string, path: string, handler?: HttpRouteEntry['handler']): HttpRouteEntry {
  return { pluginId, method, path, handler: handler ?? (() => {}) }
}

describe('Gateway 插件路由安全边界', () => {
  let service: GatewayService
  let baseUrl: string

  beforeEach(async () => {
    mockLogError.mockClear()
    service = new GatewayService()
    service.setDependencies({ webChatService: {} as never, mainWindow: null })
    const result = await service.start({ enabled: true, port: 0, host: '127.0.0.1', apiToken: TEST_TOKEN })
    expect(result.success).toBe(true)
    const address = (service as unknown as { server: { address(): { port: number } } }).server.address()
    baseUrl = `http://127.0.0.1:${address.port}`
  })

  afterEach(async () => {
    await service.stop()
  })

  function authHeader(): Record<string, string> {
    return { Authorization: `Bearer ${TEST_TOKEN}` }
  }

  it('registerPluginRoutes 拒绝伪造的核心路径 entry 和归属不一致的 entry', () => {
    service.registerPluginRoutes([
      makeRoute('evil', 'POST', '/api/chat'),
      makeRoute('evil', 'GET', '/api/plugins/victim/x'),
      makeRoute('evil', 'GET', '/api/plugins/evil/../x'),
      makeRoute('', 'GET', '/api/plugins/x/y'),
      makeRoute('good', 'GET', '/api/plugins/good/ok')
    ])

    const routes = (service as unknown as { pluginRoutes: HttpRouteEntry[] }).pluginRoutes
    expect(routes).toHaveLength(1)
    expect(routes[0].pluginId).toBe('good')
    // 每条非法 entry 都应产生一条错误日志
    expect(mockLogError).toHaveBeenCalledTimes(4)
  })

  it('带有效 token 的 POST /api/chat 进入核心 handler，伪造插件 handler 未被调用', async () => {
    const forgedHandler = vi.fn()
    service.registerPluginRoutes([makeRoute('evil', 'POST', '/api/chat', forgedHandler)])

    const coreSpy = vi
      .spyOn(service as never as { handleChatMessage: (req: unknown, res: { writeHead: (n: number, h: object) => void; end: (s: string) => void }) => void }, 'handleChatMessage')
      .mockImplementation((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ core: true }))
      })

    const res = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { ...authHeader(), 'Content-Type': 'application/json' },
      body: '{}'
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ core: true })
    expect(coreSpy).toHaveBeenCalledTimes(1)
    expect(forgedHandler).not.toHaveBeenCalled()
  })

  it('不带 token 请求插件 route 返回 401，插件 handler 未被调用', async () => {
    const pluginHandler = vi.fn((_req: unknown, res: { writeHead: (n: number) => void; end: () => void }) => {
      res.writeHead(200)
      res.end()
    })
    service.registerPluginRoutes([makeRoute('good', 'GET', '/api/plugins/good/probe', pluginHandler)])

    const res = await fetch(`${baseUrl}/api/plugins/good/probe`)

    expect(res.status).toBe(401)
    expect(pluginHandler).not.toHaveBeenCalled()
  })

  it('合法插件 route 在有效 token 下正常访问', async () => {
    service.registerPluginRoutes([
      makeRoute('good', 'GET', '/api/plugins/good/probe', (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ marker: 'PROBE_ROUTE_ACTIVE' }))
      })
    ])

    const res = await fetch(`${baseUrl}/api/plugins/good/probe`, { headers: authHeader() })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ marker: 'PROBE_ROUTE_ACTIVE' })
  })

  it('malformed entry 被安全拒绝，不抛异常，合法 entry 不受影响', () => {
    const malformed: unknown[] = [
      null,
      undefined,
      'not-an-object',
      { pluginId: 'good', method: 'GET', path: undefined, handler: () => {} },
      { pluginId: 'good', method: 'GET', path: '/api/plugins/good/x', handler: null },
      { pluginId: 'good', method: 123, path: '/api/plugins/good/x', handler: () => {} },
      { pluginId: 'good', method: 'GET', path: '/api/plugins/good/x' }, // 缺 handler
      { method: 'GET', path: '/api/plugins/good/x', handler: () => {} } // 缺 pluginId
    ]

    expect(() => {
      service.registerPluginRoutes([
        ...malformed,
        makeRoute('good', 'GET', '/api/plugins/good/ok')
      ] as HttpRouteEntry[])
    }).not.toThrow()

    const routes = (service as unknown as { pluginRoutes: HttpRouteEntry[] }).pluginRoutes
    expect(routes).toHaveLength(1)
    expect(routes[0].path).toBe('/api/plugins/good/ok')
    expect(mockLogError).toHaveBeenCalledTimes(malformed.length)
  })

  it('非数组 payload 不抛异常，不破坏已有路由表', () => {
    expect(() => {
      service.registerPluginRoutes(null as unknown as HttpRouteEntry[])
      service.registerPluginRoutes('garbage' as unknown as HttpRouteEntry[])
    }).not.toThrow()

    const routes = (service as unknown as { pluginRoutes: HttpRouteEntry[] }).pluginRoutes
    expect(routes).toHaveLength(0)
    expect(mockLogError).toHaveBeenCalledTimes(2)
  })

  it('同 method+path 冲突时只保留一个 owner，并记录冲突信息', () => {
    service.registerPluginRoutes([
      makeRoute('good', 'GET', '/api/plugins/good/x'),
      makeRoute('good', 'GET', '/api/plugins/good/x')
    ])

    const routes = (service as unknown as { pluginRoutes: HttpRouteEntry[] }).pluginRoutes
    expect(routes).toHaveLength(1)
    expect(mockLogError).toHaveBeenCalledTimes(1)
    // 错误日志必须包含冲突的 method+path 和 pluginId，便于定位双方
    const message = String(mockLogError.mock.calls[0][0])
    expect(message).toContain('GET /api/plugins/good/x')
    expect(message).toContain('good')
  })
})
