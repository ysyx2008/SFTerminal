/**
 * PPT 技能：HTML 幻灯片 → 原生可编辑 .pptx（html2pptx 路线）+ Canvas 预览
 */

import { registerSkill } from '../registry'
import type { Skill } from '../types'
import { pptTools } from './tools'
import { createLogger } from '../../../../utils/logger'

const log = createLogger('PptSkill')

const pptSkillContent = [
  '## ppt_from_html：写 HTML → 原生可编辑 PPTX',
  '',
  '每页是一段 HTML，系统用真实浏览器渲染后，把每个元素映射成**原生 PPT 元素**（文字可编辑、卡片是真形状）。',
  '布局由浏览器排版，你**只管写好看的 HTML**，不用手算 PPT 坐标。',
  '',
  '### 调用参数',
  '- `slides`：字符串数组，每项 = **一页的 body 内联 HTML**。不要写 `<html>/<head>/<body>`，系统自动包裹。',
  '- `css`：所有页**共享**的样式文本（配色、字体、卡片、标题样式都写这里，省 token、保持统一）。',
  '- `size`：`widescreen`（默认 16:9）或 `standard`（4:3）。',
  '- `path`：输出 .pptx 路径。',
  '',
  '### 画布与定位',
  '- 16:9 画布 = **1280 × 720 px**（4:3 为 960 × 720）。用 **绝对定位**：`position:absolute; left/top/width` 单位 px。',
  '- 安全边距：四周留 ~64px；底部留白 ≥ 48px（否则报溢出错误）。',
  '',
  '### 硬性规则（违反会报错并要求你改）',
  '1. **文字必须**放进 `<p>/<h1>-<h6>/<ul>/<ol>`；`<div>` 里不能有裸文本。',
  '2. **文本标签不能**带 background/border/shadow。卡片/色块用 `<div>`，文字放在 div 内的 `<p>/<h*>`。',
  '3. **不支持 CSS 渐变**——用纯色。整页底色：每页第一个 `<div class="bg" style="background:#xxx"></div>`，或在 css 里 `body{background:#xxx}`。',
  '4. 项目符号用 `<ul><li>`，不要手敲「• / -」。',
  '5. 图片用 `<img src="绝对路径">`；图表先 `load_skill("chart")` 出 PNG 再插入。',
  '6. 内容不能超出页面。',
  '',
  '### 推荐共享 css（可直接改配色复用）',
  '```css',
  'body{font-family:"Microsoft YaHei","PingFang SC",Arial,sans-serif;}',
  '/* 配色：深蓝商务（封面深底、内容浅底） */',
  '.bg-dark{background:#1E2761;} .bg-light{background:#FFFFFF;}',
  '.title{position:absolute;font-weight:700;color:#1E2761;}',
  '.muted{color:#6B7280;}',
  '.accent{background:#C9A227;} /* 左侧色条/强调 */',
  '.card{background:#F8FAFC;border-radius:14px;box-shadow:0 6px 18px rgba(0,0,0,.08);}',
  '```',
  '',
  '### 两页示例',
  '```js',
  'ppt_from_html({',
  '  path: "~/Desktop/年度总结.pptx",',
  '  css: `body{font-family:"Microsoft YaHei",Arial,sans-serif;}',
  '    h1,h2,h3,p{margin:0;}',
  '    .card{background:#F8FAFC;border-radius:14px;box-shadow:0 6px 18px rgba(0,0,0,.08);}`,
  '  slides: [',
  '    // 封面：深底 + 大标题',
  '    `<div class="bg" style="background:#1E2761"></div>',
  '     <div style="position:absolute;left:80px;top:64px;width:64px;height:8px;background:#C9A227"></div>',
  '     <h1 style="position:absolute;left:80px;top:250px;width:1000px;font-size:60px;font-weight:700;color:#fff">2025 年度工作总结</h1>',
  '     <p style="position:absolute;left:80px;top:360px;width:1000px;font-size:24px;color:#CADCFC">人工智能与实验室</p>`,
  '    ,',
  '    // 内容：标题 + 三张数据卡片',
  '    `<div class="bg" style="background:#fff"></div>',
  '     <div style="position:absolute;left:80px;top:64px;width:6px;height:40px;background:#C9A227"></div>',
  '     <h2 style="position:absolute;left:104px;top:64px;width:1000px;font-size:34px;font-weight:700;color:#1E2761">核心成果</h2>',
  '     <div class="card" style="position:absolute;left:80px;top:180px;width:340px;height:240px"></div>',
  '     <p style="position:absolute;left:80px;top:230px;width:340px;text-align:center;font-size:64px;font-weight:800;color:#1E2761">20<span style="font-size:24px">P</span></p>',
  '     <p style="position:absolute;left:80px;top:330px;width:340px;text-align:center;font-size:20px;color:#6B7280">算力规模</p>',
  '     <div class="card" style="position:absolute;left:470px;top:180px;width:340px;height:240px"></div>',
  '     <p style="position:absolute;left:470px;top:230px;width:340px;text-align:center;font-size:64px;font-weight:800;color:#1E2761">103</p>',
  '     <p style="position:absolute;left:470px;top:330px;width:340px;text-align:center;font-size:20px;color:#6B7280">金点子</p>',
  '     <div class="card" style="position:absolute;left:860px;top:180px;width:340px;height:240px"></div>',
  '     <p style="position:absolute;left:860px;top:230px;width:340px;text-align:center;font-size:64px;font-weight:800;color:#1E2761">24</p>',
  '     <p style="position:absolute;left:860px;top:330px;width:340px;text-align:center;font-size:20px;color:#6B7280">数字员工</p>`',
  '  ]',
  '})',
  '```',
  '',
  '### 设计规范（避免 AI 幻灯片审美）',
  '- 三明治结构：封面/结尾用深底，内容页用浅底。',
  '- 每页一个视觉锚点（大数字卡片墙 / 图表 / 关键图），不要纯 bullet 墙。',
  '- 标题 34–44px（封面可 56px+）、正文 18–22px；强调色克制，只点缀。',
  '- 标题左侧用一根短色条（accent）代替整条下划线。',
  '- 卡片对齐成网格，行列间距统一（如 30px）。',
  '',
  '### 流程',
  '1. 调研 / 写要点，提炼关键数字。',
  '2. 写共享 `css` + 各页 `slides`（绝对定位排版）。',
  '3. `ppt_from_html(...)` 导出 → 助手 Canvas 翻页确认 → PowerPoint/Keynote 打开微调。',
  '4. 若报溢出/规则错误，按提示改对应页 HTML 重试。',
].join('\n')

const pptSkill: Skill = {
  id: 'ppt',
  name: '幻灯片 / PPT',
  description:
    '写 HTML 幻灯片，用真实浏览器渲染映射成原生可编辑 .pptx，支持助手 Canvas 预览。',
  tools: pptTools,
  content: pptSkillContent,

  async init() {
    log.info('Initialized')
  },

  async cleanup() {
    log.info('Cleaned up')
  },
}

try {
  registerSkill(pptSkill)
} catch (error) {
  log.error('Failed to register:', error)
}

export { pptSkill }
export { executePptTool } from './executor'
