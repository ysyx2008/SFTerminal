/**
 * 微信出站过程消息策略：对 IMProgressOutboundCapable 的具体实现，
 * 内部委托 progress-buffer 合并 digest，经 adapter 串行 lane 发出。
 */
import { WechatProgressBuffer } from './progress-buffer.js'

export type WechatOutboundProgressSend = (text: string) => Promise<void>

export type WechatOutboundProgressOptions = {
  header: string
  sendDigest: WechatOutboundProgressSend
}

export class WechatOutboundProgress {
  private readonly buffer: WechatProgressBuffer

  constructor(options: WechatOutboundProgressOptions) {
    this.buffer = new WechatProgressBuffer(options.sendDigest, { header: options.header })
  }

  push(text: string): void {
    this.buffer.push(text)
  }

  flush(): Promise<void> {
    return this.buffer.flush()
  }

  dispose(): Promise<void> {
    return this.buffer.dispose()
  }
}
