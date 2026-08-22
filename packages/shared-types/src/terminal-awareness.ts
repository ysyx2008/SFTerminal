/**
 * 终端感知：后端分析终端屏幕，前端按分析结果决定怎么提示用户。
 *
 * 两侧看的是同一份分析结果，枚举值对不上就是前端认不出后端报的状态，
 * 而这种错不会有编译信号——必须共用同一份定义。
 */

/** 输入等待类型 */
export type InputWaitingType =
  | 'password'        // 密码输入
  | 'confirmation'    // 确认 (y/n)
  | 'selection'       // 选择 (1/2/3)
  | 'pager'           // 分页器 (more/less)
  | 'prompt'          // Shell 提示符（空闲）
  | 'editor'          // 编辑器模式 (vim/nano)
  | 'custom_input'    // 其他自定义输入
  | 'none'            // 无等待状态

/** 输入等待状态 */
export interface InputWaitingState {
  /** 是否在等待输入 */
  isWaiting: boolean
  /** 等待类型 */
  type: InputWaitingType
  /** 检测到的提示文本 */
  prompt?: string
  /** 可选项（用于 selection 类型）*/
  options?: string[]
  /** 建议的自动响应 */
  suggestedResponse?: string
  /** 置信度 0-1 */
  confidence: number
}

/** 输出模式类型 */
export type OutputPatternType =
  | 'progress'        // 进度条
  | 'compilation'     // 编译输出
  | 'test'            // 测试结果
  | 'log_stream'      // 日志流
  | 'error'           // 错误输出
  | 'table'           // 表格数据
  | 'normal'          // 普通输出

/** 输出模式 */
export interface OutputPattern {
  /** 模式类型 */
  type: OutputPatternType
  /** 置信度 0-1 */
  confidence: number
  /** 详细信息 */
  details?: {
    /** 进度百分比 */
    progress?: number
    /** 通过的测试数 */
    testsPassed?: number
    /** 失败的测试数 */
    testsFailed?: number
    /** 错误数量 */
    errorCount?: number
    /** ETA 预计剩余时间 */
    eta?: string
  }
}

/** 环境上下文 */
export interface EnvironmentContext {
  /** 检测到的用户名 */
  user?: string
  /** 检测到的主机名 */
  hostname?: string
  /** 是否是 root 用户 */
  isRoot: boolean
  /** 当前路径（从提示符解析）*/
  cwdFromPrompt?: string
  /** 激活的虚拟环境 */
  activeEnvs: string[]
  /** SSH 深度（检测到的 SSH 跳转层数）*/
  sshDepth: number
  /** 提示符类型 */
  promptType: 'bash' | 'zsh' | 'fish' | 'powershell' | 'cmd' | 'unknown'
}
