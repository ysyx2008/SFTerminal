/**
 * Markdown 渲染 composable
 * 处理 Markdown 解析、代码块交互和文件路径点击
 */
import { marked } from 'marked'
import { useTerminalStore } from '../stores/terminal'
import { toast } from './useToast'

const writeClipboard = async (text: string): Promise<boolean> => {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // fallback: 动态创建的 DOM 元素中 navigator.clipboard 可能因用户手势丢失而失败
    try {
      const textarea = document.createElement('textarea')
      textarea.value = text
      textarea.style.cssText = 'position:fixed;opacity:0;left:-9999px'
      document.body.appendChild(textarea)
      textarea.select()
      const ok = document.execCommand('copy')
      document.body.removeChild(textarea)
      return ok
    } catch {
      return false
    }
  }
}

/**
 * 检测文本是否为本地文件路径
 * 支持三种格式：
 * - Unix/macOS/Linux 绝对路径：/path/to/file
 * - 用户主目录路径：~/path/to/file
 * - Windows 路径：C:\path\to\file 或 C:/path/to/file
 *
 * 字符限制只排除真正不可能在文件名中的字符（HTML 标签符号 <>、shell 通配 *?、双引号、
 * 控制字符 \n\r\t）；**空格是合法路径字符**——macOS `~/Library/Application Support`、
 * Windows `C:\Program Files` 都含空格，不能用 `\s` 一刀切排除。
 */
