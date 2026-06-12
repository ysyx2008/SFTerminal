/**
 * 浏览器技能工具定义
 */

import type { ToolDefinition } from '../../tools'

export const browserTools: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'browser_launch',
      description: `启动浏览器，建立会话。

**默认策略**：若 SailFish 浏览器助手已连接（Chrome/Edge/Firefox 扩展在线），**自动 attach** 到用户当前浏览器，复用登录态与标签页，无需传参。
仅当需要独立窗口、无头模式、**截图（browser_screenshot）** 或 profile 时才用 launch 模式。

**双浏览器**：Chromium（Chrome/Edge）与 Firefox 可同时连接。仅连一个时 \`browser\` 可省略（auto）；两个都连时必须指定 \`browser: "firefox"\` 或 \`"chromium"\`（用户说火狐/Firefox → firefox，Chrome/谷歌 → chromium）。切换浏览器：\`browser_close\` 后重新 \`browser_launch\` 并指定 \`browser\`。

**两种模式**：
- **attach（优先）**：浏览器助手已连接时自动启用；也可显式 \`{ "attach": true }\` 或 \`{ "mode": "attach" }\`
- **launch（Playwright 独立窗口）**：\`{ "mode": "launch" }\` 或 \`{ "attach": false }\`；需要 headless / profile / **截图** 时自动或显式使用

**attach 能力边界（Chrome / Edge / Firefox 一致）**：
- **不支持** \`browser_screenshot\`；需截图请 \`browser_launch { "mode": "launch" }\`，或用 \`browser_snapshot\` / \`browser_get_content\`
- \`browser_wait\` **仅支持 delay**；不支持 selector 等待（需等元素请轮询 snapshot 或改用 launch）
- \`browser_evaluate\` 仅 **safe-eval 白名单子集**（扩展 CSP 禁止 eval/Function，三浏览器相同）：
  - ✅ \`document\` / \`location\` / \`window\` 属性链（如 \`document.title\`、\`document.body.scrollHeight\`、\`document.cookie\`、\`location.href\`、\`window.localStorage.length\`）
  - ✅ \`document.querySelectorAll('…').length\`
  - ✅ \`document.querySelector('…')\` 及 \`.textContent\` / \`.innerText\` / \`.innerHTML\` / \`.value\`
  - ❌ \`querySelector\` 结果取 \`.href\` 等其它属性、返回 NodeList、方法调用（\`JSON.stringify\`、\`localStorage.getItem\`）、\`navigator\`、运算/函数式
  - 复杂 JS 请 \`browser_launch { "mode": "launch" }\`
- goto / snapshot / click / type / scroll / list_tabs / switch_tab 三浏览器无差异

**注意**：
- 每个终端最多一个浏览器会话
- launch 模式 5 分钟无操作自动关闭；attach 模式 browser_close 仅断开连接
- attach 需安装浏览器助手：Chrome/Edge 扩展页；Firefox \`about:debugging\` 临时加载或签名 XPI。改扩展后需重载并刷新目标页

**登录状态（launch 模式）**：
- profile 参数可恢复持久化登录；attach 模式直接复用用户浏览器登录态`,
      parameters: {
        type: 'object',
        properties: {
          attach: {
            type: 'boolean',
            description: 'true 时 attach 到用户当前浏览器'
          },
          mode: {
            type: 'string',
            enum: ['attach', 'launch'],
            description: 'attach 或 launch（默认 launch）'
          },
          url: {
            type: 'string',
            description: '启动后立即访问的 URL（可选）'
          },
          headless: {
            type: 'boolean',
            description: '是否无头模式（默认 false，显示窗口）'
          },
          profile: {
            type: 'string',
            description: '登录配置名称。首次使用会创建新配置，关闭时自动保存登录状态；再次使用会恢复登录状态'
          },
          browser: {
            type: 'string',
            enum: ['auto', 'firefox', 'chromium', 'chrome', 'edge'],
            description: 'attach 时选择浏览器：auto（默认，仅一个连接时自动）、firefox、chromium（含 chrome/edge）'
          }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_snapshot',
      description: `获取页面的无障碍树快照。这是与页面交互前的**推荐第一步**。

**核心优势**：
- 返回页面所有元素的结构化无障碍树
- 每个可交互元素带有 ref 编号（如 @e1, @e2）
- **必填项标注 [必填]**，提交前请先填完所有 [必填] 字段
- 无障碍名称缺失的输入框会补充 **[label=字段名]**，据此区分不同输入框
- 后续操作可直接使用 ref，无需猜测 CSS 选择器
- 比获取 HTML 内容**节省约 90% token**

**attach 模式**：这是 attach 下了解页面的主要方式（**不能**用 browser_screenshot 截图，见 browser_launch 说明）

**推荐工作流**：
1. 首次可用 browser_snapshot 获取页面结构和 ref（或直接 browser_goto / browser_click，其返回会自带快照）
2. 使用 ref 执行操作：browser_click { selector: "@e2" }
3. browser_click、browser_goto、browser_switch_tab 执行后会自动附带当前页面快照，通常无需再单独调用本工具；仅在需要不同参数（如 compact、selector）或仅想刷新快照时再调用

**模式**：
- 默认：完整无障碍树
- interactive: true：只显示可交互元素（按钮、链接、输入框等）- 最省 token
- compact: true：移除无内容的结构元素`,
      parameters: {
        type: 'object',
        properties: {
          interactive: {
            type: 'boolean',
            description: '只返回可交互元素（默认 false）。推荐在首次了解页面时使用 true'
          },
          compact: {
            type: 'boolean',
            description: '移除空结构元素，精简输出（默认 false）'
          },
          max_depth: {
            type: 'number',
            description: '最大树深度（可选，限制层级）'
          },
          selector: {
            type: 'string',
            description: '只获取指定元素范围内的快照（CSS 选择器，可选）'
          }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_goto',
      description: `导航到指定网址。成功后会自动附带当前页面快照，无需再单独调用 browser_snapshot。

**等待策略**：
- load：等待页面完全加载（默认）
- domcontentloaded：DOM 加载完成即可
- networkidle：网络空闲时`,
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: '目标 URL'
          },
          wait_until: {
            type: 'string',
            enum: ['load', 'domcontentloaded', 'networkidle'],
            description: '等待策略（默认 load）'
          }
        },
        required: ['url']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_screenshot',
      description: `对当前页面截图并保存。

**⚠️ 仅 launch（Playwright 独立窗口）模式可用**；attach（吸附用户浏览器）模式**不支持**本工具。
若当前为 attach 会话且用户要截图：先 \`browser_close\`，再 \`browser_launch { "mode": "launch" }\` 后调用本工具；或改用 \`browser_snapshot\` / \`browser_get_content\`。

**💡 提示**：多数场景 browser_snapshot 比截图更高效。截图适用于 launch 模式下需要视觉确认的场景。

**模式**：
- 默认：截取可视区域
- full_page: true：截取整个页面（包括滚动区域）
- selector：只截取指定元素（支持 @ref）`,
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: '保存路径（可选，默认保存到临时目录）'
          },
          full_page: {
            type: 'boolean',
            description: '是否截取整页（默认 false）'
          },
          selector: {
            type: 'string',
            description: '只截取指定元素的 CSS 选择器（可选）'
          }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_get_content',
      description: `获取页面内容。

**格式**：
- text：纯文本（默认，适合阅读）
- html：HTML 源码
- markdown：转换为 Markdown

**限制**：默认最多返回 10000 字符`,
      parameters: {
        type: 'object',
        properties: {
          format: {
            type: 'string',
            enum: ['text', 'html', 'markdown'],
            description: '输出格式（默认 text）'
          },
          selector: {
            type: 'string',
            description: '只获取指定元素的内容（CSS 选择器）'
          },
          max_length: {
            type: 'number',
            description: '最大字符数（默认 10000）'
          }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_click',
      description: `点击页面元素。成功后会自动附带当前页面快照，可直接基于返回内容继续操作，无需再调用 browser_snapshot。

**选择器支持（推荐使用 ref）**：
- **ref 引用（推荐）**：\`@e1\`, \`@e2\` - 使用快照返回的 ref 编号，最准确
- CSS 选择器：\`#id\`, \`.class\`, \`button\`
- 文本选择器：\`text=登录\`, \`text=提交\`
- 角色选择器：\`role=button[name="确定"]\`

**注意**：会自动等待元素可点击`,
      parameters: {
        type: 'object',
        properties: {
          selector: {
            type: 'string',
            description: '元素选择器（CSS、文本或角色）'
          },
          wait_for_navigation: {
            type: 'boolean',
            description: '是否等待页面跳转（默认 false）'
          }
        },
        required: ['selector']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_type',
      description: `在输入框中输入文本。

**选择器支持（推荐使用 ref）**：
- **ref 引用（推荐）**：\`@e3\` - 使用 browser_snapshot 返回的 ref 编号
- CSS 选择器：\`input[name="username"]\`
- 文本选择器：\`text=用户名\`（会找到相关的输入框）
- 占位符：\`placeholder=请输入用户名\`

**注意**：默认会先清空输入框`,
      parameters: {
        type: 'object',
        properties: {
          selector: {
            type: 'string',
            description: '输入框选择器'
          },
          text: {
            type: 'string',
            description: '要输入的文本'
          },
          clear_first: {
            type: 'boolean',
            description: '是否先清空（默认 true）'
          },
          press_enter: {
            type: 'boolean',
            description: '输入后是否按回车（默认 false）'
          }
        },
        required: ['selector', 'text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_scroll',
      description: `滚动页面。

**方向**：
- down：向下滚动（默认）
- up：向上滚动
- top：滚动到顶部
- bottom：滚动到底部`,
      parameters: {
        type: 'object',
        properties: {
          direction: {
            type: 'string',
            enum: ['up', 'down', 'top', 'bottom'],
            description: '滚动方向（默认 down）'
          },
          distance: {
            type: 'number',
            description: '滚动距离（像素，默认 500）'
          }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_wait',
      description: `等待元素出现或指定时间。

**attach 模式**：**仅支持 delay**（毫秒），不支持 selector 等待。需等元素出现请轮询 \`browser_snapshot\` 或 \`browser_launch { "mode": "launch" }\`。

**launch 模式**：
- 等待元素：指定 selector
- 等待时间：指定 delay（毫秒）`,
      parameters: {
        type: 'object',
        properties: {
          selector: {
            type: 'string',
            description: '等待此元素出现'
          },
          timeout: {
            type: 'number',
            description: '超时时间（毫秒，默认 30000）'
          },
          delay: {
            type: 'number',
            description: '直接等待指定毫秒数'
          }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_evaluate',
      description: `在页面中执行 JavaScript 代码。

**attach 模式（Chrome / Edge / Firefox 相同）**：扩展 CSP 禁止 eval/Function，经 content script safe-eval 静态求值，仅支持：
- ✅ \`document\` / \`location\` / \`window\` 属性链（\`document.title\`、\`document.body.scrollHeight\`、\`document.cookie\`、\`location.href\`、\`window.scrollY\`、\`window.localStorage.length\` 等）
- ✅ \`document.querySelectorAll('…').length\`
- ✅ \`document.querySelector('…')\` 及 \`.textContent\` / \`.innerText\` / \`.innerHTML\` / \`.value\`
- ❌ \`querySelector('…').href\` 等链式取属性、返回集合对象、方法调用、\`navigator\`、运算/函数式（如 \`JSON.stringify\`、\`Array.from\`）
复杂 JS 请 \`browser_launch { "mode": "launch" }\`。

**launch 模式**：完整 JavaScript 执行（Playwright 页面上下文）。

**返回值**：脚本返回值 JSON 序列化后返回`,
      parameters: {
        type: 'object',
        properties: {
          script: {
            type: 'string',
            description: '要执行的 JavaScript 代码'
          }
        },
        required: ['script']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_list_tabs',
      description: `列出所有打开的标签页。

**返回**：每个标签页的索引、URL、标题，以及哪个是当前活动标签页`,
      parameters: {
        type: 'object',
        properties: {},
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_switch_tab',
      description: `切换到指定的标签页。切换成功后会自动附带当前页面快照，无需再单独调用 browser_snapshot。

**使用场景**：当点击链接打开了新标签页后，可以用此工具切换回原标签页，或在多个标签页之间切换`,
      parameters: {
        type: 'object',
        properties: {
          index: {
            type: 'number',
            description: '标签页索引（从 0 开始，使用 browser_list_tabs 查看）'
          }
        },
        required: ['index']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_save_login',
      description: `手动确认保存当前浏览器的登录状态。

**注意**：使用持久化 profile 后，登录状态会在关闭浏览器时**自动保存**，通常无需手动调用此工具。

**使用场景**：如果想在浏览器关闭前确认状态已保存，可以调用此工具。`,
      parameters: {
        type: 'object',
        properties: {
          profile: {
            type: 'string',
            description: '配置名称（如 "taobao"、"github" 等）'
          }
        },
        required: ['profile']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_list_profiles',
      description: `列出所有已保存的登录配置。

**返回**：配置名称列表，可用于 browser_launch 的 profile 参数`,
      parameters: {
        type: 'object',
        properties: {},
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_close',
      description: `关闭浏览器会话。

**注意**：关闭后如需再次操作网页，需要重新调用 browser_launch`,
      parameters: {
        type: 'object',
        properties: {},
        required: []
      }
    }
  }
]

