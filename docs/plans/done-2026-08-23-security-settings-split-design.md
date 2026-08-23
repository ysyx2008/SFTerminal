# 「安全与权限」拆成两页

落盘日期：2026-08-23
状态：**已完成**

## 背景

设置面板里「安全与权限」一页装了两大块内容，靠页内子标签切换。子标签一开始复用了
档位切换控件（`SettingSegmented`），读起来像「某个设置项选中的值」而不是「你正在看
哪一块」，已在 46b71945 改为专用的下划线标签条 `SettingsTabs`。

标签条只解决了「不像话」，没解决根子：这两块内容各自都够一整页，不是「同一批东西的
两个看法」。对照技能页的「我的技能 / 技能市场」——那才是标签条的正当用法。

结论：把这一页拆成侧栏里两条独立的页，新起一个「安全」分组放在「集成」后面。

## 现状勘察

`src/components/Settings/UserAllowlistSettings.vue`，2205 行，模板里两半的边界：

| 半边 | 模板行区间 | 内容 |
|---|---|---|
| 命令规则 | 480–939 | 我的命令规则（增删表单 + 列表）、内置命令风险基线（长表 + 筛选 + 搜索）、系统路径分级（只读）、工作区路径分区 |
| 风险策略 | 940–尾 | 各风险级别处置矩阵、预设、保存/重置 |

两个坑：

**坑一：`CommandRiskPolicy` 被两半同时编辑。**「命令规则」半边末尾的「工作区路径分区」
里有 `outsideWritesUpgrade` 开关和 `extraFreeDirs` 追加列表，都是 policy 对象的字段，
而且那一块自己还有一个独立的保存按钮（模板 922 行），和「风险策略」半边的保存按钮
（1037 行）调的是同一个 `savePolicy()`，保存的是同一整个对象。

这不是可以简单切开的耦合——按语义，「工作区路径分区」确实属于「怎么给命令定风险」
（改的是路径分区规则，影响定级），该留在「命令规则」页；「处置矩阵」属于「定完级
怎么处理」，在「风险策略」页。所以两页都要读写同一个 policy 对象。

**坑二：页面自己手搓了一套帮助浮层。** `openHelpTip` / `helpTipPos` / `placeHelpTip` /
`closePolicyTip` / `onPolicyTipKeydown` 加 Teleport 标记，约 90 行，两半都在用
（policy tip、userRule tip、cmdCol tip 三类）。kit 里已有 `SettingHelp` 是同一个东西
的通用版（slot 传内容、自己定位、自己管关闭）。

## 方案

### 1. 侧栏

`SettingsModal.vue`：

- `SettingsTab` 联合类型里 `'securityPermissions'` → `'commandRules' | 'riskPolicy'`，
  `ALL_TABS` 同步
- 新增分组，排在「集成」之后：
  ```
  { label: t('settings.groups.security'), tabs: [
      { id: 'commandRules', label: t('settings.tabs.commandRules'), icon: '🔐' },
      { id: 'riskPolicy',   label: t('settings.tabs.riskPolicy'),   icon: '⚖️' },
  ]}
  ```
- 「系统」分组去掉 `securityPermissions`（8 条 → 7 条）
- 渲染分支：`UserAllowlistSettings` → `CommandRulesSettings` / `RiskPolicySettings`
- Steam 版分支（421 行起）本来就不含这一页，不动

### 2. 组件拆分

`UserAllowlistSettings.vue` 删除，产出：

- `CommandRulesSettings.vue` —— 我的命令规则 / 内置基线表 / 系统路径分级 / 工作区路径分区
- `RiskPolicySettings.vue` —— 处置矩阵 / 预设

两页各自 `SettingsPage`，标题取 `t('settings.tabs.commandRules')` / `t('settings.tabs.riskPolicy')`，
不再有 `#tabs` 插槽。`switchSubTab` / `activeSubTab` / `subTabOptions` 一并删除。

各页 `onMounted` 只加载自己要的数据：命令规则页拉 builtin rules + user rules + policy；
风险策略页只拉 policy。比现状（首屏就把 builtin 表拉下来）略省。

### 3. policy 读写抽成共用件

新增 `src/components/Settings/composables/useRiskPolicy.ts`，把这些搬进去：

`DEFAULT_POLICY` / `policy` / `savedPolicy` / `policyLoaded` / `policyLoading` /
`policySaving` / `policySaved` / `policyError` / `clonePolicy` / `policiesEqual` /
`mergePolicy` / `loadPolicy` / `savePolicy` / `policyUnsaved` / `policyDiffersFromDefault`

