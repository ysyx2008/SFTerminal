/**
 * 内置 AI 供应商预设模板（单一数据源）
 *
 * 任何需要展示 / 使用预设模板的地方，都应从此文件导入 {@link AI_TEMPLATES}，
 * 避免在组件内重复维护模板列表。
 *
 * 当前消费方：
 *   - src/components/SetupWizard.vue（首次引导向导）
 *   - src/components/Settings/AiSettings.vue（AI 设置页添加模板）
 *
 * 更新模板时只需修改本文件，两处 UI 都会同步。
 */

export interface AiTemplate {
  /** 模板名称（用于展示 & 作为 profile name） */
  name: string
  /** Chat Completions 兼容端点（Anthropic 原生除外） */
  apiUrl: string
  /** 默认 model ID */
  model: string
  /** 描述文案的 i18n key */
  descKey: string
  /** 申请/管理 API Key 的页面链接（空字符串表示无） */
  keyUrl: string
  /** 默认上下文长度（tokens） */
  contextLength: number
  /** 是否是本地部署（不需要 API Key 且不需要联网） */
  isLocal: boolean
  /** 是否需要 API Key */
  needsApiKey: boolean
}

export const AI_TEMPLATES: AiTemplate[] = [
  {
    name: 'DeepSeek',
    apiUrl: 'https://api.deepseek.com/v1/chat/completions',
    model: 'deepseek-chat',
    descKey: 'aiSettings.templates.deepseek',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    contextLength: 128000,
    isLocal: false,
    needsApiKey: true,
  },
  {
    name: 'Qwen',
    apiUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    model: 'qwen3.5-plus-2026-02-15',
    descKey: 'aiSettings.templates.qwen',
    keyUrl: 'https://bailian.console.aliyun.com/?tab=model#/api-key',
    contextLength: 1_000_000,
    isLocal: false,
    needsApiKey: true,
  },
  {
    name: 'Doubao',
    apiUrl: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions',
    model: 'doubao-seed-2-0-pro-260215',
    descKey: 'aiSettings.templates.doubao',
    keyUrl: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey',
    contextLength: 256_000,
    isLocal: false,
    needsApiKey: true,
  },
  {
    name: 'Zhipu',
    apiUrl: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    model: 'glm-5',
    descKey: 'aiSettings.templates.zhipu',
    keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
    contextLength: 200_000,
    isLocal: false,
    needsApiKey: true,
  },
  {
    name: 'Kimi',
    apiUrl: 'https://api.moonshot.cn/v1/chat/completions',
    model: 'kimi-k2.5',
    descKey: 'aiSettings.templates.kimi',
    keyUrl: 'https://platform.moonshot.cn/console/api-keys',
    contextLength: 256_000,
    isLocal: false,
    needsApiKey: true,
  },
  {
    name: 'MiniMax',
    apiUrl: 'https://api.minimaxi.com/v1/chat/completions',
    model: 'MiniMax-M2.7',
    descKey: 'aiSettings.templates.minimax',
    keyUrl: 'https://platform.minimaxi.com/user-center/basic-information/interface-key',
    contextLength: 204_800,
    isLocal: false,
    needsApiKey: true,
  },
  {
    name: 'OpenAI',
    apiUrl: 'https://api.openai.com/v1/chat/completions',
    model: 'gpt-5.4',
    descKey: 'aiSettings.templates.openai',
    keyUrl: 'https://platform.openai.com/api-keys',
    contextLength: 1_050_000,
    isLocal: false,
    needsApiKey: true,
  },
  {
    name: 'Claude',
    apiUrl: 'https://api.anthropic.com/v1/messages',
    model: 'claude-opus-4-7',
    descKey: 'aiSettings.templates.claude',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    contextLength: 1_000_000,
    isLocal: false,
    needsApiKey: true,
  },
  {
    name: 'Gemini',
    apiUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    model: 'gemini-2.5-pro',
    descKey: 'aiSettings.templates.gemini',
    keyUrl: 'https://aistudio.google.com/apikey',
    contextLength: 1_000_000,
    isLocal: false,
    needsApiKey: true,
  },
  {
    name: 'Grok',
    apiUrl: 'https://api.x.ai/v1/chat/completions',
    model: 'grok-4.20-0309-reasoning',
    descKey: 'aiSettings.templates.grok',
    keyUrl: 'https://console.x.ai/team/default/api-keys',
    contextLength: 2_000_000,
    isLocal: false,
    needsApiKey: true,
  },
  {
    name: 'Mistral',
    apiUrl: 'https://api.mistral.ai/v1/chat/completions',
    model: 'mistral-large-2512',
    descKey: 'aiSettings.templates.mistral',
    keyUrl: 'https://console.mistral.ai/api-keys',
    contextLength: 256_000,
    isLocal: false,
    needsApiKey: true,
  },
  {
    name: 'Ollama',
    apiUrl: 'http://localhost:11434/v1/chat/completions',
    model: 'qwen2.5:7b',
    descKey: 'aiSettings.templates.ollama',
    keyUrl: 'https://ollama.com/',
    contextLength: 32_000,
    isLocal: true,
    needsApiKey: false,
  },
]
