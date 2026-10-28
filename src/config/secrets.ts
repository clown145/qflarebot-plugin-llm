import type { PublicConfig, PublicConfigInput, PublicProvider, StoredConfig } from './types.js'
import { normalizeConfig } from './normalize.js'

/** 下发给页面的视图：密钥只保留“有没有设置” */
export function toPublicConfig(config: StoredConfig): PublicConfig {
  const providers: PublicProvider[] = config.providers.map((provider) => {
    const { api_key: key, ...rest } = provider
    return { ...rest, api_key_set: Boolean(key) }
  })
  return {
    schema_version: config.schema_version,
    version: config.version,
    providers,
    models: config.models,
    default_model: config.default_model,
    request_timeout_ms: config.request_timeout_ms,
    max_retries: config.max_retries,
    updated_at: config.updated_at,
  }
}

/**
 * 提交的供应商能否沿用已存密钥。
 *
 * 只按 id 沿用是不够的：id 是页面生成的稳定标识，但 `base_url` 决定密钥发到哪里。
 * 地址或协议一变就沿用，等于允许「改地址不改 Key」把本机凭据送到任意第三方。
 * 所以这里要求 id、协议、规范化后的地址三者都一致。
 */
export function canReuseSecret(
  submitted: { id: string; protocol: string; base_url: string },
  existing: { id: string; protocol: string; base_url: string } | undefined,
): boolean {
  if (!existing) return false
  return (
    submitted.id === existing.id &&
    submitted.protocol === existing.protocol &&
    normalizeBaseUrl(submitted.base_url) === normalizeBaseUrl(existing.base_url)
  )
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '').toLowerCase()
}

/**
 * 页面提交后按 provider id 合并密钥：
 * api_key 字符串=替换、null=清除、省略或空串=保留已存的值（**仅当地址与协议都没变**）。
 * 这样页面改名字、开关时不会把密钥清掉，也不需要把真值发给浏览器；而改地址时不会把旧密钥带过去。
 *
 * 注意匹配必须用 trim 后的 id：provider.id 是 normalizeProvider trim 的产物，
 * 直接调 API 提交 `id:' p '` 时原始 id 对不上，null/新串的意图会被静默丢弃。
 */
export function mergeSecrets(input: PublicConfigInput, current: StoredConfig, now = new Date()): StoredConfig {
  const next = normalizeConfig(input)
  next.schema_version = 1
  next.version = current.version + 1
  next.updated_at = now.toISOString()

  for (const provider of next.providers) {
    const submitted = input.providers.find((item) => item && typeof item.id === 'string' && item.id.trim() === provider.id)
    const existing = current.providers.find((item) => item.id === provider.id)
    if (submitted?.api_key === null) {
      delete provider.api_key
    } else if (typeof submitted?.api_key === 'string' && submitted.api_key.trim()) {
      provider.api_key = submitted.api_key.trim()
    } else if (existing?.api_key && canReuseSecret(provider, existing)) {
      provider.api_key = existing.api_key
    }
  }
  return next
}

/** 提交的供应商里，哪些因为地址/协议变了而丢了已存密钥；页面据此提示用户重填 */
export function droppedSecrets(input: PublicConfigInput, current: StoredConfig): string[] {
  const dropped: string[] = []
  for (const submitted of input.providers) {
    if (!submitted || typeof submitted !== 'object') continue
    const id = typeof submitted.id === 'string' ? submitted.id.trim() : ''
    if (!id) continue
    const existing = current.providers.find((item) => item.id === id)
    if (!existing?.api_key) continue
    const submittedKey = typeof submitted.api_key === 'string' ? submitted.api_key.trim() : ''
    if (submittedKey || submitted.api_key === null) continue
    if (!canReuseSecret({ id, protocol: String(submitted.protocol ?? ''), base_url: String(submitted.base_url ?? '') }, existing)) dropped.push(id)
  }
  return dropped
}
