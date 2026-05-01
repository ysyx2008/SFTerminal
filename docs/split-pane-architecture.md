# 分屏功能架构设计文档

## 1. 概述

本文档描述了 SFTerminal 分屏功能的架构设计和实现细节。

### 1.1 核心目标

- 支持终端分屏（水平/垂直分割）
- AI Agent 可以同时看到和控制所有分屏
- 向后兼容单终端模式
- 保持代码结构清晰，易于维护

### 1.2 设计原则

```
✅ 一个 Tab = 一个工作空间 = 一个 Agent
✅ 分屏 = 工作空间内的视图分割
✅ Agent 可以看到和控制所有分屏
✅ 向后兼容单终端模式
```

## 2. 架构决策

### 2.1 Tab-Agent 一对多架构

我们采用 **Tab-Agent 一对多** 架构，而不是 Pane-Agent 一对一：

**理由：**
1. 符合用户心智模型：一个 Tab = 一个工作空间
2. Agent 可以跨窗格分析和操作（这是核心功能）
3. 实现成本最低，不需要重构 Agent 状态管理
4. 向后兼容单终端模式

**架构图：**
```
┌─────────────────────────────────────────┐
│           TerminalTab                   │
│                                         │
│  ┌─────────────────────────────────┐   │
│  │      Terminal Area              │   │
│  │  ┌──────────┬──────────┐        │   │
│  │  │Terminal1 │Terminal2 │        │   │
│  │  │(ptyId-1) │(ptyId-2) │        │   │
│  │  └──────────┴──────────┘        │   │
│  │  (由 splitLayout 管理)           │   │
│  └─────────────────────────────────┘   │
│                                         │
│  ┌─────────────────────────────────┐   │
│  │         AiPanel                 │   │
│  │  Agent 看到所有分屏              │   │
│  │  可以跨窗格操作                  │   │
│  └─────────────────────────────────┘   │
└─────────────────────────────────────────┘
```

## 3. 数据结构设计

### 3.1 TerminalTab 接口

```typescript
interface TerminalTab {
  id: string
  title: string
  type: TerminalType
  
  // 单终端模式（向后兼容）
  ptyId?: string
  
  // 分屏模式
  splitLayout?: SplitPane
  
  // Agent 状态（始终绑定到 Tab）
  aiMessages?: AiMessage[]
  agentState?: AgentState
  
  // 其他属性...
}
```

**互斥规则：**
- 单终端模式：`ptyId` 有值，`splitLayout = null`
- 分屏模式：`ptyId = null`，`splitLayout` 有值

### 3.2 SplitPane 接口

```typescript
interface SplitPane {
  id: string
  type: 'terminal' | 'split'
  direction?: 'horizontal' | 'vertical'
  children?: SplitPane[]
  
  // 终端窗格属性（type='terminal' 时使用）
  ptyId?: string              // 终端实例 ID
  terminalType?: 'local' | 'ssh'  // 终端类型
  sshConfig?: {               // SSH 配置
    host: string
    port: number
    username: string
  }
  sshSessionId?: string       // SSH 会话 ID
  label?: string              // 窗格标签（如 "左侧"、"右上"）
  isActive?: boolean          // 是否为当前焦点窗格
  
  // 布局属性
  size?: number               // 窗格大小（百分比，0-100）
}
```

**设计要点：**
- 递归结构，支持嵌套分屏
- 每个终端窗格有独立的 `ptyId`
- 每个窗格可以是本地终端或 SSH 连接
- 支持窗格标签和激活状态

## 4. 状态管理

### 4.1 状态转换流程

```
创建 Tab
  ↓
ptyId 有值，splitLayout = null
  ↓
第一次分屏（splitTerminal）
  ↓
ptyId = null，splitLayout 有值
  ↓
关闭到只剩一个窗格（closePane）
  ↓
ptyId 有值，splitLayout = null
```

### 4.2 核心函数

#### splitTerminal()

**功能：** 创建分屏，将当前终端分割为两个窗格

