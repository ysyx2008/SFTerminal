/**
 * LanceDB / DataFusion 等值过滤。
 *
 * 当前这版会把未加反引号的驼峰列名归一成小写（`docId` → `docid`），
 * 双引号又当成字符串字面量，结果 `"docId" = '…'` 永远命中 0 行。
 * 必须用反引号包列名。lancedb-worker.js 里有一份同文，改这里要一起改。
 */
export function lanceEquals(column: string, value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(column)) {
    throw new Error(`invalid LanceDB column: ${column}`)
  }
  const escaped = String(value).replace(/'/g, "''")
  return `\`${column}\` = '${escaped}'`
}
