# TTS Service — 语音合成服务

## 职责

为 AI Agent 回复提供"边生成边朗读"的语音合成能力。管理 TTS provider 注册、配置读取和合成路由。

## 架构

```
Main Process                    Renderer
─────────────                   ─────────
TtsService (index.ts)           useTts composable
  ├── providers: Map<id, TtsProvider>     ├── 句子缓冲器
  ├── registerProvider()                  ├── Markdown 过滤
  ├── synthesize(text, opts)              ├── 并行合成请求
  └── getVoices()                         └── 串行音频播放队列
        ↑                                       |
  Built-in providers:                     IPC: tts:synthesize
    openai-compat (OpenAI/兼容服务)        IPC: tts:getVoices
    volcengine-tts (火山引擎/豆包)         IPC: tts:stop
    dashscope-tts (阿里云/通义千问)
  Plugin providers
```

## 公开 API

### 模块级函数（electron/services/tts/index.ts）

| 函数 | 说明 |
|------|------|
| `registerBuiltinProviders()` | 注册内置 providers（OpenAI/火山引擎/DashScope） |
| `registerProvider(provider)` | 注册自定义 TTS provider |
| `removeProvider(id)` | 移除 provider |
| `updateSettings(settings)` | 更新配置 |
| `getSettings()` | 获取当前配置 |
| `getProviders()` | 列出所有已注册 provider |
| `synthesize(text, opts?)` | 合成语音 → `TtsSynthesizeResult` |
| `getVoices()` | 获取当前 provider 的可用声色 |
| `stopSynthesis()` | 取消进行中的合成 |
| `dispose()` | 释放所有资源 |

### TtsProvider 接口（types.ts）

```typescript
interface TtsProvider {
  id: string
  name: string
  synthesize(text: string, options: TtsSynthesizeOptions): Promise<TtsSynthesizeResult>
  getVoices?(): Promise<TtsVoice[]>
  dispose?(): void
}
```

### IPC 通道

| 通道 | 方向 | 说明 |
|------|------|------|
| `tts:synthesize` | renderer → main | 合成语音，返回 `{ success, audio, format }` |
| `tts:getVoices` | renderer → main | 获取可用声色列表 |
| `tts:getProviders` | renderer → main | 获取已注册 provider 列表 |
| `tts:stop` | renderer → main | 取消当前合成 |

## 配置

存储在 `config.service.ts` 的 `ttsSettings` key：

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| enabled | boolean | false | 总开关 |
| providerId | string | 'openai-compat' | 活跃 provider |
| apiUrl | string | OpenAI endpoint | API 地址 |
| apiKey | string | '' | API 密钥 |
| model | string | 'tts-1' | 模型名 |
| voice | string | 'alloy' | 声色 |
| speed | number | 1.0 | 语速 |
| autoSpeak | boolean | false | 自动朗读 |

## 依赖

- `config.service.ts` — 读取 `ttsSettings`
- `plugin/registry.ts` — 获取插件 TTS providers

## 插件扩展

插件可通过 `registerTtsProvider(def)` 注册自定义 provider，实现 `TtsProvider` 接口即可。

## 约束

- 只朗读 `step.type === 'message'` 的 AI 回复内容
- 代码块、链接、图片等 Markdown 语法会被过滤
- 前端负责句子切分和播放调度，后端只负责单句合成
