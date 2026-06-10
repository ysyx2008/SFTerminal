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
  '每页是一段 HTML，系统用真实浏览器渲染后，把每个元素映射成原生 PPT 元素（文字可编辑、卡片是真形状）。',
  '布局由浏览器排版，你只管写好看的 HTML，不用手算 PPT 坐标。',
  '',
  '### 调用参数',
  '- slides：字符串数组，每项 = 一页的 body 内联 HTML。不要写 html/head/body 标签，系统自动包裹。',
  '- css：所有页共享的样式文本（配色、字体、卡片、标题样式都写这里，省 token、保持统一）。',
  '- size：widescreen（默认 16:9）或 standard（4:3）。',
  '- path：输出 .pptx 路径。',
  '',
  '### 画布与定位',
  '- 16:9 画布 = 1280 × 720 px（4:3 为 960 × 720）。页面级元素用绝对定位：position:absolute; left/top/width 单位 px。',
  '- 安全边距：四周留约 64px；底部留白 ≥ 48px（否则报溢出错误）。',
  '',
  '### 卡片排版（重要）',
  '- 卡片外壳：页面级 position:absolute 定位置与尺寸（如 left:80;top:180;width:340;height:240）。',
  '- 卡片**内部**：用自然文档流 + padding 堆叠 block 元素（h3、p、ul），**不要在卡片里再套 position:absolute**。',
  '- 徽章/标签：外层 <div> 做色块（background+border-radius），内层 <p style="margin:0"> 放文字；不要用裸文本或 span。',
  '- 标题用 h2/h3，不要用带样式的 div 冒充标题。',
  '',
  '### 硬性规则（违反会报错并要求你改）',
  '1. 文字必须放进 p / h1-h6 / ul / ol；div 里不能混有裸文本与块级子元素。',
  '2. 推荐：卡片/徽章用 div 做形状，文字放 div 内的 p / h*。文本标签带背景时系统会拆成形状+文字，但不如 div+p 清晰。',
  '3. 不支持 CSS 渐变——用纯色。整页底色：每页第一个元素放一个 class="bg" 的 div（已是整页绝对定位），style 里设 background；或在 css 里写 body 的 background。',
  '4. 项目符号用 ul + li，不要手敲圆点或减号。',
  '5. 图片用 img + 绝对路径；图表先 load_skill("chart") 出 PNG 再插入。',
  '6. 内容不能超出页面。',
  '',
  '### 推荐共享 css（传给 css 参数，按需改配色）',
  '    body{font-family:"Microsoft YaHei","PingFang SC",Arial,sans-serif;}',
  '    h1,h2,h3,p{margin:0;}',
  '    .card{background:#F8FAFC;border-radius:14px;box-shadow:0 6px 18px rgba(0,0,0,.08);}',
  '',
  '### slides 写法示例（每段是数组里的一个字符串）',
  '封面（深底 + 金色色条 + 大标题）：',
  '    <div class="bg" style="background:#1E2761"></div>',
  '    <div style="position:absolute;left:80px;top:120px;width:72px;height:8px;background:#C9A227"></div>',
  '    <h1 style="position:absolute;left:80px;top:250px;width:1000px;font-size:60px;font-weight:700;color:#fff">2025 年度工作总结</h1>',
  '    <p style="position:absolute;left:80px;top:360px;width:1000px;font-size:24px;color:#CADCFC">人工智能与实验室</p>',
  '',
  '内容页（标题色条 + 三张数据卡片，文字在卡片内用文档流）：',
  '    <div class="bg" style="background:#fff"></div>',
  '    <div style="position:absolute;left:80px;top:72px;width:6px;height:40px;background:#C9A227"></div>',
  '    <h2 style="position:absolute;left:104px;top:74px;width:1000px;font-size:34px;font-weight:700;color:#1E2761">核心成果</h2>',
  '    <div class="card" style="position:absolute;left:80px;top:180px;width:340px;height:240px;padding:24px;text-align:center">',
  '      <p style="font-size:64px;font-weight:800;color:#1E2761">20<span style="font-size:24px">P</span></p>',
  '      <p style="margin-top:8px;font-size:20px;color:#6B7280">算力规模</p>',
  '    </div>',
  '（第二、三张卡片把 left 改成 470 / 860，width 都用 340，即成三列。）',
  '',
  '两栏要点（左右各一张 card，卡内 h3 + ul 自然堆叠）：左栏 left:80;width:540，右栏 left:660;width:540。',
  '',
  '### 长 PPT 分批生成（防输出截断）',
  '页数多（≥ 8 页）时不要一次性塞进 slides，否则单次输出可能超长被截断。改为分批：',
  '1. 第一次 mode 用 replace（默认），写前 3-5 页 + 共享 css；',
  '2. 之后每次 mode="append"，同一个 path，再发 3-5 页；css 可省略（沿用首批）；',
  '3. 直到所有页写完。每次都会整本重渲并刷新预览（已渲过的页走缓存，很快）。',
  '渲染过程会显示“渲染中 i/N 页”进度。',
  '',
  '### 设计规范（避免 AI 幻灯片审美）',
  '- 三明治结构：封面/结尾用深底，内容页用浅底。',
  '- 每页一个视觉锚点（大数字卡片墙 / 图表 / 关键图），不要纯 bullet 墙。',
  '- 标题 34-44px（封面可 56px+）、正文 18-22px；强调色克制，只点缀。',
  '- 标题左侧用一根短色条（accent）代替整条下划线。',
  '- 卡片对齐成网格，行列间距统一（如 30px）。',
  '',
  '### 流程',
  '1. 调研 / 写要点，提炼关键数字。',
  '2. 写共享 css + 各页 slides（绝对定位排版）。',
  '3. 调用 ppt_from_html 导出 → 助手 Canvas 翻页确认 → PowerPoint/Keynote 打开微调。',
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