**关键逻辑：**
```typescript
async function splitTerminal(direction: 'horizontal' | 'vertical'): Promise<string | null> {
  const currentTab = activeTab.value
  
  if (!currentTab.splitLayout) {
    // 第一次分屏：创建初始布局
    const newPtyId = await createNewTerminalInstance(currentTab)
    
    currentTab.splitLayout = {
      type: 'split',
      direction,
      children: [
        { type: 'terminal', ptyId: currentTab.ptyId, ... },  // 原终端
        { type: 'terminal', ptyId: newPtyId, ... }           // 新终端
      ]
    }
    
    // 重要：清空 tab.ptyId，进入分屏模式
    currentTab.ptyId = undefined
  } else {
    // 已有分屏：在激活窗格上继续分割
    // ...
  }
}
```

#### closePane()

**功能：** 关闭分屏窗格

**关键逻辑：**
```typescript
async function closePane(tabId: string, paneId: string): Promise<void> {
  const tab = tabs.value.find(t => t.id === tabId)
  const allPanes = getAllTerminalPanes(tab.splitLayout)
  
  if (allPanes.length <= 2) {
    // 只剩两个窗格，关闭一个后恢复到单终端模式
    const remainingPane = allPanes.find(p => p.id !== paneId)
    
    // 重要：恢复 tab.ptyId，退出分屏模式
    tab.ptyId = remainingPane.ptyId
    tab.splitLayout = null
  } else {
    // 多个窗格，移除指定窗格
    removePaneFromLayout(tab.splitLayout, paneId)
  }
}
```

## 5. AI 多屏感知

### 5.1 getAgentContext()

**功能：** 获取 Agent 上下文，支持多屏感知

**返回结构：**

**单终端模式：**
```typescript
{
  mode: 'single',
  ptyId: 'pty-1',
  terminalOutput: [...],
  systemInfo: { os: 'macos', shell: 'zsh' },
  terminalType: 'local'
}
```

**分屏模式：**
```typescript
{
  mode: 'split',
  activePaneId: 'pane-2',
  panes: [
    {
      paneId: 'pane-1',
      ptyId: 'pty-1',
      label: '左侧',
      isActive: false,
      terminalOutput: [...],
      terminalType: 'local'
    },
    {
      paneId: 'pane-2',
      ptyId: 'pty-2',
      label: '右侧',
      isActive: true,
      terminalOutput: [...],
      terminalType: 'ssh'
    }
  ],
  systemInfo: { os: 'macos', shell: 'zsh' }
}
```

### 5.2 screenServices 映射机制

**关键设计决策：** 改为按 `ptyId` 存储，而不是 `tabId`

**理由：**
- 分屏后，每个窗格有独立的 `ptyId`
- `ptyId` 是终端实例的唯一标识
- 支持在 `getAgentContext` 中通过 `ptyId` 获取每个窗格的输出

**实现：**
```typescript
// 存储结构
const screenServices = new Map<string, TerminalScreenService>()

// Terminal.vue 注册时使用 ptyId
terminalStore.registerScreenService(props.ptyId, screenService)

// getAgentContext 获取时使用 ptyId
const screenService = screenServices.get(pane.ptyId)
```

## 6. UI 组件设计

### 6.1 组件层次结构

```
TerminalTabView.vue
  ├─ AiPanel.vue (绑定到 Tab)
  └─ 终端区域
      ├─ Terminal.vue (单终端模式)
      └─ SplitPaneView.vue (分屏模式)
          ├─ Terminal.vue (窗格 1)
          ├─ ResizeHandle.vue (分割线)
          └─ SplitPaneView.vue (递归，嵌套分屏)
              ├─ Terminal.vue (窗格 2)
              └─ Terminal.vue (窗格 3)
```

### 6.2 TerminalTabView 渲染逻辑

