/**
 * html2pptx 渲染引擎（对标 Anthropic pptx skill 的 html2pptx 路线）
 *
 * 思路：AI 写 HTML（每页一张）→ 用真实 Chromium 渲染 → 读 getBoundingClientRect +
 * getComputedStyle 把每个元素映射成「原生可编辑」的 PptxGenJS 元素（文本/列表/卡片/图片/线）。
 * 布局由浏览器排版，从根上避免 AI 手算坐标导致的重叠/错乱。
 *
 * 渲染后端二选一（自动）：
 *   - Electron 内置 Chromium：真实 app 主进程下用隐藏 BrowserWindow（零额外依赖）
 *   - playwright-core + 系统浏览器：CLI / 纯 Node 下兜底（detectBrowser 找 Chrome/Edge/Chromium）
 */

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as crypto from 'crypto'
import { detectBrowser } from '../browser/detector'
import { createLogger } from '../../../../utils/logger'

const log = createLogger('Html2Pptx')

const PX_PER_IN = 96

export type DeckSize = 'widescreen' | 'standard'

interface SizeSpec {
  /** body 像素宽 */
  px: number
  pxH: number
  /** PptxGenJS layout 预设名 */
  layout: string
  /** 英寸 */
  inW: number
  inH: number
}

export const DECK_SIZES: Record<DeckSize, SizeSpec> = {
  // 16:9 13.333" × 7.5"（PowerPoint 默认宽屏）
  widescreen: { px: 1280, pxH: 720, layout: 'LAYOUT_WIDE', inW: 13.333, inH: 7.5 },
  // 4:3 10" × 7.5"
  standard: { px: 960, pxH: 720, layout: 'LAYOUT_4x3', inW: 10, inH: 7.5 },
}

const BASE_CSS = (size: SizeSpec) => `
*{box-sizing:border-box;}
html,body{margin:0;padding:0;}
body{
  width:${size.px}px;height:${size.pxH}px;
  position:relative;overflow:visible;
  background:#ffffff;color:#1f2937;
  font-family:"Microsoft YaHei","PingFang SC","Helvetica Neue",Arial,sans-serif;
}
.bg{position:absolute;inset:0;}
`