两页各自调用，各自持有一份实例。每次进页面重新 load，保存时写整个对象。

与现状的差别：现状是一个组件实例内两个 tab 共享一份 policy ref；拆开后是各页进入时
各自重新加载。语义上更新鲜，不会出现「在 A 半边改了没保存、切到 B 半边看到脏值」。

`POLICY_ALLOWED_LEVELS`、风险等级文案函数（`riskLabel` / `riskClass`）两页都要用，
一并放进同目录的小工具文件或 composable 导出。

### 4. 帮助浮层换成 kit 件

两页里的 `<button class="user-rule-help">` + 手搓 Teleport 浮层，全部换成
`<SettingHelp :title="…">…</SettingHelp>`。删掉 `HelpTip` 类型、`openHelpTip`、
`helpTipPos`、`placeHelpTip`、`togglePolicyTip`、`toggleUserRuleTip`、`toggleCmdColTip`、
`closePolicyTip`、`onPolicyTipKeydown`、对应 onMounted/onUnmounted 监听，以及
`.help-tip*` 相关样式。

`policyTipExamples` / `helpTipTitle` / `helpTipBody` 这三个按 `openHelpTip.kind` 分派
文案的 computed 也一并删除——内容直接写进各自 `SettingHelp` 的 slot。

### 5. i18n

zh-CN / en-US 同步：

- 新增 `settings.groups.security`：安全 / Security
- 新增 `settings.tabs.commandRules`：命令规则 / Command Rules
- 新增 `settings.tabs.riskPolicy`：风险策略 / Risk Policy
- 删除 `settings.tabs.securityPermissions`
- 删除 `settings.security.subTabs`（builtin / policy 两条）

`settings.security.builtinRules` / `userCommandRules` / `riskPolicy` / `presets` 四个
命名空间保持不动，两页分别取用。

### 6. SPEC

`src/components/Settings/SPEC.md` 补一条：一页只装一件事。两块内容如果各自都够一整页
（各有各的长列表、各有各的保存动作），那是两页，该在侧栏各占一条，不是拿标签条挤进
一页。标签条留给「同一批东西换个看法」。

## 已决

**A. 离开页面时的未保存提示：在侧栏切换处加统一守卫。**

现状 `switchSubTab` 在有未保存策略改动时会拦一道（`riskPolicy.unsavedLeave`），
但侧栏切换（`SettingsModal.vue:586` 是裸的 `activeTab = tab.id`）从来没有守卫——
今天改完策略点侧栏「数据」，改动无声就丢了，被保护的反而是最不可能的那条出口。

做法：`SettingsModal` 提供一个「当前页有未保存改动」的登记点，页面通过
`provide`/`inject` 拿到一个注册函数，在自己有脏改动时登记；侧栏点击改为先问守卫。
风险策略页登记自己的 `policyUnsaved`。文案复用 `riskPolicy.unsavedLeave`。

这样拆完不但没丢保护，还把今天就存在的漏洞补上了，且以后任何页面都能用同一个口子。

**B. `SettingsTabs` 暂时空置，不删。** 技能（我的技能 / 技能市场）、记忆（记忆 /
知识库）、浏览器助手（Chrome / Firefox）三页都有页内标签条、各画各的，是这个基础件
明确的下家。按「先只拆安全页」的决定，这次不动它们，基础件先空着，留待以后一次性
收编三页。

## 任务拆解

- [x] T1 抽 `useRiskPolicy` + 风险等级文案工具，原组件改为调用它，行为不变（验收：面板照常，策略能存能重置）
- [x] T2 两半的帮助浮层换成 `SettingHelp`，删手搓浮层（验收：每个问号点开内容与原来一致，滚动/Esc/点外面都能关）
- [x] T3 拆成 `CommandRulesSettings.vue` + `RiskPolicySettings.vue`，暂仍挂在原 tab 下用标签条切（验收：两页内容与拆前逐块对齐）
- [x] T4 侧栏改造 + i18n + 去掉标签条（验收：侧栏出现「安全」组两条，切换正常，中英文都对）
- [x] T5 `SettingsModal` 加统一的未保存守卫，风险策略页登记（验收：有未保存改动时点侧栏任意一条都会问；没改动时不问）
- [x] T6 SPEC 补「一页只装一件事」；plan 标完成
