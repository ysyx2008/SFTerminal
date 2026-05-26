# Excel 技能（`electron/services/agent/skills/excel/`）

## 职责

会话式读写 `.xlsx`：open / read / modify / save / close，以及 `excel_from_markdown`、`excel_merge_template`、样式与分析工具。

## 写前校验（`expected_originals`）

`excel_modify` 的 `cells` 写入支持可选参数 `expected_originals`：`{ "A2": "序号", "A3": "" }`。

- 在**任何** modify 副作用（含 add_sheet、cells、styles 等）之前，先校验所列单元格当前值是否与预期一致（比较规则与 `excel_read` 的 `formatCellValue` 一致）。
- 任一不匹配 → 整次调用失败，**零写入**。
- 不传则保持原有「直接写入」行为。

## 读取行号

`excel_read` 指定 `sheet` 时，Markdown 表格首列为 **Excel 行号**（1-based），避免 Agent 把「输出第 1 行」当成「工作表第 1 行」。

## 主要文件

| 文件 | 说明 |
|------|------|
| `tools.ts` | 工具 schema |
| `executor.ts` | 执行逻辑 |
| `cell-value.ts` | 单元格值格式化与 expected_originals 校验 |
| `session.ts` | 打开文件会话 |
| `template-merge.ts` | `{{占位符}}` 模板填充 |
