/**
 * PPT 技能工具定义（html2pptx 路线）
 */

import type { ToolDefinition, ToolDefinitionWithMeta } from '../../tools'

export const pptTools: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'ppt_from_html',
      description: `从 HTML 幻灯片生成「原生可编辑」的 PowerPoint (.pptx)，并在助手 Canvas 中预览。

**原理**：每页是一段 HTML，用真实浏览器渲染后把每个元素（文本/列表/卡片/图片）映射成原生 PPT 元素——布局由浏览器排版，高保真且文字可编辑。

**怎么写**（加载 ppt 技能后详见技能文档）：
- \`slides\`：字符串数组，每个元素 = 一页的 body 内联 HTML（不要写 <html>/<body>/<head>，系统会包裹并把 body 固定为 16:9 1280×720px）
- \`css\`：所有页共享的 <style> 文本（配色、字体、卡片样式都写这里，省 token）
- 用**绝对定位**摆放元素（position:absolute; left/top/width 用 px）；文字必须放进 <p>/<h1>-<h6>/<ul>/<ol>
- 卡片/色块用 <div>（可带 background/border/border-radius/box-shadow），文字放容器内
- 背景：每页第一个 \`<div class="bg" style="background:#xxx">\` 做整页底色；或在 css 里 body{background}
- **不支持 CSS 渐变**（用纯色）；图片用 <img> + 绝对路径；图表先 chart 技能出 PNG
- 内容不能超出页面（系统会报溢出错误让你精简）

**逐页追加（应对长 PPT 被模型输出截断）**：
- \`mode: "replace"\`（默认）从头生成整本；\`mode: "append"\` 把本次 slides 追加到同一 path 的已有 deck 末尾。
- 页数多时，先 replace 写前几页，再多次 append 续写——每次只发一小批，避免单次输出超长被截断。
- 同 path 旁会维护 \`<同名>.deck.json\`（slides 真相源），append 据此合并并整本重渲（已渲过的页走缓存，很快）。

**工作流**：调研/写要点 → 写共享 css + 各页 slides → 本工具导出 → Canvas 翻页确认 → 用 PowerPoint/Keynote 打开`,
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: '输出 .pptx 路径（绝对或相对 cwd），应以 .pptx 结尾',
          },
          slides: {
            type: 'array',
            items: { type: 'string' },
            description: '每页一段 body 内联 HTML（绝对定位排版，文字必须在 <p>/<h*>/<ul> 内）',
          },
          css: {
            type: 'string',
            description: '所有页共享的 <style> 文本（配色/字体/卡片样式），可选但强烈建议；append 时省略则沿用首批的 css',
          },
          mode: {
            type: 'string',
            description: 'replace（默认，整本重建）| append（把 slides 追加到同 path 的已有 deck 末尾，用于分批续写长 PPT）',
          },
          size: {
            type: 'string',
            description: '画幅：widescreen（默认 16:9）| standard（4:3）；append 时沿用首批',
          },
          title: {
            type: 'string',
            description: '演示文稿元数据标题（可选）',
          },
        },
        required: ['path', 'slides'],
      },
    },
    _meta: {
      streamDisplay: {
        titleKey: 'ppt.generating_from_html',
        titleField: 'path',
        progressFields: ['slides'],
      },
    },
  } as ToolDefinitionWithMeta,
]
