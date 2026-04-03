/**
 * Hello World 示例插件
 *
 * 演示：
 *   - 注册两个工具（greet + random_number）
 *   - 注册 before_tool_call Hook（记录审计日志）
 *
 * 用法：
 *   将本目录复制到 {userData}/plugins/plugin-hello/
 *   重启 SailFish，Agent 即可调用 greet 和 random_number 工具
 */

module.exports = {
  default: {
    id: 'hello-world',

    register(api) {

      // ---- 工具 1：打招呼 ----
      api.registerTool({
        name: 'greet',
        description: '用指定语言向某人打招呼',
        parameters: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: '要问候的人名'
            },
            language: {
              type: 'string',
              enum: ['zh', 'en', 'ja', 'ko'],
              description: '语言（默认 zh）'
            }
          },
          required: ['name']
        },
        async execute(_toolCallId, params) {
          const greetings = {
            zh: `你好，${params.name}！`,
            en: `Hello, ${params.name}!`,
            ja: `こんにちは、${params.name}！`,
            ko: `안녕하세요, ${params.name}!`
          }
          const lang = params.language || 'zh'
          const text = greetings[lang] || greetings.zh
          return { content: [{ type: 'text', text }] }
        }
      })

      // ---- 工具 2：随机数 ----
      api.registerTool({
        name: 'random_number',
        description: '生成指定范围内的随机整数',
        parameters: {
          type: 'object',
          properties: {
            min: { type: 'number', description: '最小值（含）' },
            max: { type: 'number', description: '最大值（含）' }
          },
          required: ['min', 'max']
        },
        async execute(_toolCallId, params) {
          const min = Math.ceil(params.min)
          const max = Math.floor(params.max)
          const result = Math.floor(Math.random() * (max - min + 1)) + min
          return {
            content: [{
              type: 'text',
              text: `随机数结果：${result}（范围 ${min}-${max}）`
            }]
          }
        }
      })

      // ---- Hook：审计日志 ----
      api.registerHook('before_tool_call', (context) => {
        console.log(`[hello-world] 工具调用: ${context.toolName}`, JSON.stringify(context.toolArgs))
        return {}
      })
    }
  }
}
