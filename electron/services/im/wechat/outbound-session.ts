/**
 * 单用户 Agent 任务的微信出站会话：串行发送 + run_id + 结构化工具进度。
 * 对齐上游 process-message.ts 的 deliver 串行链与 reply-progress-sender。
 */
import type { WeixinApiOptions } from './api/api.js'
import { sendMessageItemWeixin, sendMessageWeixin, type WeixinSendResult } from './messaging/send.js'
import { SfWeixinReplyProgressSender } from './sf-reply-progress.js'

/** 两条 sendmessage 之间的最小间隔，避免短时间 burst */
export const WEIXIN_OUTBOUND_MIN_INTERVAL_MS = 450

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export type WeixinOutboundSessionDeps = {
  userId: string
  accountKey: string
  runId: string
  apiOpts: WeixinApiOptions
  resolveContextToken: () => string | undefined
  /**
   * 出站发送的统一封装：从 adapter 取最新 contextToken（store 优先，inbound 快照兜底）
   * 后交给 sendFn。失败原样透传；服务端 `errcode=-2` 已对齐官方 SDK 在 api 层静默吞掉。
   */
  runWithContextToken: <T>(sendFn: (contextToken: string | undefined) => Promise<T>) => Promise<T>
  minIntervalMs?: number
}

export class WeixinOutboundSession {
  readonly runId: string
  readonly progressSender: SfWeixinReplyProgressSender

  private readonly userId: string
  private readonly apiOpts: WeixinApiOptions
  private readonly resolveContextToken: () => string | undefined
  private readonly runWithContextToken: WeixinOutboundSessionDeps['runWithContextToken']
  private readonly minIntervalMs: number

  private sendChain: Promise<void> = Promise.resolve()
  private lastSendAt = 0

  constructor(deps: WeixinOutboundSessionDeps) {
    this.runId = deps.runId
    this.userId = deps.userId
    this.apiOpts = deps.apiOpts
    this.resolveContextToken = deps.resolveContextToken
    this.runWithContextToken = deps.runWithContextToken
    this.minIntervalMs = deps.minIntervalMs ?? WEIXIN_OUTBOUND_MIN_INTERVAL_MS

    this.progressSender = new SfWeixinReplyProgressSender({
      runId: deps.runId,
      to: deps.userId,
      accountId: deps.accountKey,
      sendItem: (item, label) =>
        this.enqueue(() =>
          this.runWithContextToken((contextToken) =>
            sendMessageItemWeixin({
              to: this.userId,
              item,
              opts: {
                ...this.apiOpts,
                contextToken,
                runId: this.runId,
              },
              label,
            }),
          ).then(() => undefined),
        ),
    })
  }

  /**
   * 串行排队执行出站 API；调用方 await 返回值以获知本次发送成败。
   */
  enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      const wait = this.lastSendAt + this.minIntervalMs - Date.now()
      if (wait > 0) await sleep(wait)
      try {
        return await fn()
      } finally {
        this.lastSendAt = Date.now()
      }
    }
    const task = this.sendChain.then(run, run)
    this.sendChain = task.then(
      () => undefined,
      () => undefined,
    )
    return task
  }

  sendText(text: string): Promise<WeixinSendResult> {
    return this.enqueue(() =>
      this.runWithContextToken((contextToken) =>
        sendMessageWeixin({
          to: this.userId,
          text,
          opts: {
            ...this.apiOpts,
            contextToken,
            runId: this.runId,
          },
        }),
      ),
    )
  }

  async drain(): Promise<void> {
    await this.progressSender.finalize()
    await this.sendChain
  }
}
