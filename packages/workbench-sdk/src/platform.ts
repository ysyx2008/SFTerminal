/**
 * 平台壳 / 基础能力一览（薄壳：实现在 desktop，入口只认 SDK）。
 *
 * 工作台包（`packages/workbench-*`）需要复用的 UI，**必须**从本包子路径引入；
 * 禁止 `import … from '@/components/…'`。缺门牌时先提 PR 加薄壳，再引用。
 */
export { AiPanel } from './ai-panel'
export { TerminalTabView } from './terminal-tab-view'
export { WorkbenchShell } from './workbench-shell'
export { useToast, toast } from './toast'
