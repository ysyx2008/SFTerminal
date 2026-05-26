/**
 * 对齐上游 WeixinReplyProgressSender（2.4.4），但出站发送走 adapter 注入的
 * sendItem（串行 lane + withSendRetry + run_id），避免直接打 API 导致 -2 雪崩。
 */
import type { MessageItem } from './api/types.js'
import { MessageItemType } from './api/types.js'
import { createLogger } from '../../../utils/logger'

const log = createLogger('WeixinReplyProgress')

export type SendMessageItemFn = (item: MessageItem, label: string) => Promise<void>

export type SfWeixinReplyProgressSenderDeps = {
  runId: string
  to: string
  accountId: string
  sendItem: SendMessageItemFn
}

function normalizeToolStatus(success?: boolean): string {
  if (success === false) return 'failed'
  if (success === true) return 'completed'
  return 'completed'
}

export class SfWeixinReplyProgressSender {
  readonly runId: string

  private readonly to: string
  private readonly accountId: string
  private readonly sendItem: SendMessageItemFn
  private finalized = false
  private sendChain: Promise<void> = Promise.resolve()

  constructor(deps: SfWeixinReplyProgressSenderDeps) {
    this.runId = deps.runId
    this.to = deps.to
    this.accountId = deps.accountId
    this.sendItem = deps.sendItem
  }

  private enqueueMessage(item: MessageItem, label: string): void {
    if (this.finalized) return
    this.sendChain = this.sendChain
      .then(() => this.sendItem(item, label))
      .catch((err) => {
        log.warn(
          `${label}: failed to=${this.to} accountId=${this.accountId} runId=${this.runId} err=${String(err)}`,
        )
      })
  }

  /** 工具开始（对应上游 TOOL_CALL_START） */
  notifyToolStart(toolName: string, toolCallId?: string): void {
    const now = Date.now()
    this.enqueueMessage(
      {
        type: MessageItemType.TOOL_CALL_START,
        create_time_ms: now,
        is_completed: false,
        tool_call_start_item: {
          tool_name: toolName,
          tool_call_id: toolCallId,
        },
      },
      'sendToolCallStartMessage',
    )
  }

  /** 工具结束（对应上游 TOOL_CALL_RESULT） */
  notifyToolEnd(toolName: string, toolCallId?: string, success?: boolean): void {
    const now = Date.now()
    this.enqueueMessage(
      {
        type: MessageItemType.TOOL_CALL_RESULT,
        create_time_ms: now,
        is_completed: true,
        tool_call_result_item: {
          tool_name: toolName,
          tool_call_id: toolCallId,
          status: normalizeToolStatus(success),
        },
      },
      'sendToolCallResultMessage',
    )
  }

  async finalize(): Promise<void> {
    if (this.finalized) return
    this.finalized = true
    try {
      await this.sendChain
    } catch (err) {
      log.warn(`finalize: send drain failed runId=${this.runId} err=${String(err)}`)
    }
  }
}
