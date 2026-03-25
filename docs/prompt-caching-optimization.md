# Prompt 缓存优化：降低 AI API 费用

本文档记录旗鱼在 v10.26.0 中实施的 prompt 缓存优化方案，涵盖各家厂商的缓存机制差异、我们的适配策略、以及后续维护注意事项。

---

## 目录

1. [背景与动机](#背景与动机)
2. [各厂商缓存机制](#各厂商缓存机制)
3. [我们的优化策略](#我们的优化策略)
4. [代码实现](#代码实现)
5. [效果估算](#效果估算)
6. [维护指南](#维护指南)

---

## 背景与动机

旗鱼的 Agent 采用 ReAct 循环执行任务：思考 → 工具调用 → 观察结果 → 循环。一个典型任务需要 3-10 轮 API 请求，每轮都要发送完整的上下文（系统提示词 + 工具定义 + 对话历史）。

随着对话推进，输入 token 数量快速增长（可达数万），而其中大部分内容（系统提示词、工具定义、早期对话历史）在轮次之间完全相同。主流 AI 厂商都提供了前缀缓存机制，缓存命中部分的费用远低于未命中部分：

| 厂商 | 缓存命中折扣 | 示例 |
|------|------------|------|
| DeepSeek | **10x**（命中价 = 原价的 1/10） | ¥0.2 vs ¥2 / 百万 tokens |
| OpenAI | **2x**（命中价 = 原价的 1/2） | $1.25 vs $2.50 / 百万 tokens (GPT-4o) |
| Anthropic | **~10x**（写入 +25%，读取 -90%） | 缓存写入 $4.50，读取 $0.30 / 百万 tokens (Sonnet) |

**核心洞察**：只要确保请求之间的前缀稳定不变，就能让绝大部分输入 token 走缓存价，大幅降低费用。

---

## 各厂商缓存机制

### DeepSeek — 自动前缀缓存

- **机制**：自动匹配输入 token 序列的公共前缀，无需任何代码标记
- **粒度**：64 tokens（不足 64 tokens 的尾部不缓存）
- **生效条件**：两次请求的输入 token 序列从头开始有公共前缀
- **缓存生命周期**：秒级构建，几小时到几天自动失效
- **响应字段**：`usage.prompt_cache_hit_tokens` / `usage.prompt_cache_miss_tokens`
- **关键限制**：前缀中任何一个 token 不同，后面全部变为 miss

### OpenAI — 自动前缀缓存

- **机制**：与 DeepSeek 类似，自动匹配前缀
- **粒度**：128 tokens
- **最低门槛**：至少 1024 tokens 才会触发缓存
- **响应字段**：`usage.prompt_tokens_details.cached_tokens`
- **特殊点**：tool 定义也参与前缀匹配（在 system 之前）

### Anthropic — 显式缓存标记

- **机制**：需要在请求中显式标记 `cache_control: { type: "ephemeral" }`
- **标记位置**：system content block、tool 定义、user message 中均可标记
- **最多断点**：4 个 `cache_control` 断点
- **最低门槛**：1024 tokens（Sonnet）/ 2048 tokens（Opus）
- **缓存生命周期**：5 分钟（每次命中刷新 TTL）
- **响应字段**：`usage.cache_creation_input_tokens` / `usage.cache_read_input_tokens`
- **需要 beta header**：`anthropic-beta: prompt-caching-2024-07-31`

### Google Gemini — Context Caching API

- **机制**：独立的缓存对象 API，需预先创建 CachedContent 再引用
- **适用场景**：超长上下文（如大文档分析）
- **当前状态**：旗鱼尚未适配此 API

---

## 我们的优化策略

### 策略一：消除系统提示词中的动态内容

**问题**：优化前，系统提示词包含两处每次请求都会变化的内容：
1. `当前时间`（`buildDynamicContext`）— 每秒不同
2. `上下文用量状态`（`updateContextPressure` 注入的 token 计数）— 每轮不同

这导致系统提示词每次请求都不同，整个前缀缓存失效（系统提示词是 messages 序列的第一条）。

**解决方案**：
- 禁用 `buildDynamicContext()`，AI 需要时间时通过 `date` 命令获取
- 禁用 `updateContextPressure` 中的系统提示词注入，上下文压力由 85% 警告消息兜底
- 相关代码已注释保留，如需恢复可取消注释

**相关文件**：
- `electron/services/agent/prompt-builder.ts` — `buildDynamicContext()` 已注释
- `electron/services/agent/agent.ts` — `updateContextPressure()` 中的系统提示词注入已注释

### 策略二：按缓存友好度重排系统提示词

**问题**：优化前，CWD（当前工作目录）位于 `buildIdentitySection()`，是系统提示词的第二个 section。不同终端的 CWD 不同，导致从第二个 section 开始就无法共享缓存前缀。

**解决方案**：将 sections 按三层缓存优先级重排：

```
Tier 1 — 全局稳定（所有终端/Agent 共享）
├── buildLanguageRule()           # 固定字符串
├── buildIdentitySection()        # Agent 名称 + 身份文件（CWD 已移出）
├── buildUserProfileSection()     # USER.md
├── buildSoulSection()            # SOUL.md + MBTI
├── buildBondSection()            # 羁绊记录
├── buildUserRulesSection()       # 用户自定义规则
├── buildWorkspaceRule()          # 工作空间路径
├── buildCoreRules()              # 核心行为规则
└── buildSkillsSummary()          # 用户技能列表

Tier 2 — 终端/主机级（同一终端内稳定）
├── buildHostEnvironment()        # OS、Shell、CWD（从 Identity 移入）
└── buildRemoteChannelContext()   # IM 通道信息

Tier 3 — 任务级（同一任务 ReAct 循环内稳定）
├── buildKnowledgeDocSection()    # L2 知识文档
├── buildConversationHistorySection()  # L3 语义检索结果
├── buildWatchListSection()       # 关切列表
├── buildSkillsContentSection()   # 已加载的技能内容
├── buildKnowledgeContext()       # 知识搜索结果
└── buildTaskMemorySection()      # L1 任务记忆
```

**效果**：
- 同一 API Key 下多个 Agent 并发 → 共享 Tier 1 前缀（~3000-6000 tokens）
- 同一终端连续任务 → 共享 Tier 1 + Tier 2 前缀
- 同一任务 ReAct 循环 → 共享全部前缀

### 策略三：Anthropic 显式缓存标记

由于 Anthropic 不自动缓存，需要在代码中显式标记缓存断点：

**断点 1 — 系统提示词**：整个系统提示词标记为 `cache_control: { type: "ephemeral" }`

**断点 2 — 工具定义列表最后一项**：使 "系统提示词 + 全部工具定义" 整段被缓存

**额外配置**：请求头添加 `anthropic-beta: prompt-caching-2024-07-31`

### 策略四：缓存命中统计日志

为了监控优化效果，统一采集各家的缓存命中数据：

```typescript
interface TokenUsageInfo {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  cache_hit_tokens?: number    // 缓存命中 tokens
  cache_miss_tokens?: number   // 缓存未命中 tokens
}
```

`extractCacheStats()` 函数归一化各家格式：
- DeepSeek: `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`
- Anthropic: `cache_read_input_tokens` / `cache_creation_input_tokens`
- OpenAI: `prompt_tokens_details.cached_tokens`

日志输出示例：
```
tokens=15000+500=15500, cache_hit=12000(80%)
```

---

## 代码实现

### 涉及的文件

| 文件 | 改动 |
|------|------|
| `electron/services/agent/prompt-builder.ts` | sections 按三层重排；CWD 从 Identity 移到 HostEnvironment；动态内容注释 |
| `electron/services/agent/agent.ts` | `updateContextPressure` 中的系统提示词注入注释 |
| `electron/services/ai.service.ts` | Anthropic 缓存标记；`extractCacheStats` 归一化；缓存命中日志 |

### 请求结构对比

#### OpenAI / DeepSeek（自动前缀缓存）

```json
{
  "model": "deepseek-chat",
  "messages": [
    { "role": "system", "content": "系统提示词（稳定）" },
    { "role": "user", "content": "用户消息" },
    { "role": "assistant", "content": "...", "tool_calls": [...] },
    { "role": "tool", "content": "工具结果", "tool_call_id": "..." }
  ],
  "tools": [{ "type": "function", "function": { "name": "exec", ... } }],
  "stream": true,
  "stream_options": { "include_usage": true }
}
```

前缀缓存匹配的是 input tokens 序列：`tools + system + 历史消息`，从头开始，遇到第一个不同的 token 即停止。

#### Anthropic（显式缓存）

```json
{
  "model": "claude-sonnet-4-20250514",
  "system": [
    { "type": "text", "text": "系统提示词", "cache_control": { "type": "ephemeral" } }
  ],
  "tools": [
    { "name": "exec", "description": "...", "input_schema": {...} },
    { "name": "read_file", ..., "cache_control": { "type": "ephemeral" } }
  ],
  "messages": [
    { "role": "user", "content": "用户消息" },
    { "role": "assistant", "content": [{ "type": "tool_use", ... }] },
    { "role": "user", "content": [{ "type": "tool_result", ... }] }
  ]
}
```

Anthropic 的 tool 结果必须放在 `role: "user"` 的 `tool_result` content block 中，且 system 是独立的顶层字段。

### ReAct 循环中的缓存命中示例

```
第 1 轮: [tools][system][user₁]                         → 全 miss（首次构建缓存）
第 2 轮: [tools][system][user₁][asst₁][tool₁]           → 命中到 [user₁]
第 3 轮: [tools][system][user₁][asst₁][tool₁][asst₂]... → 命中到 [tool₁]
第 4 轮: ...                                             → 前缀越来越长
第 5 轮: ...                                             → 绝大部分命中
```

---

## 效果估算

### 单次任务（5 轮 ReAct，DeepSeek 为例）

| 轮次 | 输入 tokens | 优化前（全 miss） | 优化后（前缀命中） |
|------|-----------|-----------------|-------------------|
| 第 1 轮 | 10,000 | ¥0.020 | ¥0.020 |
| 第 2 轮 | 15,000 | ¥0.030 | ¥0.004 |
| 第 3 轮 | 20,000 | ¥0.040 | ¥0.005 |
| 第 4 轮 | 25,000 | ¥0.050 | ¥0.006 |
| 第 5 轮 | 30,000 | ¥0.060 | ¥0.007 |
| **合计** | | **¥0.200** | **¥0.042** |

**单次任务节省约 79% 输入费用**。

### 按任务复杂度

| 复杂度 | ReAct 轮数 | 节省比例 |
|--------|-----------|---------|
| 简单 | 1-2 轮 | 30-50% |
| 中等 | 5 轮 | ~79% |
| 复杂 | 10+ 轮 | 85-90% |

### 跨平台

| 平台 | 节省比例 | 备注 |
|------|---------|------|
| DeepSeek | 70-90% | 10x 折扣，收益最大 |
| Anthropic | 60-85% | 需显式标记，已适配 |
| OpenAI | 30-45% | 2x 折扣，收益较小 |

---

## 维护指南

### 添加新的 prompt section 时

1. **判断稳定性层级**：
   - 全局不变 → 放入 Tier 1（`buildCoreRules` 前后）
   - 随终端/主机变化 → 放入 Tier 2（`buildHostEnvironment` 附近）
   - 随任务变化 → 放入 Tier 3（末尾）
2. **绝不在 Tier 1 中引入动态内容**（如时间、计数器、随机 ID）
3. 如果新 section 必须包含动态内容，放在 Tier 3 最末

### 恢复动态内容（如确有必要）

如果未来需要恢复当前时间或上下文用量注入：

1. `prompt-builder.ts`：取消 `CACHE_BREAK_MARKER` 和 `buildDynamicContext()` 的注释
2. `agent.ts`：取消 `updateContextPressure` 中系统提示词注入的注释
3. 注意：这会降低缓存命中率，需权衡收益

### 注意：Anthropic 缓存断点上限

Anthropic 最多支持 4 个 `cache_control` 断点。当前使用了 2 个（system + tools 末项）。如果需要添加更多断点（如对话中的关键 user 消息），需确保总数不超过 4。

### 多 Agent 并发场景

同一 API Key 下多个 Agent 并发运行时：
- DeepSeek/OpenAI：缓存在 API Key 级别共享，Tier 1 前缀可被所有请求共享
- Anthropic：缓存隔离规则由 Anthropic 控制，通常同 Key 共享
- 不同 Agent 的系统提示词在 Tier 2 开始分叉（CWD 不同），Tier 1 仍可共享

### 监控缓存效果

查看日志中的 `cache_hit` 字段：

```
# 正常（高命中率）
tokens=25000+800=25800, cache_hit=22000(88%)

# 异常（低命中率，需排查是否引入了动态内容）
tokens=25000+800=25800, cache_hit=0(0%)
```

如果观察到持续 0% 命中率，检查：
1. 系统提示词是否被注入了动态内容
2. 工具定义是否在请求间发生了变化
3. 是否使用了不支持缓存的模型/平台