```vue
<template>
  <div class="terminal-tab">
    <!-- AI 面板（始终绑定到 Tab）-->
    <AiPanel :tab-id="tab.id" />
    
    <!-- 终端区域 -->
    <div class="terminal-main">
      <!-- 分屏模式 -->
      <SplitPaneView v-if="tab.splitLayout" :layout="tab.splitLayout" />
      
      <!-- 单终端模式（向后兼容）-->
      <Terminal v-else-if="tab.ptyId" :pty-id="tab.ptyId" />
    </div>
  </div>
</template>
```

### 6.3 SplitPaneView 组件（递归）

```vue
<template>
  <div class="split-pane" :class="layout.direction">
    <template v-if="layout.type === 'split'">
      <!-- 递归渲染子窗格 -->
      <SplitPaneView 
        v-for="(child, index) in layout.children"
        :key="child.id"
        :layout="child"
        :style="{ flex: child.size }"
      />
      
      <!-- 分割线（可拖拽调整大小）-->
      <ResizeHandle 
        v-if="index < layout.children.length - 1"
        :direction="layout.direction"
        @resize="handleResize"
      />
    </template>
    
    <template v-else-if="layout.type === 'terminal'">
      <!-- 终端实例 -->
      <Terminal 
        :pty-id="layout.ptyId"
        :is-active="layout.isActive"
      />
    </template>
  </div>
</template>
```

## 7. Agent 工具设计

### 7.1 分屏管理工具

```typescript
// 创建分屏
{
  "tool": "split_terminal",
  "args": {
    "direction": "horizontal" | "vertical",
    "paneId": "target-pane-id"  // 可选，默认当前激活窗格
  }
}

// 关闭窗格
{
  "tool": "close_pane",
  "args": {
    "paneId": "pane-to-close"
  }
}

// 切换焦点窗格
{
  "tool": "focus_pane",
  "args": {
    "paneId": "target-pane-id"
  }
}

// 在指定窗格执行命令
{
  "tool": "execute_in_pane",
  "args": {
    "paneId": "target-pane-id",
    "command": "npm run dev"
  }
}
```

### 7.2 连接管理工具

```typescript
// 创建新的 SSH 连接（在新窗格中）
{
  "tool": "connect_ssh",
  "args": {
    "host": "server.example.com",
    "username": "user",
    "createPane": true,  // 是否在新窗格中打开
    "direction": "horizontal"  // 如果创建新窗格，分屏方向
  }
}

// 创建新的本地终端
{
  "tool": "connect_local",
  "args": {
    "shell": "/bin/zsh",
    "createPane": true,
    "direction": "vertical"
  }
}

// 关闭连接
{
  "tool": "disconnect_terminal",
  "args": {
    "paneId": "pane-id"
  }
}
```

### 7.3 Agent System Prompt 增强

```
你现在可以看到 3 个分屏终端：
- 左侧窗格（pane-1）：正在运行 npm run dev
- 右上窗格（pane-2）：显示 git log
- 右下窗格（pane-3）：空闲状态

你可以使用以下工具管理分屏：
- split_terminal: 创建新分屏
- close_pane: 关闭窗格
- focus_pane: 切换焦点
- execute_in_pane: 在指定窗格执行命令

你可以使用以下工具管理连接：
- connect_ssh: 创建 SSH 连接
- connect_local: 创建本地终端
- disconnect_terminal: 关闭连接
```

## 8. OOP 设计原则

### 8.1 单一职责原则（SRP）

- `TerminalTab`: 管理单个工作空间（Tab）的状态
- `SplitPane`: 表示分屏布局的节点（终端或分割容器）
- `Terminal.vue`: 渲染单个终端实例
- `SplitPaneView.vue`: 渲染分屏布局（递归）
- `AiPanel.vue`: 管理 AI 对话和 Agent 状态

### 8.2 开闭原则（OCP）

- 通过 `SplitPane` 的递归结构，支持任意层级的嵌套分屏
- 通过 `type` 字段区分终端窗格和分割容器，易于扩展新类型

### 8.3 里氏替换原则（LSP）

- `SplitPane` 可以是终端窗格或分割容器，两者可以互相替换
- `Terminal.vue` 不关心是否在分屏中，只关心 `ptyId`

