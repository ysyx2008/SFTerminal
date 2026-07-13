/**
 * 同款对话区正式出口（W7 第一步）。
 *
 * 组件实现仍在 desktop `src/components/AiPanel.vue`（依赖 store/子组件尚未解耦）。
 * 工作台包应从此处 import，禁止再写 `@/components/AiPanel`。
 * 后续 P2 会把实现迁入本包并去掉对 desktop 的反向依赖。
 */
export { default as AiPanel } from '../../../src/components/AiPanel.vue'
