/**
 * 上下文装配「路径等价性」测试
 *
 * Agent.buildContext 有两条产出 run.messages 的路径：
 *   - cache path：复用 Conversation 的 cache 前缀快照 + 追加新 user 消息
 *   - cold start：system prompt + TaskMemory 原文重装 + 新 user 消息
 *
 * 2026-09-04：冷启动重装原文时不再把历史图片整场塞回去（文字和路径留下）。
 * 还在这场接着聊（cache path）或从交接检查点接着时，模型已经接受过的前缀原样带着。
 * 本文件锚定这两条路径对图的不同承诺，禁止后来人再把冷启动保图加回去。
 *
 * 在领域层（Conversation + context-builder）镜像两条路径的装配结果，纯单测，
 * 不启动 Agent、不碰磁盘。
 */
import { describe, it, expect } from 'vitest'
import { Conversation } from '../../conversation/conversation'
import { buildRecentTasksContext } from '../context-builder'
import type { AgentStep } from '../types'
import type { AiMessage } from '../../ai.service'

const IMG = 'data:image/png;base64,AAA'

const userStep = (content: string): AgentStep =>
  ({ id: `u_${content}`, type: 'user_task', content, timestamp: Date.now() } as AgentStep)
const finalStep = (content: string): AgentStep =>
  ({ id: `f_${content}`, type: 'final_result', content, timestamp: Date.now() } as AgentStep)

/**
 * 模拟一轮纯对话 run 的提交。忠实对齐 agent 的实际行为：
 * - runMessages = 前轮 cache 前缀 + 本轮 user 消息（cache path 下发给模型的完整序列；
 *   最终纯文本回复不在其中，由 commitRun 以 finalMsg 补进快照）
 * - taskMessageLog = 仅本轮消息（不含前缀）
 * - user 消息 content 是 buildUserMessage 增强后的组合文本（≠ userRequest 原文）
 */
function commitTurn(
  conv: Conversation,
  runId: string,
  userRequest: string,
  opts: { images?: string[]; reply: string; imagesStripped?: boolean },
): void {
  const prev = conv.getCachePrefix() ?? []
  const userMsg: AiMessage = {
    role: 'user',
    content: `<system_context>\nterminal: local\n</system_context>\n\n${userRequest}`,
    ...(opts.images ? { images: opts.images } : {}),
  }
  conv.commitRun({
    runId,
    userRequest,
    steps: [userStep(userRequest), finalStep(opts.reply)],
    taskMessageLog: [userMsg],
    runMessages: [...prev, userMsg],
    taskStatus: 'success',
    result: opts.reply,
    imagesStripped: opts.imagesStripped,
  })
}

/** cache path 的装配结果 = cache 前缀快照 + 新 user 消息 */
function assembleViaCachePath(conv: Conversation, newUserContent: string): AiMessage[] {
  const prefix = conv.getCachePrefix()
  if (!prefix) throw new Error('expected cache prefix to exist')
  return [...prefix, { role: 'user', content: newUserContent }]
}

/** cold start 的装配结果 = TaskMemory 渐进压缩重建出的历史消息 */
function assembleViaColdStart(conv: Conversation): AiMessage[] {
  return buildRecentTasksContext(conv.taskMemory, 1_000_000).recentTaskMessages
}

function hasImages(messages: AiMessage[]): boolean {
  return messages.some(m => !!m.images && m.images.length > 0)
}

describe('上下文装配路径等价性（cache path vs cold start）', () => {
  it('上一轮刚发图：还在这场接着聊时图还在，冷启动重装不再塞回去', () => {
    const conv = Conversation.create({ agentKey: '__companion__', terminalType: 'assistant' })
    commitTurn(conv, 'r1', '看这张图', { images: [IMG], reply: '这是一只猫' })

    expect(hasImages(assembleViaCachePath(conv, '它可爱吗'))).toBe(true)
    expect(hasImages(assembleViaColdStart(conv))).toBe(false)
    expect(assembleViaColdStart(conv).some(m => m.content.includes('看这张图') || m.content === '看这张图')).toBe(true)
  })

  it('图在两轮前：cache 前缀仍带图，冷启动重装只留文字', () => {
    const conv = Conversation.create({ agentKey: '__companion__', terminalType: 'assistant' })
    commitTurn(conv, 'r1', '看这张图', { images: [IMG], reply: '这是一只猫' })
    commitTurn(conv, 'r2', '它几岁了', { reply: '看起来两岁' })

    const viaCache = assembleViaCachePath(conv, '再说说它的眼睛')
    const viaCold = assembleViaColdStart(conv)
    expect(hasImages(viaCache)).toBe(true)
    expect(hasImages(viaCold)).toBe(false)

    expect(viaCache.filter(m => m.role === 'user')).toHaveLength(3) // 2 轮历史 + 本轮新消息
    expect(viaCold.filter(m => m.role === 'user')).toHaveLength(2)
  })

  it('剥图降级后：cache 前缀剔图自愈，冷启动重装也不再把图塞回去', () => {
    const conv = Conversation.create({ agentKey: '__companion__', terminalType: 'assistant' })
    commitTurn(conv, 'r1', '看这张图', { images: [IMG], reply: '画面没传过来', imagesStripped: true })

    expect(hasImages(assembleViaCachePath(conv, '现在能看到吗'))).toBe(false)
    expect(hasImages(assembleViaColdStart(conv))).toBe(false)
  })
})
