/** ref 元素的角色与名称，用于生成用户可读描述 */
export interface RefLabelInfo {
  role: string
  name?: string
}

export type RefLabelMap = Record<string, RefLabelInfo>

/** ARIA 角色到用户可读中文的映射，用于展示「按钮「提交」」而非「@e48」 */
const ROLE_LABELS: Record<string, string> = {
  button: '按钮',
  link: '链接',
  textbox: '输入框',
  searchbox: '搜索框',
  heading: '标题',
  paragraph: '段落',
  img: '图片',
  checkbox: '复选框',
  radio: '单选框',
  combobox: '下拉框',
  listbox: '列表',
  menuitem: '菜单项',
  option: '选项',
  switch: '开关',
  tab: '标签',
  cell: '单元格',
  article: '文章',
  region: '区域',
  navigation: '导航',
  main: '主内容',
}

/**
 * 将选择器转为用户可读描述。
 * 若为 @ref 且在 refs 中有对应项，返回如「按钮「提交」」；否则返回原选择器。
 */
export function selectorToHumanLabel(selector: string, refs: RefLabelMap | undefined): string {
  if (!selector.startsWith('@') || !refs) return selector
  const refId = selector.slice(1)
  const info = refs[refId]
  if (!info) return selector
  const roleLabel = ROLE_LABELS[info.role] ?? info.role
  const namePart = info.name ? `「${info.name}」` : ''
  return `${roleLabel}${namePart}`.trim() || selector
}
