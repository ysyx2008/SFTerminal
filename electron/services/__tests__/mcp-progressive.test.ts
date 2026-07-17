/**
 * MCP 渐进披露：按 server 整包 load + 阈值
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
  MCP_PRELOAD_THRESHOLD
} from '../agent/mcp-tool-session'
import { McpService, type McpTool } from '../mcp.service'

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

  it('clear 清空', () => {
    const session = new McpToolSession()
    session.loadServer('x')
    session.clear()
    expect(session.getLoadedServerIds()).toEqual([])
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
          config: { id: 'miaoxiang', name: '妙想MCP' },
          tools: tools.filter(t => t.serverId === 'miaoxiang'),
          resources: [],
          prompts: []
        }
      ]
    ])
  })

  it('shouldDeferTools 阈值', () => {
    expect(mcp.getConnectedToolCount()).toBe(3)
    expect(mcp.shouldDeferTools()).toBe(3 > MCP_PRELOAD_THRESHOLD)
    const conn = (mcp as unknown as { connections: Map<string, { tools: McpTool[] }> }).connections.get('qcc_risk')!
    for (let i = 0; i < MCP_PRELOAD_THRESHOLD; i++) {
      conn.tools.push(
        makeTool({
          serverId: 'qcc_risk',
          serverName: '企查查-风险信息',
          name: `extra_${i}`,
          description: `e${i}`
        })
      )
    }
    expect(mcp.shouldDeferTools()).toBe(true)
  })

  it('resolveServerRef 支持 id 与名称', () => {
    expect(mcp.resolveServerRef('qcc_risk')?.name).toBe('企查查-风险信息')
    expect(mcp.resolveServerRef('企查查-风险信息')?.serverId).toBe('qcc_risk')
    expect(mcp.resolveServerRef('不存在')).toBeNull()
  })

  it('getToolDefinitionsByServerIds 整包返回该服工具', () => {
    const defs = mcp.getToolDefinitionsByServerIds(['qcc_risk'])
    expect(defs).toHaveLength(2)
    expect(defs.every(d => d.function.name.startsWith('mcp_'))).toBe(true)
  })

  it('getServerCatalogText 含目录', () => {
    const text = mcp.getServerCatalogText()
    expect(text).toContain('企查查-风险信息')
    expect(text).toContain('2 个工具')
  })
})
