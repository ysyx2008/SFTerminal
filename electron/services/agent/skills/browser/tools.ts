/**
 * 浏览器技能工具定义
 */

import type { ToolDefinition } from '../../tools'

export const browserTools: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'browser_launch',
      description: `启动浏览器，建立会话。两档能力如下。

**① 吸附 attach**：连用户正在用的 Chrome/Edge/Firefox，复用登录态和已开标签。
- 助手已在线且未指定 mode 时走这一档（也可 \`{ "mode": "attach" }\`）
- 能：打开网页、点选填表、读文章/整页、复用已登录站点
- 不能：任意 JS、截图、按元素等待、Network/开发者工具。evaluate 仅白名单属性（见 browser_evaluate）

**② 独立窗口 launch**：\`{ "mode": "launch" }\` 或 \`{ "attach": false }\`。
- 能：完整页面 JS（含 \`localStorage.getItem\`、\`fetch\`、函数）、截图、按元素等待
- 打开后后续 browser_* 保持独立窗口，直到 browser_close 或再次显式 attach
- 登录态靠 \`profile\`，不等于用户日常浏览器；无助手或 headless 时也会走这一档

没有把用户浏览器开发者工具（Network/Console/任意调试）挂给 Agent 的档。

**双浏览器**：仅连一个时 \`browser\` 可省略；两个都连时必须指定 \`"firefox"\` 或 \`"chromium"\`。切换：\`browser_close\` 后重新 launch 并指定 \`browser\`。

**阅读 vs 交互**：
- 读文章/新闻 → \`browser_read_article\`
- 读整页/区域（HTML 源码用 \`format: html\`）→ \`browser_read_page\`
- 点按钮/填表 → \`browser_snapshot\`
- 公开 URL 且无需登录 → \`web_fetch\`

**其它**：每终端一个会话；launch 5 分钟无操作自动关；attach 的 close 只断开连接、不关用户窗口。attach 下 \`browser_goto\` 默认新开标签，不覆盖当前页。`,
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
            description: 'attach 或 launch。未指定时：浏览器助手已连接则自动 attach，否则 launch'
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
      description: `获取页面的无障碍树快照。**用于交互操作**（点击、填表），不是阅读正文的首选。

**何时用 snapshot**：
- 需要点击按钮、链接、输入框
- 需要 ref（@e1）做 browser_click / browser_type

**何时不要用 snapshot**：
- 用户要「读这篇文章 / 总结新闻」→ 用 \`browser_read_article\`
- 用户要「看这页显示了什么 / 读某块区域」→ 用 \`browser_read_page\`
- snapshot 会截断文本、偏向可交互元素，长正文会丢失

**核心能力**：
- 返回页面所有元素的结构化无障碍树
- 每个可交互元素带有 ref 编号（如 @e1, @e2）
- **必填项标注 [必填]**，提交前请先填完所有 [必填] 字段
- 无障碍名称缺失的输入框会补充 **[label=字段名]**，据此区分不同输入框
- 后续操作可直接使用 ref，无需猜测 CSS 选择器
- 比获取 HTML 内容**节省约 90% token**

**attach 模式**：这是 attach 下了解页面的主要方式（**不能**用 browser_screenshot 截图，见 browser_launch 说明）

**推荐工作流（交互）**：
1. browser_snapshot 获取 ref（interactive: true 更省 token）
2. browser_click / browser_type 使用 @eN
3. 操作后返回会自动附带快照；读内容请用 browser_read_article / browser_read_page

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

**attach 模式（用户浏览器）**：
- **默认在新标签页打开**（\`new_tab\` 默认为 true），**不要覆盖**用户当前正在看的标签
- 仅当用户明确要在当前页继续、或你要在当前页刷新/跳转时，才传 \`new_tab: false\`
- 用户已打开目标站时，优先 \`browser_list_tabs\` + \`browser_switch_tab\`，不要重复开 tab

**launch 模式（Playwright 独立窗口）**：在当前会话标签页导航（无 new_tab 参数）。

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
          new_tab: {
            type: 'boolean',
            description: 'attach 模式：true=新开标签页（默认）；false=在当前标签页导航。launch 模式忽略。'
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

**仅 launch（独立窗口）可用**；吸附 attach **不支持**截图。

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
      name: 'browser_read_article',
      description: `读取**当前标签页的文章型正文**（新闻、博客、视频简介等）。attach / launch 均可用。

