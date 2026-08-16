/**
 * 崩溃诊断共享类型
 *
 * 前端要展示「上次异常退出」横幅与崩溃摘要，后端负责采集与打包，两侧共用这一份定义。
 */

export type CrashKind =
  /** 主进程未捕获异常 */
  | 'main-uncaught'
  /** 主进程未处理的 Promise 拒绝 */
  | 'main-unhandled'
  /** 渲染界面进程消失 */
  | 'renderer-gone'
  /** 子进程消失（工具进程 / GPU / 预览进程） */
  | 'child-gone'
  /** 上次运行异常终止，本次启动时补记 */
  | 'previous-exit'

export interface CrashEvent {
  /** ISO 时间戳 */
  at: string
  /** 事件所描述的那次运行的应用版本（previous-exit 记的是上次运行的版本） */
  appVersion: string
  platform: string
  kind: CrashKind
  /** 进程类型（renderer / GPU / Utility 等，按平台原样透传） */
  processType?: string
  /** 子进程的具体身份，是定位模块的关键信息 */
  serviceName?: string
  /** 崩溃原因（平台给出的枚举值） */
  reason?: string
  exitCode?: number
  /** 人类可读补充 */
  message?: string
}

/** 启动时对上次运行的判定 */
export interface CrashStartupVerdict {
  lastExitWasCrash: boolean
  /** 连续异常退出次数；一次正常退出即归零 */
  consecutiveCrashCount: number
  /** 上次运行的版本 */
  previousVersion?: string
}

export interface CrashSummary extends CrashStartupVerdict {
  /** 本次运行期间记录到的崩溃数（不含上次崩溃的补记） */
  crashesThisRun: number
  recentEvents: CrashEvent[]
  /** 已保存的崩溃转储数量 */
  dumpCount?: number
}

export interface DiagnosticsPackageResult {
  success: boolean
  filePath?: string
  sizeBytes?: number
  /** 用户在保存对话框里放弃了，不是失败，界面不该报错 */
  canceled?: boolean
  error?: string
}
