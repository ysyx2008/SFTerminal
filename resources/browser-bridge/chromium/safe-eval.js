/**
 * CSP-safe expression evaluator — 不使用 eval / new Function()
 * Firefox 扩展 CSP 禁止动态代码生成；仅支持白名单表达式子集
 */
(function () {
  function normalize(code) {
    let expr = String(code || '').trim()
    if (expr.startsWith('return ')) expr = expr.slice(7).trim()
    return expr
  }

  function parseStringArg(raw, start) {
    const quote = raw[start]
    if (quote !== '"' && quote !== "'") return null
    let i = start + 1
    let value = ''
    while (i < raw.length) {
      const ch = raw[i]
      if (ch === '\\' && i + 1 < raw.length) {
        value += raw[i + 1]
        i += 2
        continue
      }
      if (ch === quote) return { value, end: i + 1 }
      value += ch
      i += 1
    }
    return null
  }

  function walkPropertyChain(expr) {
    const match = expr.match(/^(document|location|window)(\.[a-zA-Z_$][\w$]*)+$/)
    if (!match) return undefined
    const parts = expr.split('.')
    const roots = { document, location, window }
    let obj = roots[parts[0]]
    for (let i = 1; i < parts.length; i++) {
      if (obj == null) return null
      obj = obj[parts[i]]
    }
    return obj
  }

  function evaluateExpressionSafe(code) {
    const expr = normalize(code)
    if (!expr) return null

    const builtins = {
      'document.title': () => document.title,
      'document.URL': () => document.URL,
      'document.readyState': () => document.readyState,
      'document.characterSet': () => document.characterSet,
      'location.href': () => location.href,
      'location.hostname': () => location.hostname,
      'location.pathname': () => location.pathname,
      'location.search': () => location.search,
      'window.location.href': () => window.location.href,
      'window.innerWidth': () => window.innerWidth,
      'window.innerHeight': () => window.innerHeight,
    }
    if (builtins[expr]) return builtins[expr]()

    const qsaLen = expr.match(/^document\.querySelectorAll\((.+)\)\.length$/)
    if (qsaLen) {
      const parsed = parseStringArg(qsaLen[1], 0)
      if (parsed) return document.querySelectorAll(parsed.value).length
    }

    const qs = expr.match(/^document\.querySelector\((.+)\)(\.(textContent|innerText|innerHTML|value))?$/)
    if (qs) {
      const parsed = parseStringArg(qs[1], 0)
      if (parsed) {
        const el = document.querySelector(parsed.value)
        if (!el) return null
        const prop = qs[2]
        if (prop === '.value') return el.value
        if (prop === '.innerText') return el.innerText
        if (prop === '.innerHTML') return el.innerHTML
        return el.textContent
      }
    }

    const chain = walkPropertyChain(expr)
    if (chain !== undefined) return chain

    throw new Error(
      `Attach evaluate: unsupported expression (CSP-safe subset only). ` +
        `Supported: document.title, location.href, document.querySelector('...'), property chains on document/location/window. ` +
        `For arbitrary JS use browser_launch { "mode": "launch" }. Got: ${expr}`,
    )
  }

  globalThis.__sailfishSafeEval = evaluateExpressionSafe
})()
