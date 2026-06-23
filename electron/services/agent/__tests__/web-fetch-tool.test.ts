/**
 * web_fetch Agent 工具：LLM 不可控 max_bytes，避免 Content-Length 预判误杀
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../web-fetch.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../web-fetch.service')>()
  return {
    ...actual,
    webFetch: vi.fn(),
  }
})

import { webFetch } from '../../web-fetch.service'
import { executeWebFetch } from '../tools/web-fetch'
import type { ToolExecutorConfig } from '../tools/types'

describe('executeWebFetch', () => {
  const executor: ToolExecutorConfig = {
    addStep: vi.fn(),
  } as unknown as ToolExecutorConfig

  beforeEach(() => {
    vi.mocked(webFetch).mockReset()
    vi.mocked(webFetch).mockResolvedValue({
      url: 'https://example.com',
      finalUrl: 'https://example.com',
      status: 200,
      contentType: 'text/html',
      bytes: 1000,
      content: 'hello',
      truncated: false,
      backend: 'readability',
    })
    vi.mocked(executor.addStep).mockClear()
  })

  it('ignores max_bytes even if LLM still passes it', async () => {
    await executeWebFetch(
      { url: 'https://example.com/article', max_bytes: 10_000 },
      executor
    )

    expect(webFetch).toHaveBeenCalledWith({
      url: 'https://example.com/article',
      timeoutSec: undefined,
    })
    expect(webFetch).toHaveBeenCalledTimes(1)
  })
})