const isLocalFilePath = (text: string): boolean => {
  const trimmed = text.trim()
  if (trimmed.length < 2) return false
  // 排除 HTTP(S) URL（例如 "p://localhost" 误匹配 Windows 盘符模式）
  if (/^https?:\/\//i.test(trimmed)) return false
  // 路径中不允许的字符：HTML 标签符号、shell 通配符、双引号、控制字符
  const illegal = /[<>*?"\n\r\t]/
  if (illegal.test(trimmed)) return false
  // Unix/macOS/Linux 绝对路径
  if (/^\//.test(trimmed)) return true
  // 用户主目录路径
  if (/^~\//.test(trimmed)) return true
  // Windows 路径 (C:\ 或 C:/)
  if (/^[A-Za-z]:[\\/]/.test(trimmed)) return true
  return false
}

/**
 * 检测文本是否为 HTTP(S) URL
 * 仅识别 http/https 协议，避免 javascript:/data: 等危险协议
 */
const isHttpUrl = (text: string): boolean => {
  const trimmed = text.trim()
  if (!/^https?:\/\//i.test(trimmed)) return false
  try {
    const url = new URL(trimmed)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * HTML 属性值转义
 */
const escapeAttr = (text: string): string => {
  return text
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/**
 * 解码 HTML 实体（用于从 marked 输出中还原原始文本）
 */
const decodeHtmlEntities = (text: string): string => {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}

/**
 * 后处理 HTML：将文本节点中的裸 HTTP(S) URL 转为可点击链接
 * 仅处理不在 <a>、<code>、<pre> 标签内的文本
 * 必须在 wrapBareFilePaths 之前执行，避免 URL 中的 "p://" 片段被误识别为 Windows 盘符路径
 */
const wrapBareUrls = (html: string): string => {
  // 匹配 http/https URL：贪婪匹配非空白、非 <>、非引号、非反引号字符
  // 注意：反引号之内的内容由 codespan 处理，不会到这里
  const urlPattern = /https?:\/\/[^\s<>"'`]+/gi
  // 结尾常见的中英文标点不纳入链接
  const trailingPunct = /[.,;:!?。，；：！？、)\]】』」》>]+$/

  const parts = html.split(/(<[^>]+>)/g)
  const depth = { a: 0, code: 0, pre: 0 }

  return parts.map(part => {
    if (part.startsWith('<')) {
      if (/<a[\s>]/i.test(part)) depth.a++
      else if (/<\/a>/i.test(part)) depth.a = Math.max(0, depth.a - 1)
      if (/<code[\s>]/i.test(part)) depth.code++
      else if (/<\/code>/i.test(part)) depth.code = Math.max(0, depth.code - 1)
      if (/<pre[\s>]/i.test(part)) depth.pre++
      else if (/<\/pre>/i.test(part)) depth.pre = Math.max(0, depth.pre - 1)
      return part
    }

    if (depth.a > 0 || depth.code > 0 || depth.pre > 0) return part

    return part.replace(urlPattern, (match) => {
      // 剥离尾部标点（如 "访问 https://example.com/。" 中的 "。"）
      const tail = trailingPunct.exec(match)
      let url = match
      let suffix = ''
      if (tail) {
        url = match.slice(0, -tail[0].length)
        suffix = tail[0]
      }
      if (!isHttpUrl(url)) return match
      return `<a href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer" class="external-url-link" title="点击在浏览器中打开">${url}</a>${suffix}`
    })
  }).join('')
}

/**
 * 后处理 HTML：将文本节点中的裸文件路径转为可点击链接
 * 仅处理不在 <a>、<code>、<pre> 标签内的文本
 */
const wrapBareFilePaths = (html: string): string => {
  // 匹配常见文件路径模式（支持中文、日文、韩文、欧洲字符等 Unicode 路径）
  // Unix/macOS: /path/to/file（至少两级路径或带扩展名的单级路径）
  // Windows: C:\path\to\file 或 C:/path/to/file
  // Home: ~/path/to/file
  const filePathPattern = /(?:\/(?:[\w\u4e00-\u9fff\u3000-\u303f\u00C0-\u024F.\-+@#$()[\]% ]+\/)*[\w\u4e00-\u9fff\u3000-\u303f\u00C0-\u024F.\-+@#$()[\]% ]+\.[\w]{1,10}|~\/[\w\u4e00-\u9fff\u3000-\u303f\u00C0-\u024F.\-+@#$()[\]%/\\ ]+|[A-Za-z]:[\\/][\w\u4e00-\u9fff\u3000-\u303f\u00C0-\u024F.\-+@#$()[\]%/\\ ]+)/g

  // 拆分 HTML 为标签和文本节点
  const parts = html.split(/(<[^>]+>)/g)
  const depth = { a: 0, code: 0, pre: 0 }

  return parts.map(part => {
    if (part.startsWith('<')) {
      // 跟踪标签嵌套深度
      if (/<a[\s>]/i.test(part)) depth.a++
      else if (/<\/a>/i.test(part)) depth.a = Math.max(0, depth.a - 1)
      if (/<code[\s>]/i.test(part)) depth.code++
      else if (/<\/code>/i.test(part)) depth.code = Math.max(0, depth.code - 1)
      if (/<pre[\s>]/i.test(part)) depth.pre++
      else if (/<\/pre>/i.test(part)) depth.pre = Math.max(0, depth.pre - 1)
      return part
    }

    // 在 <a>、<code>、<pre> 内不做处理
    if (depth.a > 0 || depth.code > 0 || depth.pre > 0) return part

    return part.replace(filePathPattern, (match) => {
      const trimmed = match.trim()
      if (!isLocalFilePath(trimmed)) return match
      return `<a class="file-path-link" data-file-path="${escapeAttr(trimmed)}" title="点击打开文件">${match}</a>`
    })
  }).join('')
}

const MARKDOWN_CACHE_MAX = 500
const markdownCache = new Map<string, string>()

export function useMarkdown() {
  const terminalStore = useTerminalStore()

  // 配置 marked 渲染器
  const renderer = new marked.Renderer()

  // 自定义代码块渲染（添加复制按钮）
  // 使用 data 属性标记，通过事件委托处理点击，解决流式输出时按钮不可用的问题
  // 兼容 marked 不同版本的 API
  renderer.code = (codeOrToken: string | { text: string; lang?: string }, language?: string) => {
    // 兼容新旧版本 marked API
    let code: string
    let lang: string
    
    if (typeof codeOrToken === 'object' && codeOrToken !== null) {
      // 新版本 marked，参数是 token 对象
      code = codeOrToken.text || ''
      lang = codeOrToken.lang || 'text'
    } else {
      // 旧版本 marked，参数是分散的
      code = codeOrToken as string
      lang = language || 'text'
    }
    
    // 转义 HTML 特殊字符用于显示
    const escapedCode = code
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
    
    // 始终渲染按钮，通过事件委托在点击时获取代码内容
    const copyBtn = `<button class="code-copy-btn" data-action="copy" title="复制代码"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>`
    
    const sendBtn = `<button class="code-send-btn" data-action="send" title="发送到终端"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 10 4 15 9 20"/><path d="M20 4v7a4 4 0 0 1-4 4H4"/></svg></button>`
    
    return `<div class="code-block"><div class="code-header"><span>${lang}</span><div class="code-actions">${sendBtn}${copyBtn}</div></div><pre><code>${escapedCode}</code></pre></div>`
  }

  // 自定义行内代码渲染 - 检测文件路径 / URL 并添加可点击标记
  renderer.codespan = (codeOrToken: string | { text: string }) => {
    const text = typeof codeOrToken === 'object' ? (codeOrToken.text || '') : codeOrToken
    // 解码 HTML 实体后检测是否为文件路径或 URL
    const decoded = decodeHtmlEntities(text)

    if (isLocalFilePath(decoded)) {
      return `<code class="inline-code file-path-link" data-file-path="${escapeAttr(decoded)}" title="点击打开文件">${text}</code>`
    }

    // HTTP(S) URL：用 <a> 代替 <code>，复用 inline-code 样式以保留代码块外观，
    // 同时天然支持点击跳转（Electron setWindowOpenHandler 会调用 shell.openExternal）
    if (isHttpUrl(decoded)) {
      return `<a href="${escapeAttr(decoded)}" target="_blank" rel="noopener noreferrer" class="inline-code external-url-link" title="点击在浏览器中打开">${text}</a>`
    }

    return `<code class="inline-code">${text}</code>`
  }

  // 自定义链接渲染 - 检测文件路径链接
  renderer.link = (hrefOrToken: string | { href: string; title?: string | null; text: string; tokens?: unknown[] }, title?: string | null, text?: string) => {
    let href: string, linkTitle: string, linkText: string

    if (typeof hrefOrToken === 'object' && hrefOrToken !== null) {
      href = hrefOrToken.href || ''
      linkTitle = hrefOrToken.title || ''
      // 新版 marked 的 text 可能包含已渲染的 HTML
      linkText = hrefOrToken.text || ''
    } else {
      href = hrefOrToken as string
      linkTitle = title || ''
      linkText = text || ''
    }

    const decodedHref = decodeHtmlEntities(href)

    // 文件路径链接：使用 data-file-path 标记，通过事件委托处理点击
    if (isLocalFilePath(decodedHref)) {
      const titleAttr = linkTitle ? ` title="${escapeAttr(linkTitle)}"` : ' title="点击打开文件"'
      return `<a class="file-path-link" data-file-path="${escapeAttr(decodedHref)}"${titleAttr}>${linkText}</a>`
    }

    // 普通链接：在新标签页打开
    const titleAttr = linkTitle ? ` title="${escapeAttr(linkTitle)}"` : ''
    return `<a href="${escapeAttr(href)}"${titleAttr} target="_blank" rel="noopener noreferrer">${linkText}</a>`
  }

  // 配置 marked
  marked.setOptions({
    renderer,
    breaks: true,  // 支持换行
    gfm: true      // 支持 GitHub 风格 Markdown
  })

  const renderMarkdown = (text: string): string => {
    if (!text) return ''

    const cached = markdownCache.get(text)
    if (cached) return cached

    let html: string
    try {
      html = marked.parse(text) as string
      // 先处理 URL（变成 <a>），再处理文件路径
      // 这样文件路径扫描会跳过已链接化的 URL，避免 "p://" 被误识别为 Windows 盘符
      html = wrapBareUrls(html)
      html = wrapBareFilePaths(html)
    } catch (e) {
      html = text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\n/g, '<br>')
    }

    if (markdownCache.size >= MARKDOWN_CACHE_MAX) {
      const oldest = markdownCache.keys().next().value!
      markdownCache.delete(oldest)
    }
    markdownCache.set(text, html)
    return html
  }

  // 从代码块中提取代码内容（反转义 HTML）
  const getCodeFromBlock = (button: HTMLElement): string => {
    const codeBlock = button.closest('.code-block')
    const codeElement = codeBlock?.querySelector('pre code')
    if (!codeElement) return ''
    
    // 获取文本内容（自动反转义 HTML 实体）
    return codeElement.textContent || ''
  }

  // 事件委托处理代码块按钮点击 + 文件路径链接点击
  const handleCodeBlockClick = async (event: MouseEvent) => {
    const target = event.target as HTMLElement

    // 处理文件路径点击（通过 data-file-path 属性标记）
    const filePathEl = target.closest('[data-file-path]') as HTMLElement
    if (filePathEl) {
      event.preventDefault()
      event.stopPropagation()
      const filePath = filePathEl.dataset.filePath
      if (filePath) openFilePath(filePath)
      return
    }
    
    // 查找带有 data-action 属性的按钮（可能点击的是 SVG 或其子元素）
    const button = target.closest('.code-copy-btn, .code-send-btn') as HTMLElement
    if (!button) {
      return
    }
    
    const action = button.dataset.action
    const code = getCodeFromBlock(button)
    
    if (!code) {
      return
    }
    
    if (action === 'copy') {
      await writeClipboard(code)
    } else if (action === 'send') {
      try {
        const activeTab = terminalStore.activeTab
        console.log('Active tab:', activeTab?.id, 'ptyId:', activeTab?.ptyId)
        if (activeTab?.ptyId) {
          // 发送代码到终端（不自动添加回车，让用户确认后再执行）
          await terminalStore.writeToTerminal(activeTab.id, code)
          // 自动让终端获得焦点，方便用户按回车执行
          terminalStore.focusTerminal(activeTab.id)
          console.log('代码已发送到终端')
        } else {
          console.warn('没有活动的终端')
        }
      } catch (error) {
        console.error('发送到终端失败:', error)
      }
    }
  }

  // 文件路径右键菜单
  let activeContextMenu: HTMLElement | null = null

  const removeContextMenu = () => {
    if (activeContextMenu) {
      activeContextMenu.remove()
      activeContextMenu = null
    }
  }

  const handleFilePathContextMenu = (event: MouseEvent) => {
    const target = event.target as HTMLElement
    const filePathEl = target.closest('[data-file-path]') as HTMLElement
    if (!filePathEl) return

    const filePath = filePathEl.dataset.filePath
    if (!filePath) return

    event.preventDefault()
    event.stopPropagation()
    removeContextMenu()

    const menu = document.createElement('div')
    menu.className = 'file-path-context-menu'
    menu.style.cssText = `
      position: fixed;
      left: ${event.clientX}px;
      top: ${event.clientY}px;
      min-width: 160px;
      background: var(--bg-secondary);
      border: 1px solid var(--border-color);
      border-radius: 8px;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
      padding: 6px;
      z-index: 10000;
      animation: fadeIn 0.1s ease;
    `

    const items = [
      { label: '打开文件', icon: 'file', action: () => openFilePath(filePath) },
      { label: '打开所在文件夹', icon: 'folder', action: () => showInFolder(filePath) },
      { divider: true },
      { label: '复制路径', icon: 'copy', action: () => copyPathToClipboard(filePath) }
    ]

    for (const item of items) {
      if ('divider' in item && item.divider) {
        const divider = document.createElement('div')
        divider.style.cssText = 'height: 1px; background: var(--border-color); margin: 6px 0;'
        menu.appendChild(divider)
        continue
      }
      const btn = document.createElement('button')
      btn.style.cssText = `
        display: flex; align-items: center; gap: 10px; width: 100%;
        padding: 8px 12px; font-size: 13px; color: var(--text-primary);
        background: transparent; border: none; border-radius: 4px;
        cursor: pointer; text-align: left;
      `
      btn.textContent = item.label!
      btn.addEventListener('mouseenter', () => { btn.style.background = 'var(--bg-hover)' })
      btn.addEventListener('mouseleave', () => { btn.style.background = 'transparent' })
      btn.addEventListener('click', () => {
        item.action!()
        removeContextMenu()
      })
      menu.appendChild(btn)
    }

    document.body.appendChild(menu)
    activeContextMenu = menu

    // 防止超出视口
    requestAnimationFrame(() => {
      const rect = menu.getBoundingClientRect()
      if (rect.right > window.innerWidth) menu.style.left = `${window.innerWidth - rect.width - 10}px`
      if (rect.bottom > window.innerHeight) menu.style.top = `${window.innerHeight - rect.height - 10}px`
    })

    const closeOnClick = (e: MouseEvent) => {
      if (!menu.contains(e.target as Node)) {
        removeContextMenu()
        document.removeEventListener('click', closeOnClick)
        document.removeEventListener('contextmenu', closeOnClick)
      }
    }
    const closeOnEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        removeContextMenu()
        document.removeEventListener('keydown', closeOnEsc)
      }
    }
    setTimeout(() => {
      document.addEventListener('click', closeOnClick)
      document.addEventListener('contextmenu', closeOnClick)
      document.addEventListener('keydown', closeOnEsc)
    }, 0)
  }

  const openFilePath = async (filePath: string) => {
    if (!window.electronAPI?.shell?.openPath) return
    try {
      const errorMsg = await window.electronAPI.shell.openPath(filePath)
      if (errorMsg) {
        toast.error('打开文件失败：文件可能已被删除或移动')
      }
    } catch {
      toast.error('打开文件失败：文件可能已被删除或移动')
    }
  }

  const showInFolder = async (filePath: string) => {
    if (!window.electronAPI?.shell?.showItemInFolder) return
    try {
      await window.electronAPI.shell.showItemInFolder(filePath)
    } catch {
      toast.error('打开所在文件夹失败')
    }
  }

  const copyPathToClipboard = async (filePath: string) => {
    const ok = await writeClipboard(filePath)
    if (ok) toast.success('路径已复制')
    else toast.error('复制路径失败')
  }

  // 复制消息
  const copyMessage = async (content: string) => {
    await writeClipboard(content)
  }

  return {
    renderMarkdown,
    handleCodeBlockClick,
    handleFilePathContextMenu,
    copyMessage
  }
}
