/**
 * 密钥脱敏。日志、错误消息、导出文件都走这里，避免上游回显、截断或编码后的 key 漏出去。
 *
 * 两条防线：
 * 1. 精确值替换（调用方知道自己用的是哪个 key，哪怕上游把它截断/拼接也能命中）；
 * 2. 常见凭据形态的模式匹配（上游常把 key 放进 `Bearer …`、`x-api-key: …` 或错误消息里回显）。
 *
 * 只做「掩码」不做「删除」，保留一点前缀便于排查是哪一个凭据。
 */

/** 短于此长度的「密钥」不参与精确替换，避免把普通单词整段抹掉 */
const MIN_SECRET_LENGTH = 6

/** 常见凭据前缀；命中后整段替换成 `***` */
const CREDENTIAL_PATTERNS: ReadonlyArray<RegExp> = [
  // OpenAI / Anthropic / 各类兼容网关：sk-…、sk-ant-…、sk-proj-…、sk-or-v1-…
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  // HuggingFace / GitHub / Slack
  /\b(?:hf|gh[pousr]|xox[abposr])_[A-Za-z0-9_-]{8,}/g,
  // Google API key
  /\bAIza[0-9A-Za-z_-]{20,}/g,
  // AWS access key id
  /\bAKIA[0-9A-Z]{12,}/g,
  // 智谱 / 阿里云等常见 32 位十六进制风格的 key
  /\b[0-9a-f]{32}\.[0-9A-Za-z]{8,}/g,
]

/** 键值上下文里的凭据：`Bearer <token>`、`x-api-key: <token>`、`"api_key": "<token>"` */
const CONTEXT_PATTERNS: ReadonlyArray<{ pattern: RegExp; mask: string }> = [
  { pattern: /(\bBearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, mask: '$1***' },
  { pattern: /(\bx-api-key["'\s:=]+)[A-Za-z0-9._~+/=-]{8,}/gi, mask: '$1***' },
  { pattern: /(\b(?:api[_-]?key|access[_-]?token|secret[_-]?key)["'\s:=]+)[A-Za-z0-9._~+/=-]{8,}/gi, mask: '$1***' },
]

/**
 * 精确值替换：大小写不敏感 + 追加 URL 编码变体。
 *
 * 上游偶尔会把 key 大写化（`SK-ABC…`）或 URL 编码（`sk%2Dabc…`）后回显进错误消息，
 * split/join 的精确匹配与区分大小写的形态模式都命中不了。
 */
function replaceExact(text: string, secret: string): string {
  let out = text.split(secret).join('***')
  const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // 大小写不敏感的兜底（可能覆盖精确替换已命中的位置，但结果一样是 ***）
  out = out.replace(new RegExp(escaped, 'gi'), '***')
  // URL 编码变体：编码后常见差异是 - → %2D、/ → %2F、+ → %2B。
  // encodeURIComponent 不动这些「未保留字符」，所以手动构造可能被网关编码的形态
  for (const encoded of urlEncodedVariants(secret)) {
    out = out.split(encoded).join('***')
  }
  return out
}

/** 密钥可能被上游 URL 编码的形态：整体编码 + 只编码 -/+// 三种常见差异字符 */
function urlEncodedVariants(secret: string): string[] {
  const variants = new Set<string>()
  const full = encodeURIComponent(secret)
  if (full !== secret) variants.add(full)
  const partial = secret.replace(/[-+/]/g, (ch) => ({ '-': '%2D', '/': '%2F', '+': '%2B' })[ch] ?? ch)
  if (partial !== secret) variants.add(partial)
  return [...variants]
}

/** 把文本里的密钥替换成 `***`；不传 secret 时只做模式匹配 */
export function redact(text: string, secret?: string): string {
  if (!text) return text
  let out = text
  if (secret && secret.length >= MIN_SECRET_LENGTH) out = replaceExact(out, secret)
  for (const pattern of CREDENTIAL_PATTERNS) {
    pattern.lastIndex = 0
    out = out.replace(pattern, '***')
  }
  for (const { pattern, mask } of CONTEXT_PATTERNS) {
    pattern.lastIndex = 0
    out = out.replace(pattern, mask)
  }
  return out
}

/**
 * 一次脱敏多个密钥（例如同时持有多个供应商的 key）。
 * 长度降序：互为前缀时先替换长的，否则短密钥会把长密钥切成 `***bbbb` 的残段。
 * 没有可用密钥时也跑一遍纯模式匹配——上游回显的凭据不一定属于本插件配置。
 */
export function redactAll(text: string, secrets: ReadonlyArray<string | undefined>): string {
  const sorted = secrets
    .filter((secret): secret is string => typeof secret === 'string' && secret.length >= MIN_SECRET_LENGTH)
    .sort((a, b) => b.length - a.length)
  let out = text
  for (const secret of sorted) out = redact(out, secret)
  if (sorted.length === 0) out = redact(out)
  return out
}

/** 是否看起来像凭据；用于在保存/导出时提示用户不要把它写进普通字段 */
export function looksLikeSecret(value: string): boolean {
  if (value.length < 12) return false
  return CREDENTIAL_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0
    return pattern.test(value)
  })
}