### 8.4 接口隔离原则（ISP）

- `TerminalScreenService`: 专注于屏幕内容读取
- `TerminalSnapshotManager`: 专注于快照管理
- `TerminalTab`: 只暴露必要的状态和方法

### 8.5 依赖倒置原则（DIP）

- `Terminal.vue` 依赖 `TerminalScreenService` 接口，而不是具体实现
- `getAgentContext` 依赖 `screenServices` Map，而不是直接访问 Terminal 组件

## 9. 实现清单

### 9.1 已完成

- [x] 数据结构增强（`SplitPane` 接口）
- [x] 分屏核心逻辑（`splitTerminal` 函数）
- [x] 窗格管理功能（`closePane`、`setActivePaneInTab`、`updatePaneSize`）
- [x] AI 多屏感知（`getAgentContext` 函数）
- [x] screenServices 映射机制（改为按 `ptyId` 存储）

### 9.2 待实现

- [ ] UI 组件
  - [ ] 修改 `TerminalTabView.vue` 支持分屏渲染
  - [ ] 实现 `SplitPaneView.vue` 递归布局组件
  - [ ] 实现分割线拖拽调整大小
- [ ] Agent 后端集成
  - [ ] 修改 Agent 后端支持多屏上下文
  - [ ] 增强 Agent System Prompt 支持多屏
- [ ] Agent 工具
  - [ ] 为 Agent 添加分屏管理工具
  - [ ] 为 Agent 添加连接管理工具

## 10. 测试计划

### 10.1 单元测试

- [ ] `splitTerminal` 函数测试
- [ ] `closePane` 函数测试
- [ ] `getAgentContext` 函数测试（单终端和分屏模式）
- [ ] 状态转换测试（ptyId ↔ splitLayout）

### 10.2 集成测试

- [ ] 创建分屏 → 关闭窗格 → 恢复单终端
- [ ] 嵌套分屏测试
- [ ] Agent 多屏感知测试
- [ ] screenServices 映射测试

### 10.3 E2E 测试

- [ ] 用户创建分屏
- [ ] 用户调整窗格大小
- [ ] 用户关闭窗格
- [ ] Agent 跨窗格操作

## 11. 性能考虑

### 11.1 内存管理

- 每个窗格有独立的 `TerminalScreenService` 实例
- 关闭窗格时正确清理资源（dispose ptyId、unregister screenService）

### 11.2 渲染优化

- 使用 `v-if` 而不是 `v-show`，避免渲染不可见的终端
- 只有激活的窗格才获得焦点
- 使用虚拟滚动优化大量输出

### 11.3 状态更新

- 使用 Vue 3 的响应式系统
- 避免不必要的深拷贝
- 使用 `computed` 缓存计算结果

## 12. 安全考虑

### 12.1 SSH 连接

- 密码和私钥不存储在 `SplitPane` 中
- 通过 `sshSessionId` 从 `configStore` 获取完整配置

### 12.2 命令执行

- Agent 执行命令前需要用户确认（高风险操作）
- 记录所有 Agent 执行的命令

## 13. 未来扩展

### 13.1 窗格布局模板

- 预定义常用布局（如 2x2 网格、三栏布局）
- 保存和恢复自定义布局

### 13.2 窗格同步

- 同步输入到多个窗格
- 同步滚动

### 13.3 窗格标签页

- 每个窗格可以有多个标签页
- 类似 tmux 的窗口和窗格概念

## 14. 参考资料

- [iTerm2 分屏文档](https://iterm2.com/documentation-splits.html)
- [tmux 分屏文档](https://github.com/tmux/tmux/wiki)
- [Windows Terminal 分屏文档](https://docs.microsoft.com/en-us/windows/terminal/panes)
- [Vue 3 递归组件](https://vuejs.org/guide/essentials/component-basics.html#recursive-components)

---

**文档版本：** 1.0  
**创建日期：** 2026-05-01  
**最后更新：** 2026-05-01  
**作者：** Claude Opus 4.7 & User
