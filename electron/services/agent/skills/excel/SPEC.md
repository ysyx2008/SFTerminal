# Excel 技能（`electron/services/agent/skills/excel/`）

## 职责

会话式读写 `.xlsx`：open / read / modify / save / close，以及 `excel_from_markdown`、`excel_merge_template`、样式与分析工具。

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
