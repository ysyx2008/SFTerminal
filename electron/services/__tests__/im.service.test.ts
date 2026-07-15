import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { IMPlatform } from '../im/types'

const persistedState: { imLastContacts: Record<string, unknown> } = {
  imLastContacts: {}
}

vi.mock('../config.service', () => ({
  getConfigService: () => ({
    get: (key: string) => {
      if (key === 'imLastContacts') return persistedState.imLastContacts
      return undefined
    },
    set: (key: string, value: Record<string, unknown>) => {
      if (key === 'imLastContacts') persistedState.imLastContacts = value
    }
  })
}))

vi.mock('../agent/i18n', () => ({
  t: (key: string) => key
}))

import {
  IMService,
  type IMLastContact,
  isImDeliveryToolFailure,
  formatImDeliveryToolFailure,
  IM_SKIP_PROCESS_NOTIFY_TOOLS,
  prepareImAgentMedia,
} from '../im/im.service'

type MockAdapter = {
  isConnected: ReturnType<typeof vi.fn>
  sendText: ReturnType<typeof vi.fn>
  sendMarkdown: ReturnType<typeof vi.fn>
}

function createContact(platform: IMPlatform, updatedAt: number): IMLastContact {
  return {
    platform,
    replyContext: { chatId: `${platform}-chat` },
    userId: 'user-1',
    userName: 'single-user',
    chatId: `${platform}-chat`,
    chatType: 'single',
    updatedAt
  }
}

function createAdapter(connected: boolean): MockAdapter {
  return {
    isConnected: vi.fn().mockReturnValue(connected),
    sendText: vi.fn().mockResolvedValue(undefined),
    sendMarkdown: vi.fn().mockResolvedValue(undefined)
  }
}

describe('IM_SKIP_PROCESS_NOTIFY_TOOLS', () => {
  it('excludes self-delivering tools from process notifications', () => {
    expect(IM_SKIP_PROCESS_NOTIFY_TOOLS.has('talk_to_user')).toBe(true)
    expect(IM_SKIP_PROCESS_NOTIFY_TOOLS.has('ask_user')).toBe(true)
    expect(IM_SKIP_PROCESS_NOTIFY_TOOLS.has('load_skill')).toBe(false)
  })
})

describe('IM delivery tool failure helpers', () => {
  it('detects send_file_to_chat failure by success flag', () => {
    expect(isImDeliveryToolFailure({
      toolName: 'send_file_to_chat',
      success: false,
      content: '❌ 文件发送失败',
    })).toBe(true)
  })

  it('ignores unrelated tool failures', () => {
    expect(isImDeliveryToolFailure({
      toolName: 'read_file',
      success: false,
      content: '❌',
    })).toBe(false)
  })

  it('formatImDeliveryToolFailure prefers step content', () => {
    expect(formatImDeliveryToolFailure({
      toolName: 'send_file_to_chat',
      content: '❌ 文件发送失败: errcode=-2',
      toolResult: 'ignored',
    })).toBe('❌ 文件发送失败: errcode=-2')
  })
})

describe('prepareImAgentMedia', () => {
  const tmpDirs: string[] = []

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  function writeTempFile(name: string, data: Buffer): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'im-media-'))
    tmpDirs.push(dir)
    const filePath = path.join(dir, name)
    fs.writeFileSync(filePath, data)
    return filePath
  }

  it('inlines vision images as data URLs and skips attachment chips', () => {
    // Minimal JPEG-like payload (content doesn't need to decode for this test)
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9, 0x00, 0x01, 0x02])
    const localPath = writeTempFile('wechat_image.jpg', jpeg)

    const result = prepareImAgentMedia([{
      type: 'image',
      localPath,
      fileName: 'wechat_image.jpg',
    }])

    expect(result.images).toHaveLength(1)
    expect(result.images[0]).toMatch(/^data:image\/jpeg;base64,/)
    expect(result.attachments).toHaveLength(0)
    expect(result.inlinedImagePaths.has(localPath)).toBe(true)
  })

  it('keeps non-image files as attachment chips', () => {
    const localPath = writeTempFile('notes.txt', Buffer.from('hello'))

    const result = prepareImAgentMedia([{
      type: 'file',
      localPath,
      fileName: 'notes.txt',
    }])

    expect(result.images).toHaveLength(0)
    expect(result.attachments).toEqual([{
      filename: 'notes.txt',
      filePath: localPath,
      fileSize: 5,
      fileType: 'txt',
    }])
    expect(result.inlinedImagePaths.size).toBe(0)
  })

  it('falls back to attachment chip when image file is missing', () => {
    const missing = path.join(os.tmpdir(), `im-missing-${Date.now()}.png`)

    const result = prepareImAgentMedia([{
      type: 'image',
      localPath: missing,
      fileName: 'gone.png',
    }])

    expect(result.images).toHaveLength(0)
    expect(result.attachments).toHaveLength(1)
    expect(result.attachments[0].filename).toBe('gone.png')
    expect(result.inlinedImagePaths.size).toBe(0)
  })
})

describe('IMService proactive notification routing', () => {
  beforeEach(() => {
    persistedState.imLastContacts = {}
    vi.clearAllMocks()
  })

  it('上次是钉钉但当前仅飞书在线时，应自动切换到飞书发送', async () => {
    const service = new IMService() as any
    const dingtalkAdapter = createAdapter(false)
    const feishuAdapter = createAdapter(true)

    service.dingtalkAdapter = dingtalkAdapter
    service.feishuAdapter = feishuAdapter

    const now = Date.now()
    const dingtalkContact = createContact('dingtalk', now - 10_000)
    const feishuContact = createContact('feishu', now - 5_000)

    service.lastContact = dingtalkContact
    service.contactsByPlatform = {
      dingtalk: dingtalkContact,
      feishu: feishuContact
    }

    const result = await service.sendNotification('hello')

    expect(result.success).toBe(true)
    expect(result.platform).toBe('feishu')
    expect(feishuAdapter.sendText).toHaveBeenCalledTimes(1)
    expect(dingtalkAdapter.sendText).not.toHaveBeenCalled()
  })

  it('lastContact 平台在线时应优先该平台，不跨渠道跳转', async () => {
    const service = new IMService() as any
    const dingtalkAdapter = createAdapter(true)
    const feishuAdapter = createAdapter(true)

    service.dingtalkAdapter = dingtalkAdapter
    service.feishuAdapter = feishuAdapter

    const now = Date.now()
    const dingtalkContact = createContact('dingtalk', now - 10_000)
    const feishuContact = createContact('feishu', now - 1_000)

    service.lastContact = dingtalkContact
    service.contactsByPlatform = {
      dingtalk: dingtalkContact,
      feishu: feishuContact
    }

    const result = await service.sendNotification('hello')

    expect(result.success).toBe(true)
    expect(result.platform).toBe('dingtalk')
    expect(dingtalkAdapter.sendText).toHaveBeenCalledTimes(1)
    expect(feishuAdapter.sendText).not.toHaveBeenCalled()
  })
})
