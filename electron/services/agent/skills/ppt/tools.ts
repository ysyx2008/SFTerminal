/**
 * PPT 技能工具定义
 */

import type { ToolDefinition, ToolDefinitionWithMeta } from '../../tools'

export const pptTools: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'ppt_from_html',
      description: `【推荐】从约束版 Slide HTML 生成 PowerPoint (.pptx)，并在助手模式 Canvas 中预览 HTML。

**HTML 契约**（加载 ppt 技能后详见技能文档）：
- 每页 \`<section class="slide" data-layout="..." style="width:1600px;height:900px">\`
- layout: title | content | two-column | stat-callout | image-bleed | closing
- 图片用**绝对路径**；图表请先 chart 技能生成 PNG 再嵌入

**输入**：\`html\` 与 \`html_path\` 二选一；会同时保存 \`deck.html\`（与 pptx 同目录同名）供预览与重导。

**工作流**：调研/写 Word → 提炼要点 → 写 slide HTML → 本工具导出 → 用户在 Canvas 翻页确认`,
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: '输出 .pptx 路径（绝对或相对 cwd），应以 .pptx 结尾',
          },
          html: {
            type: 'string',
            description: 'Slide HTML 内容（可仅 body 内多个 section.slide）',
          },
          html_path: {
            type: 'string',
            description: '本地 HTML 文件路径',
          },
          theme: {
            type: 'string',
            description:
              '主题：simple（默认）、midnight、forest、teal、charcoal、coral；页级可用 data-theme 覆盖',
          },
          title: {
            type: 'string',
            description: '演示文稿元数据标题（可选）',
          },
        },
        required: ['path'],
      },
    },
    _meta: {
      streamDisplay: {
        titleKey: 'ppt.generating_from_html',
        titleField: 'path',
        progressFields: ['html'],
      },
    },
  } as ToolDefinitionWithMeta,
]
