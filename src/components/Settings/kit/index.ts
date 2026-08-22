/**
 * 控制面板基础件。
 *
 * 设计目标见 src/components/Settings/SPEC.md。要点：
 * - 加入制：页面不引用就不受影响，新增/修改基础件不会波及未迁移的页面
 * - 约束结构而非仅外观：名称、描述等走 prop，插槽只留给控件
 * - 尺寸只取自 main.css 的设计令牌（--sp-* / --radius-* / --fs-*），不写裸数值
 */
export { default as SettingsPage } from './SettingsPage.vue'
export { default as SettingsGroup } from './SettingsGroup.vue'
export { default as SettingRow } from './SettingRow.vue'
export { default as SettingToggle } from './SettingToggle.vue'
export { default as SettingSegmented } from './SettingSegmented.vue'
export { default as SettingField } from './SettingField.vue'
export { default as SettingHelp } from './SettingHelp.vue'