/** 把「一页 slide 的 body 内联 HTML」包成完整可渲染文档 */
export function wrapSlideHtml(inner: string, sharedCss: string, size: SizeSpec): string {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<style>${BASE_CSS(size)}${sharedCss || ''}</style></head>
<body>${inner}</body></html>`
}

// ---------------------------------------------------------------------------
// 提取脚本：在页面上下文执行，返回该页的结构化数据（移植自 Anthropic html2pptx）
// 必须是一个 async IIFE 字符串，Electron executeJavaScript 与 Playwright evaluate 都能跑。
// ---------------------------------------------------------------------------

const EXTRACTION_SCRIPT = `(async () => {
  try { await (document.fonts && document.fonts.ready); } catch (e) {}

  const PT_PER_PX = 0.75;
  const PX_PER_IN = 96;
  const errors = [];

  const SINGLE_WEIGHT_FONTS = ['impact'];
  const shouldSkipBold = (ff) => {
    if (!ff) return false;
    const n = ff.toLowerCase().replace(/['"]/g, '').split(',')[0].trim();
    return SINGLE_WEIGHT_FONTS.includes(n);
  };
  const pxToInch = (px) => px / PX_PER_IN;
  const pxToPoints = (s) => parseFloat(s) * PT_PER_PX;
  const rgbToHex = (s) => {
    if (s === 'rgba(0, 0, 0, 0)' || s === 'transparent') return 'FFFFFF';
    const m = s.match(/rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)/);
    if (!m) return 'FFFFFF';
    return m.slice(1).map(n => parseInt(n).toString(16).padStart(2, '0')).join('');
  };
  const extractAlpha = (s) => {
    const m = s.match(/rgba\\((\\d+),\\s*(\\d+),\\s*(\\d+),\\s*([\\d.]+)\\)/);
    if (!m || !m[4]) return null;
    return Math.round((1 - parseFloat(m[4])) * 100);
  };
  const applyTextTransform = (t, tt) => {
    if (tt === 'uppercase') return t.toUpperCase();
    if (tt === 'lowercase') return t.toLowerCase();
    if (tt === 'capitalize') return t.replace(/\\b\\w/g, c => c.toUpperCase());
    return t;
  };
  const getRotation = (transform, writingMode) => {
    let angle = 0;
    if (writingMode === 'vertical-rl') angle = 90;
    else if (writingMode === 'vertical-lr') angle = 270;
    if (transform && transform !== 'none') {
      const r = transform.match(/rotate\\((-?\\d+(?:\\.\\d+)?)deg\\)/);
      if (r) angle += parseFloat(r[1]);
      else {
        const mm = transform.match(/matrix\\(([^)]+)\\)/);
        if (mm) {
          const v = mm[1].split(',').map(parseFloat);
          angle += Math.round(Math.atan2(v[1], v[0]) * (180 / Math.PI));
        }
      }
    }
    angle = angle % 360; if (angle < 0) angle += 360;
    return angle === 0 ? null : angle;
  };
  const getPositionAndSize = (el, rect, rotation) => {
    if (rotation === null) return { x: rect.left, y: rect.top, w: rect.width, h: rect.height };
    const isVertical = rotation === 90 || rotation === 270;
    if (isVertical) {
      const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
      return { x: cx - rect.height / 2, y: cy - rect.width / 2, w: rect.height, h: rect.width };
    }
    const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
    return { x: cx - el.offsetWidth / 2, y: cy - el.offsetHeight / 2, w: el.offsetWidth, h: el.offsetHeight };
  };
  const parseBoxShadow = (bs) => {
    if (!bs || bs === 'none') return null;
    if (bs.match(/inset/)) return null;
    const colorMatch = bs.match(/rgba?\\([^)]+\\)/);
    const parts = bs.match(/([-\\d.]+)(px|pt)/g);
    if (!parts || parts.length < 2) return null;
    const ox = parseFloat(parts[0]), oy = parseFloat(parts[1]);
    const blur = parts.length > 2 ? parseFloat(parts[2]) : 0;
    let angle = 0;
    if (ox !== 0 || oy !== 0) { angle = Math.atan2(oy, ox) * (180 / Math.PI); if (angle < 0) angle += 360; }
    const offset = Math.sqrt(ox * ox + oy * oy) * PT_PER_PX;
    let opacity = 0.5;
    if (colorMatch) { const om = colorMatch[0].match(/[\\d.]+\\)$/); if (om) opacity = parseFloat(om[0].replace(')', '')); }
    return { type: 'outer', angle: Math.round(angle), blur: blur * 0.75, color: colorMatch ? rgbToHex(colorMatch[0]) : '000000', offset, opacity };
  };
  const parseInlineFormatting = (element, baseOptions, runs, baseTextTransform) => {
    baseOptions = baseOptions || {}; runs = runs || []; baseTextTransform = baseTextTransform || ((x) => x);
    let prevText = false;
    element.childNodes.forEach((node) => {
      let textTransform = baseTextTransform;
      const isText = node.nodeType === Node.TEXT_NODE || node.tagName === 'BR';
      if (isText) {
        const text = node.tagName === 'BR' ? '\\n' : textTransform(node.textContent.replace(/\\s+/g, ' '));
        const prev = runs[runs.length - 1];
        if (prevText && prev) prev.text += text;
        else runs.push({ text, options: Object.assign({}, baseOptions) });
      } else if (node.nodeType === Node.ELEMENT_NODE && node.textContent.trim()) {
        const options = Object.assign({}, baseOptions);
        const c = window.getComputedStyle(node);
        const tag = node.tagName;
        if (['SPAN','B','STRONG','I','EM','U'].includes(tag)) {
          const isBold = c.fontWeight === 'bold' || parseInt(c.fontWeight) >= 600;
          if (isBold && !shouldSkipBold(c.fontFamily)) options.bold = true;
          if (c.fontStyle === 'italic') options.italic = true;
          if (c.textDecoration && c.textDecoration.includes('underline')) options.underline = true;
          if (c.color && c.color !== 'rgb(0, 0, 0)') {
            options.color = rgbToHex(c.color);
            const tr = extractAlpha(c.color); if (tr !== null) options.transparency = tr;
          }
          if (c.fontSize) options.fontSize = pxToPoints(c.fontSize);
          if (c.textTransform && c.textTransform !== 'none') { const ts = c.textTransform; textTransform = (t) => applyTextTransform(t, ts); }
          parseInlineFormatting(node, options, runs, textTransform);
        }
      }
      prevText = isText;
    });
    if (runs.length > 0) {
      runs[0].text = runs[0].text.replace(/^\\s+/, '');
      runs[runs.length - 1].text = runs[runs.length - 1].text.replace(/\\s+$/, '');
    }
    return runs.filter(r => r.text.length > 0);
  };

  const body = document.body;
  const bodyStyle = window.getComputedStyle(body);
  const bgImage = bodyStyle.backgroundImage;
  const bgColor = bodyStyle.backgroundColor;

  if (bgImage && (bgImage.includes('linear-gradient') || bgImage.includes('radial-gradient'))) {
    errors.push('body 用了 CSS 渐变背景，PPTX 不支持。请改用纯色背景（body{background:#1E2761}）或一个 .bg 纯色 div。');
  }

  let background;
  if (bgImage && bgImage !== 'none') {
    const um = bgImage.match(/url\\(["']?([^"')]+)["']?\\)/);
    background = um ? { type: 'image', path: um[1] } : { type: 'color', value: rgbToHex(bgColor) };
  } else {
    background = { type: 'color', value: rgbToHex(bgColor) };
  }

  const elements = [];
  const placeholders = [];
  const textTags = ['P','H1','H2','H3','H4','H5','H6','UL','OL','LI'];
  const processed = new Set();

  document.querySelectorAll('*').forEach((el) => {
    if (processed.has(el)) return;

    if (textTags.includes(el.tagName)) {
      const c = window.getComputedStyle(el);
      const hasBg = c.backgroundColor && c.backgroundColor !== 'rgba(0, 0, 0, 0)';
      const hasBorder = ['borderTopWidth','borderRightWidth','borderBottomWidth','borderLeftWidth'].some(k => parseFloat(c[k]) > 0);
      const hasShadow = c.boxShadow && c.boxShadow !== 'none';
      if (hasBg || hasBorder || hasShadow) {
        errors.push('文本元素 <' + el.tagName.toLowerCase() + '> 带了背景/边框/阴影。卡片请用 <div> 容器，文字放在容器内的 <p>/<h*> 里。');
        return;
      }
    }

    if (el.className && typeof el.className === 'string' && el.className.includes('placeholder')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) errors.push('placeholder "' + (el.id || 'unnamed') + '" 宽或高为 0，检查布局。');
      else placeholders.push({ id: el.id || ('placeholder-' + placeholders.length), x: pxToInch(r.left), y: pxToInch(r.top), w: pxToInch(r.width), h: pxToInch(r.height) });
      processed.add(el); return;
    }

    if (el.tagName === 'IMG') {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        elements.push({ type: 'image', src: el.src, position: { x: pxToInch(r.left), y: pxToInch(r.top), w: pxToInch(r.width), h: pxToInch(r.height) } });
        processed.add(el); return;
      }
    }

    const isContainer = el.tagName === 'DIV';
    if (isContainer) {
      const c = window.getComputedStyle(el);
      const hasBg = c.backgroundColor && c.backgroundColor !== 'rgba(0, 0, 0, 0)';
      for (const node of el.childNodes) {
        if (node.nodeType === Node.TEXT_NODE) {
          const t = node.textContent.trim();
          if (t) errors.push('DIV 里有未包裹的文本 "' + t.substring(0, 40) + '"。所有文字必须放进 <p>/<h1>-<h6>/<ul>/<ol>。');
        }
      }
      const bgi = c.backgroundImage;
      if (bgi && bgi !== 'none') {
        if (bgi.includes('gradient')) { errors.push('DIV 用了 CSS 渐变，PPTX 不支持，请用纯色。'); return; }
        errors.push('DIV 的 background-image 不支持。请用纯色/边框，或用 <img> 单独放图片。'); return;
      }
      const bt = c.borderTopWidth, br = c.borderRightWidth, bb = c.borderBottomWidth, bl = c.borderLeftWidth;
      const borders = [bt, br, bb, bl].map(b => parseFloat(b) || 0);
      const hasBorder = borders.some(b => b > 0);
      const hasUniformBorder = hasBorder && borders.every(b => b === borders[0]);
      const borderLines = [];
      const rectFor = () => el.getBoundingClientRect();
      if (hasBorder && !hasUniformBorder) {
        const r = rectFor();
        const x = pxToInch(r.left), y = pxToInch(r.top), w = pxToInch(r.width), h = pxToInch(r.height);
        const mk = (cond, wstr, cstr, coords) => {
          if (parseFloat(cond) > 0) {
            const wp = pxToPoints(wstr); const inset = (wp / 72) / 2;
            borderLines.push(Object.assign({ type: 'line', width: wp, color: rgbToHex(cstr) }, coords(inset)));
          }
        };
        mk(bt, bt, c.borderTopColor, (i) => ({ x1: x, y1: y + i, x2: x + w, y2: y + i }));
        mk(br, br, c.borderRightColor, (i) => ({ x1: x + w - i, y1: y, x2: x + w - i, y2: y + h }));
        mk(bb, bb, c.borderBottomColor, (i) => ({ x1: x, y1: y + h - i, x2: x + w, y2: y + h - i }));
        mk(bl, bl, c.borderLeftColor, (i) => ({ x1: x + i, y1: y, x2: x + i, y2: y + h }));
      }
      if (hasBg || hasBorder) {
        const r = rectFor();
        if (r.width > 0 && r.height > 0) {
          const shadow = parseBoxShadow(c.boxShadow);
          if (hasBg || hasUniformBorder) {
            elements.push({
              type: 'shape', text: '',
              position: { x: pxToInch(r.left), y: pxToInch(r.top), w: pxToInch(r.width), h: pxToInch(r.height) },
              shape: {
                fill: hasBg ? rgbToHex(c.backgroundColor) : null,
                transparency: hasBg ? extractAlpha(c.backgroundColor) : null,
                line: hasUniformBorder ? { color: rgbToHex(c.borderColor), width: pxToPoints(c.borderWidth) } : null,
                rectRadius: (() => {
                  const radius = c.borderRadius; const rv = parseFloat(radius);
                  if (rv === 0) return 0;
                  if (radius.includes('%')) { if (rv >= 50) return 1; const md = Math.min(r.width, r.height); return (rv / 100) * pxToInch(md); }
                  if (radius.includes('pt')) return rv / 72;
                  return rv / PX_PER_IN;
                })(),
                shadow: shadow,
              },
            });
          }
          for (const bln of borderLines) elements.push(bln);
          processed.add(el); return;
        }
      }
    }

    if (el.tagName === 'UL' || el.tagName === 'OL') {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return;
      const lis = Array.from(el.querySelectorAll('li'));
      const items = [];
      const ulC = window.getComputedStyle(el);
      const ulPad = pxToPoints(ulC.paddingLeft);
      const marginLeft = ulPad * 0.5, textIndent = ulPad * 0.5;
      lis.forEach((li, idx) => {
        const isLast = idx === lis.length - 1;
        const runs = parseInlineFormatting(li, { breakLine: false }, [], (x) => x);
        if (runs.length > 0) { runs[0].text = runs[0].text.replace(/^[•\\-\\*▪▸]\\s*/, ''); runs[0].options.bullet = { indent: textIndent }; }
        if (runs.length > 0 && !isLast) runs[runs.length - 1].options.breakLine = true;
        for (const rn of runs) items.push(rn);
      });
      const c = window.getComputedStyle(lis[0] || el);
      elements.push({
        type: 'list', items,
        position: { x: pxToInch(r.left), y: pxToInch(r.top), w: pxToInch(r.width), h: pxToInch(r.height) },
        style: {
          fontSize: pxToPoints(c.fontSize),
          fontFace: c.fontFamily.split(',')[0].replace(/['"]/g, '').trim(),
          color: rgbToHex(c.color),
          transparency: extractAlpha(c.color),
          align: c.textAlign === 'start' ? 'left' : c.textAlign,
          lineSpacing: c.lineHeight && c.lineHeight !== 'normal' ? pxToPoints(c.lineHeight) : null,
          paraSpaceBefore: 0,
          paraSpaceAfter: pxToPoints(c.marginBottom),
          margin: [marginLeft, 0, 0, 0],
        },
      });
      lis.forEach(li => processed.add(li)); processed.add(el); return;
    }

    if (!textTags.includes(el.tagName)) return;
    const r = el.getBoundingClientRect();
    const text = el.textContent.trim();
    if (r.width === 0 || r.height === 0 || !text) return;
    if (el.tagName !== 'LI' && /^[•\\-\\*▪▸○●◆◇■□]\\s/.test(text.trimStart())) {
      errors.push('文本 <' + el.tagName.toLowerCase() + '> 以项目符号开头，请改用 <ul>/<ol> 列表。');
      return;
    }
    const c = window.getComputedStyle(el);
    const rotation = getRotation(c.transform, c.writingMode);
    const ps = getPositionAndSize(el, r, rotation);
    const baseStyle = {
      fontSize: pxToPoints(c.fontSize),
      fontFace: c.fontFamily.split(',')[0].replace(/['"]/g, '').trim(),
      color: rgbToHex(c.color),
      align: c.textAlign === 'start' ? 'left' : c.textAlign,
      lineSpacing: pxToPoints(c.lineHeight),
      paraSpaceBefore: pxToPoints(c.marginTop),
      paraSpaceAfter: pxToPoints(c.marginBottom),
      margin: [pxToPoints(c.paddingLeft), pxToPoints(c.paddingRight), pxToPoints(c.paddingBottom), pxToPoints(c.paddingTop)],
    };
    const tr = extractAlpha(c.color); if (tr !== null) baseStyle.transparency = tr;
    if (rotation !== null) baseStyle.rotate = rotation;
    const hasFmt = el.querySelector('b, i, u, strong, em, span, br');
    if (hasFmt) {
      const ts = c.textTransform;
      const runs = parseInlineFormatting(el, {}, [], (s) => applyTextTransform(s, ts));
      const adj = Object.assign({}, baseStyle);
      if (adj.lineSpacing) {
        const maxFs = Math.max(adj.fontSize, ...runs.map(rn => (rn.options && rn.options.fontSize) || 0));
        if (maxFs > adj.fontSize) { const mult = adj.lineSpacing / adj.fontSize; adj.lineSpacing = maxFs * mult; }
      }
      elements.push({ type: el.tagName.toLowerCase(), text: runs, position: { x: pxToInch(ps.x), y: pxToInch(ps.y), w: pxToInch(ps.w), h: pxToInch(ps.h) }, style: adj });
    } else {
      const tt = c.textTransform;
      const transformed = applyTextTransform(text, tt);
      const isBold = c.fontWeight === 'bold' || parseInt(c.fontWeight) >= 600;
      elements.push({
        type: el.tagName.toLowerCase(), text: transformed,
        position: { x: pxToInch(ps.x), y: pxToInch(ps.y), w: pxToInch(ps.w), h: pxToInch(ps.h) },
        style: Object.assign({}, baseStyle, { bold: isBold && !shouldSkipBold(c.fontFamily), italic: c.fontStyle === 'italic', underline: c.textDecoration.includes('underline') }),
      });
    }
    processed.add(el);
  });

  // 溢出检测
  const bw = parseFloat(bodyStyle.width), bh = parseFloat(bodyStyle.height);
  const overW = Math.max(0, body.scrollWidth - bw - 1);
  const overH = Math.max(0, body.scrollHeight - bh - 1);
  if (overW * PT_PER_PX > 0 || overH * PT_PER_PX > 0) {
    const dir = [];
    if (overW > 0) dir.push('横向 ' + (overW * PT_PER_PX).toFixed(0) + 'pt');
    if (overH > 0) dir.push('纵向 ' + (overH * PT_PER_PX).toFixed(0) + 'pt');
    errors.push('内容超出页面 ' + dir.join(' 和 ') + '，请精简内容或缩小字号（底部留白 ≥ 0.5"）。');
  }

  return { width: bw, height: bh, background, elements, placeholders, errors };
})()`

// ---------------------------------------------------------------------------
// 渲染后端
// ---------------------------------------------------------------------------

export interface SlideData {
  width: number
  height: number
  background: { type: 'color'; value: string } | { type: 'image'; path: string }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  elements: any[]
  placeholders: { id: string; x: number; y: number; w: number; h: number }[]
  errors: string[]
}

interface RenderBackend {
  render(html: string): Promise<SlideData>
  close(): Promise<void>
}

/**
 * 统一用 playwright-core 启动系统浏览器（headless，独立进程）。
 * 与 browser 技能同款做法：渲染在独立进程，绝不阻塞 Electron 主进程事件循环
 * （早期试过在主进程开隐藏 BrowserWindow，会冻住整个 UI，已弃用）。
 */
async function createBackend(size: SizeSpec): Promise<RenderBackend> {
  const info = detectBrowser()
  if (!info || info.type !== 'chromium') {
    throw new Error('NO_BROWSER')
  }
  const { chromium } = await import('playwright-core')
  const browser = await chromium.launch({
    executablePath: info.executablePath,
    headless: true,
    args: ['--no-first-run', '--no-default-browser-check', '--disable-extensions'],
  })

  return {
    async render(html: string): Promise<SlideData> {
      const tmp = await writeTempHtml(html)
      const page = await browser.newPage({
        viewport: { width: size.px, height: size.pxH },
        deviceScaleFactor: 1,
      })
      try {
        await page.goto('file://' + tmp, { waitUntil: 'load' })
        const data = (await page.evaluate(EXTRACTION_SCRIPT)) as SlideData
        return data
      } finally {
        await page.close()
        await safeUnlink(tmp)
      }
    },
    async close() {
      try {
        await browser.close()
      } catch {
        /* ignore */
      }
    },
  }
}

let tmpCounter = 0
async function writeTempHtml(html: string): Promise<string> {
  const dir = path.join(os.tmpdir(), 'sft-ppt')
  await fs.promises.mkdir(dir, { recursive: true })
  const file = path.join(dir, `slide-${process.pid}-${Date.now()}-${tmpCounter++}.html`)
  await fs.promises.writeFile(file, html, 'utf-8')
  return file
}
async function safeUnlink(file: string): Promise<void> {
  try { await fs.promises.unlink(file) } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// 纯映射器：SlideData → PptxGenJS slide（不依赖浏览器，可单测）
// ---------------------------------------------------------------------------

function stripFile(p: string): string {
  return p.startsWith('file://') ? decodeURIComponent(p.replace('file://', '')) : p
}

const VALID_ALIGN = new Set(['left', 'center', 'right', 'justify'])

/**
 * 清洗 PptxGenJS option：剔除 null/undefined/NaN/空串，把非法 align、坏 margin 丢弃。
 * 浏览器抽取出的 lineSpacing 可能为 null、fontSize 在缺省时可能 NaN——这些值
 * 直传 pptxgenjs 会生成 LibreOffice 容忍、但 PowerPoint 判定损坏（"需要修复"）的 OOXML。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function cleanOpts(opt: Record<string, any>): Record<string, any> {
  if (opt.align !== undefined && !VALID_ALIGN.has(opt.align)) delete opt.align
  if (opt.fontFace !== undefined && (typeof opt.fontFace !== 'string' || !opt.fontFace.trim())) {
    delete opt.fontFace
  }
  // lineSpacing / fontSize 必须为正，否则 PowerPoint 判损坏
  if (opt.lineSpacing !== undefined && !(opt.lineSpacing > 0)) delete opt.lineSpacing
  if (opt.fontSize !== undefined && !(opt.fontSize > 0)) delete opt.fontSize
  // 段间距不能为负
  for (const k of ['paraSpaceBefore', 'paraSpaceAfter']) {
    if (typeof opt[k] === 'number' && opt[k] < 0) opt[k] = 0
  }
  if (opt.margin !== undefined) {
    const sanitize = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) ? Math.max(0, n) : null)
    if (Array.isArray(opt.margin)) {
      const m = opt.margin.map(sanitize)
      if (m.some((n: number | null) => n === null)) delete opt.margin
      else opt.margin = m
    } else {
      const m = sanitize(opt.margin)
      if (m === null) delete opt.margin
      else opt.margin = m
    }
  }
  for (const k of Object.keys(opt)) {
    const v = opt[k]
    if (v === null || v === undefined) delete opt[k]
    else if (typeof v === 'number' && !Number.isFinite(v)) delete opt[k]
  }
  return opt
}

// pptxgenjs 把 shadow.blur/offset 当“点(pt)”，再 ×12700 转 EMU。正常阴影 blur≤~30pt、
// offset≤~20pt。若上游（含历史脏缓存）误传了 EMU 量级的值（如 190500），会被再次 ×12700
// 放大成数十亿 EMU，PowerPoint 判文件损坏、且超大阴影会盖住整张卡片。这里钳到合理点值区间。
const SHADOW_MAX_BLUR_PT = 50
const SHADOW_MAX_OFFSET_PT = 30
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function sanitizeShadow(s: any): any {
  if (!s || typeof s !== 'object') return null
  if (s.type && s.type !== 'outer' && s.type !== 'inner') return null
  const num = (v: unknown, max: number, dflt: number) => {
    const n = Number(v)
    if (!Number.isFinite(n) || n < 0) return dflt
    return Math.min(n, max)
  }
  const opacity = Number(s.opacity)
  const angle = Number(s.angle)
  return {
    type: s.type === 'inner' ? 'inner' : 'outer',
    blur: num(s.blur, SHADOW_MAX_BLUR_PT, 0),
    offset: num(s.offset, SHADOW_MAX_OFFSET_PT, 0),
    angle: Number.isFinite(angle) ? ((Math.round(angle) % 360) + 360) % 360 : 0,
    color: typeof s.color === 'string' && /^[0-9A-Fa-f]{6}$/.test(s.color) ? s.color : '000000',
    opacity: Number.isFinite(opacity) ? Math.min(Math.max(opacity, 0), 1) : 0.5,
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function applyBackground(slide: any, data: SlideData): void {
  if (data.background.type === 'image' && data.background.path) {
    slide.background = { path: stripFile(data.background.path) }
  } else if (data.background.type === 'color' && data.background.value) {
    slide.background = { color: data.background.value }
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function applyElements(slide: any, data: SlideData, pres: any): void {
  for (const el of data.elements) {
    if (el.type === 'image') {
      slide.addImage({ path: stripFile(el.src), x: el.position.x, y: el.position.y, w: el.position.w, h: el.position.h })
    } else if (el.type === 'line') {
      slide.addShape(pres.ShapeType.line, { x: el.x1, y: el.y1, w: el.x2 - el.x1, h: el.y2 - el.y1, line: { color: el.color, width: el.width } })
    } else if (el.type === 'shape') {
      // roundRect 的 adj = rectRadius/短边 × 100000，OOXML 合法区间 0~50000（0~50%）。
      // 超出会让 PowerPoint 判文件损坏（border-radius:50% 的圆形、圆角大于半边的细条等）。
      // 钳到短边的一半，确保 adj ≤ 50000。
      const maxRadius = Math.min(el.position.w, el.position.h) / 2
      const rectRadius =
        Number.isFinite(el.shape.rectRadius) && el.shape.rectRadius > 0
          ? Math.min(el.shape.rectRadius, maxRadius)
          : 0
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const opt: any = {
        x: el.position.x, y: el.position.y, w: el.position.w, h: el.position.h,
        shape: rectRadius > 0 ? pres.ShapeType.roundRect : pres.ShapeType.rect,
      }
      if (el.shape.fill) {
        opt.fill = { color: el.shape.fill }
        if (el.shape.transparency != null && Number.isFinite(el.shape.transparency)) {
          opt.fill.transparency = el.shape.transparency
        }
      }
      if (el.shape.line && el.shape.line.color) {
        opt.line = { color: el.shape.line.color }
        if (Number.isFinite(el.shape.line.width)) opt.line.width = el.shape.line.width
      }
      if (rectRadius > 0) opt.rectRadius = rectRadius
      const shadow = sanitizeShadow(el.shape.shadow)
      if (shadow) opt.shadow = shadow
      slide.addText(el.text || '', cleanOpts(opt))
    } else if (el.type === 'list') {
      if (!Array.isArray(el.items) || el.items.length === 0) continue
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const opt: any = {
        x: el.position.x, y: el.position.y, w: el.position.w, h: el.position.h,
        fontSize: el.style.fontSize, fontFace: el.style.fontFace, color: el.style.color,
        align: el.style.align, valign: 'top', lineSpacing: el.style.lineSpacing,
        paraSpaceBefore: el.style.paraSpaceBefore, paraSpaceAfter: el.style.paraSpaceAfter, margin: el.style.margin,
      }
      slide.addText(el.items, cleanOpts(opt))
    } else {
      if (Array.isArray(el.text) ? el.text.length === 0 : !el.text) continue
      const lineHeight = el.style.lineSpacing || el.style.fontSize * 1.2
      const isSingleLine = el.position.h <= lineHeight * 1.5
      let x = el.position.x, w = el.position.w
      if (isSingleLine) {
        const inc = el.position.w * 0.02
        if (el.style.align === 'center') { x = el.position.x - inc / 2; w = el.position.w + inc }
        else if (el.style.align === 'right') { x = el.position.x - inc; w = el.position.w + inc }
        else { w = el.position.w + inc }
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const opt: any = {
        x, y: el.position.y, w, h: el.position.h,
        fontSize: el.style.fontSize, fontFace: el.style.fontFace, color: el.style.color,
        bold: el.style.bold, italic: el.style.italic, underline: el.style.underline,
        valign: 'top', lineSpacing: el.style.lineSpacing,
        paraSpaceBefore: el.style.paraSpaceBefore, paraSpaceAfter: el.style.paraSpaceAfter, inset: 0,
      }
      if (el.style.align) opt.align = el.style.align
      if (el.style.margin) opt.margin = el.style.margin
      if (el.style.rotate !== undefined) opt.rotate = el.style.rotate
      if (el.style.transparency != null) opt.transparency = el.style.transparency
      slide.addText(el.text, cleanOpts(opt))
    }
  }
}

// ---------------------------------------------------------------------------
// 对外入口
// ---------------------------------------------------------------------------

export interface RenderHtmlToPptxOptions {
  slides: string[]
  css?: string
  outputPath: string
  title?: string
  size?: DeckSize
}

export interface RenderHtmlToPptxResult {
  outputPath: string
  slideCount: number
}

export class PptValidationError extends Error {
  issues: string[]
  constructor(issues: string[]) {
    super('PPT_VALIDATION_FAILED:\n' + issues.join('\n'))
    this.name = 'PptValidationError'
    this.issues = issues
  }
}

export interface RenderProgress {
  /** 已就绪页数（含缓存命中） */
  done: number
  /** 总页数 */
  total: number
}

export interface RenderControls {
  onProgress?: (p: RenderProgress) => void
  isAborted?: () => boolean
}

// 按页渲染缓存：key = sha1(version + layout + css + slide html)。append 重渲整本时旧页秒回。
// EXTRACTION_VERSION 必须在每次改动提取脚本/SlideData 结构时 +1，否则长驻进程里旧版渲染结果
// 会被复用（HMR 热更新代码但模块级 Map 残留），导致修复对未变内容不生效（曾因此让阴影脏数据残留）。
const EXTRACTION_VERSION = 2
const renderCache = new Map<string, SlideData>()
const RENDER_CACHE_CAP = 300

function cacheKey(size: SizeSpec, css: string, html: string): string {
  return crypto
    .createHash('sha1')
    .update(`v${EXTRACTION_VERSION}\n${size.layout}\n${css}\n${html}`)
    .digest('hex')
}
function cacheStore(key: string, data: SlideData): void {
  renderCache.set(key, data)
  if (renderCache.size > RENDER_CACHE_CAP) {
    const oldest = renderCache.keys().next().value
    if (oldest !== undefined) renderCache.delete(oldest)
  }
}

/** 渲染所有 slide → 结构化数据（命中缓存的页不重渲；含校验错误聚合，不写盘） */
export async function renderSlides(
  slides: string[],
  css: string,
  size: SizeSpec,
  controls?: RenderControls
): Promise<SlideData[]> {
  const total = slides.length
  const keys = slides.map((s) => cacheKey(size, css, s))
  const results: (SlideData | undefined)[] = keys.map((k) => renderCache.get(k))
  const todo = results.map((r, i) => (r ? -1 : i)).filter((i) => i >= 0)

  let done = total - todo.length
  controls?.onProgress?.({ done, total })

  if (todo.length > 0) {
    const backend = await createBackend(size)
    try {
      for (const i of todo) {
        if (controls?.isAborted?.()) throw new Error('ABORTED')
        const data = await backend.render(wrapSlideHtml(slides[i], css, size))
        results[i] = data
        cacheStore(keys[i], data)
        done++
        controls?.onProgress?.({ done, total })
      }
    } finally {
      await backend.close()
    }
  }
  return results as SlideData[]
}

export async function renderHtmlToPptx(
  options: RenderHtmlToPptxOptions,
  controls?: RenderControls
): Promise<RenderHtmlToPptxResult> {
  const slides = (options.slides || []).filter((s) => s && s.trim())
  if (slides.length === 0) throw new Error('NO_SLIDES')

  const size = DECK_SIZES[options.size || 'widescreen']
  const datas = await renderSlides(slides, options.css || '', size, controls)

  // 聚合校验错误（按页标注）
  const issues: string[] = []
  datas.forEach((d, i) => {
    for (const e of d.errors || []) issues.push(`第 ${i + 1} 页：${e}`)
  })
  if (issues.length > 0) throw new PptValidationError(issues)

  const pptxModule = await import('pptxgenjs')
  const PptxGenJS = pptxModule.default
  const pres = new PptxGenJS()
  pres.layout = size.layout
  pres.author = 'SailFish'
  pres.title = options.title || path.basename(options.outputPath, '.pptx')

  for (const d of datas) {
    const slide = pres.addSlide()
    applyBackground(slide, d)
    applyElements(slide, d, pres)
  }

  const dir = path.dirname(options.outputPath)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  await pres.writeFile({ fileName: options.outputPath })
  log.info(`Wrote ${datas.length} slides (html2pptx) to ${options.outputPath}`)

  return { outputPath: options.outputPath, slideCount: datas.length }
}
