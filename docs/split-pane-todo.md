# 分屏功能待完成事项

## ✅ 已完成

1. **核心架构**
   - 数据结构增强（SplitPane 接口）
   - 分屏核心逻辑（splitTerminal 函数）
   - 窗格管理功能（closePane、setActivePaneInTab、updatePaneSize）
   - AI 多屏感知（getAgentContext 函数）
   - screenServices 映射机制（按 ptyId 存储）

2. **UI 组件**
   - SplitPaneView.vue 递归布局组件
   - TerminalTabView.vue 支持分屏渲染
   - 分割线拖拽基础框架

3. **文档**
   - 架构设计文档（docs/split-pane-architecture.md）

## ⏳ 待完成（增强功能）

### 1. Agent 工具集成

#### 1.1 分屏管理工具
在 `electron/services/agent/tools/terminal.ts` 中添加：

```typescript
// 创建分屏
export async function splitTerminal(
  ptyId: string,
  args: { direction: 'horizontal' | 'vertical' },
  executor: ToolExecutorConfig
): Promise<ToolResult>

// 关闭窗格
export async function closePane(
  ptyId: string,
  args: { paneId: string },
  executor: ToolExecutorConfig
): Promise<ToolResult>

// 切换焦点窗格
export async function focusPane(
  ptyId: string,
  args: { paneId: string },
  executor: ToolExecutorConfig
): Promise<ToolResult>

// 在指定窗格执行命令
export async function executeInPane(
  ptyId: string,
  args: { paneId: string; command: string },
  executor: ToolExecutorConfig
): Promise<ToolResult>
```

#### 1.2 连接管理工具
在 `electron/services/agent/tools/terminal.ts` 中添加：

```typescript
// 创建 SSH 连接
export async function connectSsh(
  ptyId: string,
  args: {
    host: string;
    username: string;
    createPane?: boolean;
    direction?: 'horizontal' | 'vertical';
  },
  executor: ToolExecutorConfig
): Promise<ToolResult>

// 创建本地终端
export async function connectLocal(
  ptyId: string,
  args: {
    shell?: string;
    createPane?: boolean;
    direction?: 'horizontal' | 'vertical';
  },
  executor: ToolExecutorConfig
): Promise<ToolResult>

// 关闭连接
export async function disconnectTerminal(
  ptyId: string,
  args: { paneId: string },
  executor: ToolExecutorConfig
): Promise<ToolResult>
```

### 2. Agent System Prompt 增强

在 `electron/services/agent/prompt-builder.ts` 中修改 `buildSystemPrompt` 函数：

```typescript
// 检测是否有分屏布局
if (context.mode === 'split') {
  prompt += `\n\n你现在可以看到 ${context.panes.length} 个分屏终端：\n`
  context.panes.forEach(pane => {
    prompt += `- ${pane.label}窗格（${pane.paneId}）：${pane.isActive ? '激活' : '未激活'}\n`
  })
  
  prompt += `\n你可以使用以下工具管理分屏：
- split_terminal: 创建新分屏
- close_pane: 关闭窗格
- focus_pane: 切换焦点
- execute_in_pane: 在指定窗格执行命令\n`
}
```

### 3. 工具定义

在 `electron/services/agent/tools.ts` 中添加工具定义：

```typescript
export const SPLIT_PANE_TOOLS: ToolDefinition[] = [
  {
    name: 'split_terminal',
    description: '创建终端分屏',
    input_schema: {
      type: 'object',
      properties: {
        direction: {
          type: 'string',
          enum: ['horizontal', 'vertical'],
          description: '分屏方向：horizontal（左右）或 vertical（上下）'
        }
      },
      required: ['direction']
    }
  },
  // ... 其他工具定义
]
```

### 4. UI 增强

#### 4.1 分割线拖拽完整实现
在 `SplitPaneView.vue` 中完善 `handleResize` 函数：
- 计算鼠标移动距离
- 更新相邻窗格的大小
- 调用 `terminalStore.updatePaneSize`

#### 4.2 窗格操作菜单
添加右键菜单：
- 水平分屏
- 垂直分屏
- 关闭窗格
- 最大化/还原

#### 4.3 快捷键支持
- `Ctrl+Shift+D`: 水平分屏
- `Ctrl+Shift+E`: 垂直分屏
- `Ctrl+Shift+W`: 关闭当前窗格
- `Ctrl+Shift+Arrow`: 切换焦点窗格

### 5. 测试

#### 5.1 单元测试
- splitTerminal 函数测试
- closePane 函数测试
- getAgentContext 函数测试（单终端和分屏模式）
- 状态转换测试（ptyId ↔ splitLayout）

#### 5.2 集成测试
- 创建分屏 → 关闭窗格 → 恢复单终端
- 嵌套分屏测试
- Agent 多屏感知测试

#### 5.3 E2E 测试
- 用户创建分屏
- 用户调整窗格大小
- 用户关闭窗格
- Agent 跨窗格操作

## 📝 实现优先级

### P0（核心功能）- 已完成 ✅
- 数据结构和状态管理
- 分屏核心逻辑
- UI 组件渲染
- AI 多屏感知

### P1（基础交互）
- 分割线拖拽完整实现
- 窗格操作菜单
- 快捷键支持

### P2（Agent 工具）
- 分屏管理工具
- 连接管理工具
- System Prompt 增强

### P3（高级功能）
- 窗格布局模板
- 窗格同步
- 持久化布局

## 🔗 相关文件

- 架构文档：`docs/split-pane-architecture.md`
- 核心逻辑：`src/stores/terminal.ts`
- UI 组件：`src/components/SplitPaneView.vue`
- Agent 工具：`electron/services/agent/tools/terminal.ts`
- System Prompt：`electron/services/agent/prompt-builder.ts`
