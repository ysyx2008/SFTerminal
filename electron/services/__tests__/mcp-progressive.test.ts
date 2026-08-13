/**
 * MCP 渐进披露：按 server 整包 load + 始终 defer；whenToUse 目录
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn().mockReturnValue('/tmp/sft-mcp-test'),
    getName: vi.fn().mockReturnValue('SailFish'),
    getVersion: vi.fn().mockReturnValue('1.0.0')
  }
}))

import {
  McpToolSession,
  toMcpSkillId,
  parseMcpSkillId
} from '../agent/mcp-tool-session'
import { McpService, type McpTool, type McpServerConfig } from '../mcp.service'

function makeTool(partial: Partial<McpTool> & Pick<McpTool, 'serverId' | 'serverName' | 'name'>): McpTool {
  return {
    description: partial.description || '',
    title: partial.title,
    inputSchema: partial.inputSchema || { type: 'object', properties: {} },
    ...partial
  }
}

describe('McpToolSession server sticky', () => {
  it('loadServer 可累积多家，不逐出', () => {
    const session = new McpToolSession()
    for (let i = 0; i < 5; i++) {
      expect(session.loadServer(`s${i}`)).toBe(true)
    }
    expect(session.getLoadedServerIds()).toEqual(['s0', 's1', 's2', 's3', 's4'])
    expect(session.loadServer('s0')).toBe(false)
  })

  it('unloadServer 移除单家', () => {
    const session = new McpToolSession()
    session.loadServer('a')
    session.loadServer('b')
    expect(session.unloadServer('a')).toBe(true)
    expect(session.getLoadedServerIds()).toEqual(['b'])
    expect(session.unloadServer('a')).toBe(false)
  })

  it('clear 清空', () => {
    const session = new McpToolSession()
    session.loadServer('x')
    session.clear()
    expect(session.getLoadedServerIds()).toEqual([])
  })
})

describe('mcp skill id helpers', () => {
  it('toMcpSkillId / parseMcpSkillId', () => {
    expect(toMcpSkillId('qcc')).toBe('mcp:qcc')
    expect(parseMcpSkillId('mcp:qcc')).toBe('qcc')
    expect(parseMcpSkillId('excel')).toBeNull()
  })
})

describe('McpService progressive helpers', () => {
  let mcp: McpService

  beforeEach(() => {
    mcp = new McpService()
    const tools: McpTool[] = [
      makeTool({
        serverId: 'qcc_risk',
        serverName: '企查查-风险信息',
        name: 'equity_penetration',
        description: '股权穿透'
      }),
      makeTool({
        serverId: 'qcc_risk',
        serverName: '企查查-风险信息',
        name: 'lawsuit_list',
        description: '裁判文书'
      }),
      makeTool({
        serverId: 'miaoxiang',
        serverName: '妙想MCP',
        name: 'stock_quote',
        description: '行情'
      })
    ]
    ;(mcp as unknown as { connections: Map<string, unknown> }).connections = new Map([
      [
        'qcc_risk',
        {
          config: { id: 'qcc_risk', name: '企查查-风险信息' },
          tools: tools.filter(t => t.serverId === 'qcc_risk'),
          resources: [],
          prompts: []
        }
      ],
      [
        'miaoxiang',
        {
          config: {
            id: 'miaoxiang',
            name: '妙想MCP',
            whenToUse: '查 A 股行情与研报，勿用网页搜索代替'
          },
          tools: tools.filter(t => t.serverId === 'miaoxiang'),
          resources: [],
          prompts: []
        }
      ]
    ])
  })

  it('shouldDeferTools：有已连接 MCP 即 true', () => {
    expect(mcp.getConnectedToolCount()).toBe(3)
    expect(mcp.shouldDeferTools()).toBe(true)
    const empty = new McpService()
    expect(empty.shouldDeferTools()).toBe(false)
  })

  it('resolveServerRef 支持 id、mcp:id 与名称', () => {
    expect(mcp.resolveServerRef('qcc_risk')?.name).toBe('企查查-风险信息')
    expect(mcp.resolveServerRef('mcp:qcc_risk')?.serverId).toBe('qcc_risk')
    expect(mcp.resolveServerRef('企查查-风险信息')?.serverId).toBe('qcc_risk')
    expect(mcp.resolveServerRef('不存在')).toBeNull()
  })

  it('getToolDefinitionsByServerIds 整包返回该服工具', () => {
    const defs = mcp.getToolDefinitionsByServerIds(['qcc_risk'])
    expect(defs).toHaveLength(2)
    expect(defs.every(d => d.function.name.startsWith('mcp_'))).toBe(true)
  })

  it('getServerCatalogText 含 mcp: skill id；无 whenToUse 时列工具名', () => {
    const text = mcp.getServerCatalogText()
    expect(text).toContain('mcp:qcc_risk')
    expect(text).toContain('企查查-风险信息')
    expect(text).toContain('equity_penetration')
  })

  it('getServerCatalogText 优先 whenToUse', () => {
    const text = mcp.getServerCatalogText()
    expect(text).toContain('mcp:miaoxiang')
    expect(text).toContain('查 A 股行情与研报')
    expect(text).not.toContain('stock_quote')
  })

  it('getServerCatalogText 工具有 title 时优先展示 title（无 whenToUse）', () => {
    const conn = (mcp as unknown as { connections: Map<string, { tools: McpTool[]; config: { whenToUse?: string } }> }).connections.get('qcc_risk')!
    conn.tools.push(
      makeTool({
        serverId: 'qcc_risk',
        serverName: '企查查-风险信息',
        name: 'kline_query',
        title: 'K线查询'
      })
    )
    const text = mcp.getServerCatalogText()
    expect(text).toContain('K线查询')
    expect(text).not.toContain('kline_query')
  })

  it('getServerCatalogText 空 connections 返回占位文案', () => {
    const empty = new McpService()
    expect(empty.getServerCatalogText()).toBe('（当前无已连接 MCP 连接器）')
  })

  it('getServerCatalogText 空工具 server 标注（无工具）', () => {
    const conn = (mcp as unknown as { connections: Map<string, { tools: McpTool[]; config: Record<string, unknown> }> }).connections.get('qcc_risk')!
    conn.tools = []
    conn.config = { id: 'qcc_risk', name: '企查查-风险信息' }
    const text = mcp.getServerCatalogText()
    expect(text).toContain('mcp:qcc_risk（企查查-风险信息）：（无工具）')
  })
})

describe('findConfiguredServer / ensureConnected', () => {
  const configs: McpServerConfig[] = [
    { id: '6ea45bfe-9a56-4014-8ab0-8ce0df5e1884', name: '烯牛数据', enabled: true, transport: 'http', url: 'https://example.com/mcp' },
    { id: 'qcc', name: '企查查', enabled: false, transport: 'stdio', command: 'npx' }
  ]

  it('匹配 id、mcp:id、显示名；未命中返回 null', () => {
    const mcp = new McpService()
    expect(mcp.findConfiguredServer('6ea45bfe-9a56-4014-8ab0-8ce0df5e1884', configs)?.name).toBe('烯牛数据')
    expect(mcp.findConfiguredServer('mcp:6ea45bfe-9a56-4014-8ab0-8ce0df5e1884', configs)?.id)
      .toBe('6ea45bfe-9a56-4014-8ab0-8ce0df5e1884')
    expect(mcp.findConfiguredServer('烯牛数据', configs)?.id).toBe('6ea45bfe-9a56-4014-8ab0-8ce0df5e1884')
    expect(mcp.findConfiguredServer('不存在', configs)).toBeNull()
    expect(mcp.findConfiguredServer('  ', configs)).toBeNull()
  })

  it('ensureConnected 已连接时不重连', async () => {
    const mcp = new McpService()
    ;(mcp as unknown as { connections: Map<string, unknown> }).connections = new Map([
      ['xiniu', { config: { id: 'xiniu', name: '烯牛数据' }, tools: [], resources: [], prompts: [] }]
    ])
    const connect = vi.spyOn(mcp, 'connect').mockResolvedValue()
    await mcp.ensureConnected({
      id: 'xiniu',
      name: '烯牛数据',
      enabled: true,
      transport: 'http',
      url: 'https://example.com/mcp'
    })
    expect(connect).not.toHaveBeenCalled()
  })

  it('ensureConnected 未连接时调用 connect', async () => {
    const mcp = new McpService()
    const connect = vi.spyOn(mcp, 'connect').mockResolvedValue()
    const cfg = {
      id: 'xiniu',
      name: '烯牛数据',
      enabled: true,
      transport: 'http' as const,
      url: 'https://example.com/mcp'
    }
    await mcp.ensureConnected(cfg)
    expect(connect).toHaveBeenCalledWith(cfg)
  })

  it('ensureConnected 并发共用一次 connect', async () => {
    const mcp = new McpService()
    let resolveConnect!: () => void
    const connect = vi.spyOn(mcp, 'connect').mockImplementation(
      () => new Promise<void>(r => { resolveConnect = r })
    )
    const cfg = {
      id: 'xiniu',
      name: '烯牛数据',
      enabled: true,
      transport: 'http' as const,
      url: 'https://example.com/mcp'
    }
    const a = mcp.ensureConnected(cfg)
    const b = mcp.ensureConnected(cfg)
    expect(connect).toHaveBeenCalledTimes(1)
    resolveConnect()
    await Promise.all([a, b])
    expect(connect).toHaveBeenCalledTimes(1)
  })
})
