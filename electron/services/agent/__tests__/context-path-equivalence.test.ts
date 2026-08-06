/**
 * 上下文装配「路径等价性」测试
 *
 * Agent.buildContext 有两条产出 run.messages 的路径：
 *   - cache path：复用 Conversation 的 cache 前缀快照 + 追加新 user 消息
 *   - cold start：system prompt + TaskMemory 渐进压缩（L0–L4）重建 + 新 user 消息
 *
 * 契约：同一份会话历史，无论下一轮走哪条路径，**视觉模型已接受的图片都必须
 * 呈现给模型**。2026-08-06 回归（续聊丢图）就是冷启动在 L1/L2 压缩时剥掉
 * 历史图、而 cache path 保留——两条路径保真度不等价且无人断言，bug 拖了
 * 两天才被发现。本文件把这条等价性固化为测试（agent/SPEC: 跨模型带图）。
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
  it('上一轮刚发图（taskIndex 0）：两条路径都必须把图呈现给模型', () => {
    const conv = Conversation.create({ agentKey: '__companion__', terminalType: 'assistant' })
    commitTurn(conv, 'r1', '看这张图', { images: [IMG], reply: '这是一只猫' })

    expect(hasImages(assembleViaCachePath(conv, '它可爱吗'))).toBe(true)
    expect(hasImages(assembleViaColdStart(conv))).toBe(true)
  })

  it('图在两轮前（taskIndex 1，L1 压缩区）：两条路径都必须把图呈现给模型', () => {
    const conv = Conversation.create({ agentKey: '__companion__', terminalType: 'assistant' })
    commitTurn(conv, 'r1', '看这张图', { images: [IMG], reply: '这是一只猫' })
    commitTurn(conv, 'r2', '它几岁了', { reply: '看起来两岁' })

    // 2026-08-06 回归的覆灭场景：修复前冷启动 L1 压缩剥掉 r1 的图
    const viaCache = assembleViaCachePath(conv, '再说说它的眼睛')
    const viaCold = assembleViaColdStart(conv)
    expect(hasImages(viaCache)).toBe(true)
    expect(hasImages(viaCold)).toBe(true)

    // 用户边界等价：两条路径都呈现 2 个真实用户轮次，不并轮、不丢轮
    expect(viaCache.filter(m => m.role === 'user')).toHaveLength(3) // 2 轮历史 + 本轮新消息
    expect(viaCold.filter(m => m.role === 'user')).toHaveLength(2)
  })

  it('剥图降级后的有意分叉：cache 前缀剔图自愈，taskMemory 保留原图供冷启动重试', () => {
    const conv = Conversation.create({ agentKey: '__companion__', terminalType: 'assistant' })
    // 视觉模型拒收带图长前缀 → ai.service 剥图重试成功 → imagesStripped 上报
    commitTurn(conv, 'r1', '看这张图', { images: [IMG], reply: '画面没传过来', imagesStripped: true })

    // cache path：前缀剔图（防毒前缀每轮循环「拒图→剥图→说看不到」）。
    // 这是有意的路径不等价，禁止后来人"顺手对齐"把自愈破坏掉
    expect(hasImages(assembleViaCachePath(conv, '现在能看到吗'))).toBe(false)
    // cold start：taskMemory 保留原图——干净短上下文给视觉模型一次重试机会
    expect(hasImages(assembleViaColdStart(conv))).toBe(true)
  })
})
