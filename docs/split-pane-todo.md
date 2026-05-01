# 分屏功能进度

## ✅ 已完成（v10.36 周期）

### 数据层与状态管理
1. **数据结构**：`SplitPane` 递归树、`AgentTerminalContext` discriminated union（mode='single'|'split'）
2. **核心函数**：`splitTerminal` / `closePane` / `setActivePaneInTab` / `updatePaneSize`
3. **screenServices**：按 `ptyId` 索引（支持每个窗格独立屏幕服务）
4. **invariant 校验**：`assertTabLayoutInvariant` 防止 ptyId/splitLayout 同时有值
5. **store helpers**：`isSplitTab` / `getActivePtyId` / `getAllTabPtyIds`，外部调用方避免直接读 `tab.ptyId`
6. **纯函数抽离**：`src/stores/split-pane-tree.ts`，附 17 条 vitest 单元测试
7. **P0 bug 修复**：
   - `removePaneFromLayout` 层级提升后清掉父节点残留字段（原 Object.assign 实现脏字段问题）
   - `closePaneInternal` 单屏恢复时同步复原 `sshConfig` / `sshSessionId` / `tab.type`
   - assistant tab 入口拒绝分屏（之前会强转 local，状态机错乱）
   - 删除顶层死代码 `splitLayout = ref(null)`

### UI 交互
1. **递归渲染**：`SplitPaneView.vue` + `TerminalTabView.vue` 单/分屏自动切换
2. **拖拽调大小**：分割线 mousedown/mousemove 实时更新两侧 size，最小 10、最大 90
3. **点击激活**：点击窗格→ `setActivePaneInTab`；激活窗格 2px 边框视觉高亮
4. **关闭按钮**：hover 时右上角浮现 X 按钮
5. **右键菜单**：左右分屏 / 上下分屏 / 关闭窗格（Teleport 到 body 层）
6. **全局快捷键**：
   - macOS：`Cmd+D` 水平、`Cmd+Shift+D` 垂直、`Cmd+Shift+W` 关窗格
   - Win/Linux：`Ctrl+Shift+D` 水平、`Ctrl+Shift+E` 垂直、`Ctrl+Shift+W` 关窗格（仅分屏模式拦截）
7. **xterm 兼容**：`attachCustomKeyEventHandler` 拦截上述快捷键，避免被发到 pty
8. **i18n**：所有用户可见文本都做了中英文翻译

### Agent 多屏感知（后端）
1. **类型扩展**：`AgentContext` 添加 `mode` / `panes` / `activePaneId` 可选字段
2. **prompt 注入**：`PromptBuilder.buildSplitPanesSection` 在 Tier 2（终端级）注入"你看到 N 个窗格 + 各自 ptyId/label/激活态/最近输出"
3. **抽象层兼容**：split 模式下 IPC payload 仍带 `terminalOutput` 等单值兼容字段（取自激活窗格），`agent.ts` 不需要分支处理

### Agent 控分屏工具（反向 IPC）
1. **桥接服务**：`electron/services/split-pane-bridge.service.ts`，主进程→渲染进程通过 `webContents.send` 派发，5s 超时
2. **preload API**：`window.electronAPI.splitPane.onExec / sendResult`
3. **渲染端监听**：`src/services/split-pane-handler.ts`，App.vue 启动时初始化
4. **工具集**：`split_terminal` / `close_pane` / `focus_pane` / `list_panes`，`supportedModes: ['local', 'ssh']`，IM/Watch 远程 Agent 自动失效

### 测试
- vitest 单元测试 25 个文件、969 个用例全部通过（新增 17 个 split-pane-tree 测试）
- CLI 回归 53/53 通过（含 pty/ssh/fs/im 等覆盖）
- TypeScript 类型检查（前端）零错误
- ESLint 全文件无 lint 错误

---

## ⏳ 后续可扩展（未实现）

### 连接管理工具
原 spec 第 7.2 节提出的 `connect_ssh` / `connect_local` / `disconnect_terminal`：让 Agent 主动开新 SSH 或本地终端到分屏。
- 涉及 SSH 会话选择 UI、凭证查找
- 与现有"会话管理器 + 拖拽到分屏"交互重叠
- 建议作为独立特性立项，不混入分屏

### 布局持久化
重启后恢复分屏布局：
- pty/ssh 进程跨重启丢失，无法直接复用
- 需配合"自动重连 SSH 会话"机制
- 可暂时只持久化"上次的布局结构"，重启后让用户决定是否重连

### 高级布局
- 窗格最大化 / 还原（双击 / 快捷键）
- 布局模板（2x2 网格、三栏布局）
- 输入同步（一次输入广播到多个窗格，类似 tmux `setw synchronize-panes`）

### 多源 hostId
混合分屏（同一 tab 内 local + ssh）下 L2 知识文档 contextId 的策略：
- 当前默认取 tab 主类型对应的 hostId
- 未来可演进：按激活窗格动态切换、或多 hostId 拼接注入

---

## 🔗 相关文件

- 架构文档：`docs/split-pane-architecture.md`
- 数据/状态：`src/stores/terminal.ts`、`src/stores/split-pane-tree.ts`
- UI：`src/components/SplitPaneView.vue`、`src/components/TerminalTabView.vue`
- 反向 IPC：`electron/services/split-pane-bridge.service.ts`、`src/services/split-pane-handler.ts`
- Agent 工具：`electron/services/agent/tools/split-pane.ts`、`electron/services/agent/tools.ts`、`electron/services/agent/tools/index.ts`
- Agent 多屏感知：`electron/services/agent/prompt-builder.ts`、`electron/services/agent/types.ts`
- 单元测试：`src/stores/__tests__/split-pane-tree.test.ts`
- 全局快捷键：`src/App.vue` (handleSplitShortcut)、`src/components/Terminal.vue` (xterm 拦截)
