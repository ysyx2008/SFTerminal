/**
 * Electron Accelerator 字符串与 KeyboardEvent 的匹配工具
 *
 * 支持的修饰键标记：
 * - `CmdOrCtrl` / `CommandOrControl`：mac 上要求 metaKey、其他平台要求 ctrlKey（任一即可）
 * - `Cmd` / `Command` / `Meta`：仅 metaKey，必须不是 ctrlKey（用于 mac 专用默认值）
 * - `Ctrl` / `Control`：仅 ctrlKey，必须不是 metaKey（用于 win/linux 专用默认值）
 * - `Shift` / `Alt`（含 `Option`）：常规 shift / alt
 *
 * 把 `Cmd`/`Ctrl` 和 `CmdOrCtrl` 区分开，是为了能精确表达「mac 用 ⌘D、win 用 Ctrl+Shift+D」
 * 这种平台默认值——前者绝不能在 win 上误触发 Ctrl+D（终端 EOF），反过来也一样。
 *
 * 用户在设置页录入快捷键时仍统一记成 `CmdOrCtrl+...`（见 ShortcutSettings.vue 的
 * keyEventToAccelerator）；只有 DEFAULT_KEYBOARD_SHORTCUTS 里的平台专属值会用到 Cmd/Ctrl。
 */

interface ParsedAccelerator {
  /** CmdOrCtrl 修饰：metaKey 或 ctrlKey 之一即满足 */
  cmdOrCtrl: boolean
  /** Cmd/Command/Meta 修饰：只要 metaKey */
  cmd: boolean
  /** Ctrl/Control 修饰：只要 ctrlKey */
  ctrl: boolean
  shift: boolean
  alt: boolean
  /** 主键，原始大小写保留（如 'D'、'F12'、','），匹配时会做大小写归一 */
  key: string
}

function parseAccelerator(accel: string): ParsedAccelerator | null {
  if (!accel) return null
  const parts = accel.split('+').map(p => p.trim())
  let cmdOrCtrl = false
  let cmd = false
  let ctrl = false
  let shift = false
  let alt = false
  let key = ''

  for (const part of parts) {
    const p = part.toLowerCase()
    if (p === 'cmdorctrl' || p === 'commandorcontrol') cmdOrCtrl = true
    else if (p === 'cmd' || p === 'command' || p === 'meta') cmd = true
    else if (p === 'ctrl' || p === 'control') ctrl = true
    else if (p === 'shift') shift = true
    else if (p === 'alt' || p === 'option') alt = true
    else if (part) key = part
  }

  if (!key) return null
  return { cmdOrCtrl, cmd, ctrl, shift, alt, key }
}

/**
 * 检测 KeyboardEvent 是否匹配 Electron Accelerator 字符串。
 *
 * 修饰键的「需要」语义：
 * - cmdOrCtrl 出现 → metaKey 或 ctrlKey 至少一个为 true 即满足
 * - cmd/ctrl 单独出现 → 必须严格匹配（cmd 要求 metaKey 且 !ctrlKey，反之亦然）
 * - 没出现的修饰键 → 必须 false（避免「Cmd+D」被「Cmd+Shift+D」误触）
 */
export function matchAccelerator(event: KeyboardEvent, accelerator: string): boolean {
  const parsed = parseAccelerator(accelerator)
  if (!parsed) return false

  if (parsed.cmdOrCtrl) {
    if (!(event.ctrlKey || event.metaKey)) return false
  } else {
    if (parsed.cmd !== event.metaKey) return false
    if (parsed.ctrl !== event.ctrlKey) return false
  }
  if (parsed.shift !== event.shiftKey) return false
  if (parsed.alt !== event.altKey) return false

  // 主键匹配：优先单字符大写比较，其次 F-key 原样比较，最后小写归一
  const targetKey = parsed.key
  const eventKey = event.key
  if (eventKey.length === 1 && targetKey.length === 1) {
    return eventKey.toUpperCase() === targetKey.toUpperCase()
  }
  if (/^F\d{1,2}$/i.test(targetKey)) {
    return eventKey.toUpperCase() === targetKey.toUpperCase()
  }
  return eventKey.toLowerCase() === targetKey.toLowerCase()
}

/**
 * 把 Accelerator 字符串格式化成给用户看的紧凑显示（用于菜单项 / 工具提示等单行展示）。
 *
 * - mac: 用 Apple 风格符号紧凑拼接，如 `Cmd+Shift+D` → `⌘⇧D`
 * - win/linux: 保持英文缩写并用 `+` 分隔，如 `Ctrl+Shift+D` → `Ctrl+Shift+D`
 *
 * 设置面板里的 keycap 渲染走另一套 (acceleratorToKeys)，那里需要数组，所以两个工具
 * 各自管自己的形态——这里专管菜单/提示场景的紧凑文本。
 */
export function formatAccelerator(accelerator: string): string {
  if (!accelerator) return ''
  const isMac = typeof navigator !== 'undefined' && navigator.platform.toLowerCase().includes('mac')
  const macMap: Record<string, string> = {
    CmdOrCtrl: '⌘', CommandOrControl: '⌘',
    Cmd: '⌘', Command: '⌘', Meta: '⌘',
    Ctrl: '⌃', Control: '⌃',
    Shift: '⇧', Alt: '⌥', Option: '⌥',
  }
  const winMap: Record<string, string> = {
    CmdOrCtrl: 'Ctrl', CommandOrControl: 'Ctrl',
    Cmd: 'Cmd', Command: 'Cmd', Meta: 'Win',
    Ctrl: 'Ctrl', Control: 'Ctrl',
    Shift: 'Shift', Alt: 'Alt', Option: 'Alt',
  }
  const map = isMac ? macMap : winMap
  const parts = accelerator.split('+').map(p => map[p] ?? p)
  return isMac ? parts.join('') : parts.join('+')
}