**何时用**：
- 用户要「总结这篇文章 / 这条新闻讲了什么 / 提取正文」
- 需要过滤导航、侧栏、页脚噪声

**何时不要用**（请改用 \`browser_read_page\`）：
- 需要整页可见文字或页面某块区域，而非只要干净正文

**实现**：桌面端 Readability 类算法 + 启发式 fallback（Firefox 阅读模式同类思路）。

**格式**：
- text（默认）、markdown、html（提取后的正文 HTML 片段）

**其它**：可选 \`selector\` 限定区域；默认最多 16000 字符。`,
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
            description: '只提取指定 CSS 选择器区域（可选）'
          },
          max_length: {
            type: 'number',
            description: '最大字符数（默认 16000）'
          }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_read_page',
      description: `读取**页面上已显示的内容**（整页或指定区域），不做正文智能过滤。attach / launch 均可用。

**何时用**：
- 需要整页或某区域的可见文字（含导航、侧栏等，未做过滤）
- 用户问「这页上显示了什么」
- 需要渲染后的 HTML 源码（\`format: html\`，高 token，仅结构分析时用）

**何时不要用**（请改用 \`browser_read_article\`）：
- 只要干净的文章正文

**能力边界**：
- \`format: text\`（默认）：\`body.innerText\` 语义
- 懒加载内容：可先 \`scroll_steps\` 再读
- Shadow DOM / 封闭组件内的文字可能无法完整获取 → 可试 \`selector\` 限定区域；仍不够请 \`browser_launch\` 全量 JS
- **不要**用 \`format: html\` 代替读文章（噪声极大）`,
      parameters: {
        type: 'object',
        properties: {
          format: {
            type: 'string',
            enum: ['text', 'html'],
            description: 'text=可见文本（默认）；html=渲染后 HTML 源码（高 token）'
          },
          selector: {
            type: 'string',
            description: '只读取指定 CSS 选择器区域（可选）'
          },
          scroll_steps: {
            type: 'number',
            description: '读取前先向下滚动次数，触发懒加载（默认 0）'
          },
          scroll_delay_ms: {
            type: 'number',
            description: '每次滚动后等待毫秒数（默认 500）'
          },
          max_length: {
            type: 'number',
            description: '最大字符数（默认 32000）'
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
      description: `【已废弃，请用 browser_read_article】获取当前标签页正文。等价于 browser_read_article；\`extract: full\` 时转发到 browser_read_page。`,
      parameters: {
        type: 'object',
        properties: {
          format: {
            type: 'string',
            enum: ['text', 'html', 'markdown'],
            description: '输出格式（默认 text）'
          },
          extract: {
            type: 'string',
            enum: ['auto', 'article', 'full'],
            description: 'full 时等价 browser_read_page，其余等价 browser_read_article'
          },
          selector: {
            type: 'string',
            description: 'CSS 选择器（可选）'
          },
          max_length: {
            type: 'number',
            description: '最大字符数（默认 16000）'
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

**① 吸附 attach**：仅白名单表达式，不是完整 JS。
- ✅ \`document\` / \`location\` / \`window\` 属性链（\`document.title\`、\`location.href\`、\`window.localStorage.length\`）
- ✅ \`document.querySelectorAll('…').length\`
- ✅ \`document.querySelector('…')\` 及 \`.textContent\` / \`.innerText\` / \`.innerHTML\` / \`.value\`
- ❌ 方法调用（\`localStorage.getItem\`、\`fetch\`、\`JSON.stringify\`）、函数/async、对 \`querySelector\` 结果再取 \`.href\` 等其它属性

**② 独立窗口 launch**：完整页面 JS。

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
      name: 'browser_close_tab',
      description: `关闭标签页。默认关闭当前活动标签；也可指定 index 关闭任意标签页。

**使用场景**：
- 点击链接打开的新标签页已读取完内容，需要关闭清理
- 用户要求关闭某个标签页
- 完成特定标签页上的操作后想关闭它

**注意**：与 \`browser_close\` 不同——后者是关闭整个浏览器会话（断开 attach 连接或关闭 launch 窗口），本工具只关闭单个标签页，浏览器会话保持。`,
      parameters: {
        type: 'object',
        properties: {
          index: {
            type: 'number',
            description: '要关闭的标签页索引（从 0 开始，使用 browser_list_tabs 查看）。省略则关闭当前活动标签'
          }
        },
        required: []
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

