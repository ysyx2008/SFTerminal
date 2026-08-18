/**
 * 解析 Excel 预览 HTML：新格式各表已内嵌；旧格式只有当前表 + 装饰标签。
 */

export interface SpreadsheetPreviewSheet {
  name: string
  html: string
}

export interface SpreadsheetPreviewModel {
  sheets: SpreadsheetPreviewSheet[]
  activeSheet: string
}

export function parseSpreadsheetPreviewHtml(html: string): SpreadsheetPreviewModel {
  if (!html.trim()) return { sheets: [], activeSheet: '' }

  const doc = new DOMParser().parseFromString(`<div class="ss-root">${html}</div>`, 'text/html')
  const root = doc.querySelector('.ss-root')
  if (!root) return { sheets: [], activeSheet: '' }

  const panes = [...root.querySelectorAll<HTMLElement>('.sheet-pane')]
  if (panes.length > 0) {
    const sheets = panes
      .map(p => ({ name: p.dataset.sheet || '', html: p.innerHTML }))
      .filter(s => s.name)
    const visible = panes.find(p => !p.hidden)
    return {
      sheets,
      activeSheet: visible?.dataset.sheet || sheets[0]?.name || ''
    }
  }

  const tabs = [...root.querySelectorAll<HTMLElement>('.sheet-tab')]
  const names = tabs
    .map(t => t.dataset.sheet || t.textContent?.trim() || '')
    .filter(Boolean)
  const activeTab = tabs.find(t => t.classList.contains('active'))
  const activeSheet = activeTab
    ? (activeTab.dataset.sheet || activeTab.textContent?.trim() || names[0] || '')
    : (names[0] || '')

  root.querySelector('.sheet-tabs')?.remove()
  const body = root.innerHTML.trim()

  if (names.length === 0) {
    return { sheets: body ? [{ name: '', html: body }] : [], activeSheet: '' }
  }

  return {
    sheets: names.map(name => ({
      name,
      html: name === activeSheet ? body : ''
    })),
    activeSheet
  }
}

/** 旧预览：有多表标签但只有当前表的 HTML，需要从磁盘重建 */
export function spreadsheetPreviewNeedsAllSheets(model: SpreadsheetPreviewModel): boolean {
  return model.sheets.length > 1 && model.sheets.some(s => !s.html.trim())
}

/** 在已挂载的预览 DOM 上显示指定 sheet；没有 pane 时返回 false（旧预览）。 */
export function applySpreadsheetActiveSheet(root: ParentNode, sheetName: string): boolean {
  const panes = [...root.querySelectorAll<HTMLElement>('.sheet-pane')]
  if (panes.length === 0) return false
  let found = false
  for (const pane of panes) {
    const match = pane.dataset.sheet === sheetName
    pane.hidden = !match
    if (match) found = true
  }
  if (!found) {
    for (const [i, pane] of panes.entries()) pane.hidden = i !== 0
  }
  return found
}
