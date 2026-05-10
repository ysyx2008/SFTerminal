# Electron Services Index

> Last verified: 2026-05-07

SFTerminal 主进程服务层全览。每个 service 一行：职责关键词 + SPEC 路径。AI 进入项目先读此文件获取全图。

## 服务清单

| Service | 职责 | 规模 | SPEC |
|---------|------|:---:|------|
| **AiService** | AI API 传输：多模型/多端点/流式/工具调用/Think 模式 | ~2316 行 | [AISERVICE_SPEC.md](AISERVICE_SPEC.md) |
| **KnowledgeService** | 本地知识库：向量搜索/混合检索/文档管理/对话索引/主机记忆 | ~1916 行 | [knowledge/SPEC.md](knowledge/SPEC.md) |
| **GatewayService** | HTTP 网关：远程对话/SSE 流/Webhook 触发/审计日志 | ~1722 行 | [GATEWAY_SPEC.md](GATEWAY_SPEC.md) |
| **WatchService** | 自动化任务引擎：cron 触发/事件驱动/双执行模式/模板 | ~1677 行 | [watch/SPEC.md](watch/SPEC.md) |
| **IMService** | 多平台 IM 集成：钉钉/飞书/企微/微信/Slack/Telegram | ~1607 行 | [im/SPEC.md](im/SPEC.md) |
| **DocumentParserService** | 文档解析：PDF/DOCX/XLSX/CSV → Markdown + 图片渲染 | ~1305 行 | [DOCUMENT_PARSER_SPEC.md](DOCUMENT_PARSER_SPEC.md) |
| **PtyService** | 本地 PTY 终端：Shell 会话管理/I/O 流/终端状态 | ~1265 行 | [PTY_SPEC.md](PTY_SPEC.md) |
| **ConfigService** | 配置持久化：78 个类型安全的 get/set/CRUD | ~1002 行 | [CONFIG_SPEC.md](CONFIG_SPEC.md) |
| **SshService** | SSH 远程连接：跳板机/直连/终端探测/I/O | ~943 行 | [SSH_SPEC.md](SSH_SPEC.md) |
| **HistoryService** | 对话历史：消息持久化/搜索/导入导出 | ~938 行 | [HISTORY_SPEC.md](HISTORY_SPEC.md) |
| **SkillMarketService** | 技能市场：注册表/ClawHub/安装/安全扫描 | ~912 行 | [SKILL_MARKET_SPEC.md](SKILL_MARKET_SPEC.md) |
| **FileSearchService** | 文件搜索：多后端（Spotlight/Everything/locate/fd） | ~898 行 | [FILE_SEARCH_SPEC.md](FILE_SEARCH_SPEC.md) |
| **WebFetchService** | 网页抓取：Jina/Readability/fallback 三后端链 | ~763 行 | [WEB_FETCH_SPEC.md](WEB_FETCH_SPEC.md) |
| **HostProfileService** | 主机画像：系统探测/工具检测/主机上下文生成 | ~678 行 | [HOST_PROFILE_SPEC.md](HOST_PROFILE_SPEC.md) |
| **TerminalStateService** | 终端状态追踪：CWD/空闲/命令历史 | ~662 行 | [TERMINAL_STATE_SPEC.md](TERMINAL_STATE_SPEC.md) |
| **UserSkillService** | 用户技能管理：SKILL.md 扫描/解析/切换 | ~633 行 | [USER_SKILL_SPEC.md](USER_SKILL_SPEC.md) |
| **McpService** | MCP 客户端：连接管理/工具聚合/资源读取 | ~615 行 | [MCP_SPEC.md](MCP_SPEC.md) |
| **SftpService** | SFTP 文件传输：上传/下载/目录同步/进度追踪 | ~610 行 | [SFTP_SPEC.md](SFTP_SPEC.md) |

## 服务依赖关系图

```
ConfigService ────────────────────────── 被几乎所有 service 依赖（底层基础设施）
    │
    ├── AiService ──→ Agent
    │      │
    │      ├── McpService ──→ KnowledgeService (可选)
    │      └── ToolDefinition (类型引用)
    │
    ├── PtyService ──→ TerminalStateService
    │      │                  │
    │      └── SshService ────┘
    │             │
    │             └── SftpService
    │
    ├── GatewayService ──→ WebChatService (注入)
    │      ├── WatchStore (可选)
    │      └── EventBus (可选)
    │
    ├── WatchService ──→ PtyService, SshService, ConfigService, AiService,
    │      │             AgentService, SensorService (5 必需 + HistoryService 可选)
    │      ├── IMService (可选，结果推 IM)
    │      └── EventBus (可选，事件源)
    │
    ├── IMService ──→ AgentService (必需，注入)
    │      ├── HistoryService, AiService, ConfigService (可选，注入)
    │      ├── EventBus (可选)
    │      └── 6 个适配器: DingTalk/Feishu/WeCom/WeChat/Slack/Telegram
    │
    ├── KnowledgeService ──→ ConfigService, AiService (必需，构造注入)
    │      └── McpService (可选，setMcpService 延迟注入)
    │
    ├── SkillMarketService ──→ ConfigService, UserSkillService
    │
    └── HistoryService, FileSearchService, WebFetchService, HostProfileService,
        DocumentParserService —— 独立 service，无跨 service 依赖
```

## 文件命名约定

- **单文件 service**：`xxx.service.ts` → `XXX_SPEC.md`（同目录平级）
- **多文件 service**：`<子目录>/` → `<子目录>/SPEC.md`
- **已有标杆**：`AISERVICE_SPEC.md`（最早）、`agent/SPEC.md`、`plugin/SPEC.md`
