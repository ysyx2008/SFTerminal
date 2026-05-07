// 没有官方 @types 的可选依赖，统一在这里写 ambient 声明。
//
// 这些包都通过 `await import(...)` 动态加载，运行时缺失会被 try/catch 兜住，
// 因此声明只需覆盖代码实际访问到的成员，不必精确还原上游 API。
// 上游若发布了 @types/* 或自带类型，应优先安装并删除对应块。

declare module 'word-extractor' {
  // CommonJS class，运行时通过 `import('word-extractor').then(m => m.default)` 取到构造函数。
  class WordExtractor {
    extract(input: string | Buffer): Promise<{
      getBody(): string
      getHeaders(): string
      getFooters(): string
    }>
  }
  export default WordExtractor
}

declare module 'silk-wasm' {
  /** 解码 SILK 音频为 PCM s16le。采样率默认 24000。 */
  export function decode(
    silk: Uint8Array | Buffer,
    sampleRate?: number,
  ): Promise<{ data: Uint8Array; duration: number }>
}

declare module 'qrcode-terminal' {
  interface QrTerminal {
    generate(text: string, options?: { small?: boolean }): void
    generate(text: string, options: { small?: boolean }, cb: (qr: string) => void): void
  }
  const qrterm: QrTerminal
  export default qrterm
}
