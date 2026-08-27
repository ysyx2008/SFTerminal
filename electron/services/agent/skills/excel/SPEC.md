# Excel 技能（`electron/services/agent/skills/excel/`）

## 职责

会话式读写表格：打开、读、改、存，以及从 Markdown 生成、模板填充、样式与分析。

## 设计目标

### WPS 表格先按 Excel 来用

用户交来的新版 WPS 表格，应当能用现有 Excel 能力打开、改、存回原文件，不必先另存。新建仍用 Excel 格式。老格式或加密读不了时，请用户另存为 Excel。不做单独的 WPS 技能，也不在这一步做演示稿。

### 预览给人看，读取给助手看

产出物里的表格预览按表的实际大小画，人可以横竖滚动看完整内容。只有大到预览会卡顿的表才截断；截断说明钉在表格底下，要一眼能看见，写清预览了多少、一共多少。点开一张空白表时，要一眼看出是空的，不要像预览坏了。预览里可以圈一块格子，让助手只改这块，改完立刻在预览里看见；不在格子里直接打字。格子上的字体、字号、颜色和底色要跟着表走，一眼能对上。有明确颜色的照画；主题色按常见默认色板近似，工作簿自定义主题不做精确还原。条件格式、图表、图片不做。助手通过读取拿到的内容仍然受上下文限制，不跟预览一起变大。

## Canvas 产出物

- `excel_open` / `excel_modify`（有预览 HTML 时 update）/ `excel_merge_template` / **`excel_from_markdown`** 成功时推送 `canvasData`（`renderer: 'spreadsheet'`）到独立助手产出物面板。
- `excel_save` / `excel_close` 不推送（面板已由 open/modify/from_markdown 注册；close 不删 tab，见 `packages/workbench-assistant/src/artifact/SPEC.md`）。

## 写前校验（`expected_originals`）

`excel_modify` 的 `cells` 写入支持可选参数 `expected_originals`：`{ "A2": "序号", "A3": "" }`。

- 在**任何** modify 副作用（含 add_sheet、cells、styles 等）之前，先校验所列单元格当前值是否与预期一致（比较规则与 `excel_read` 的 `formatCellValue` 一致）。
- 任一不匹配 → 整次调用失败，**零写入**。
- 不传则保持原有「直接写入」行为。

## 读取行号

`excel_read` 指定 `sheet` 时，Markdown 表格首列为 **Excel 行号**（1-based），列标题为 **A/B/C…**（读取范围对应列字母）；范围内每一行（含表头行）各出现一次，避免把 `rows[0]` 既当表头又当数据行。

## 主要文件

| 文件 | 说明 |
|------|------|
| `tools.ts` | 工具 schema |
| `executor.ts` | 执行逻辑 |
| `cell-value.ts` | 单元格值格式化与 expected_originals 校验 |
| `session.ts` | 打开文件会话 |
| `template-merge.ts` | `{{占位符}}` 模板填充 |
