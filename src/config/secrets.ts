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
 * 页面提交后按 provider id 合并密钥：
 * api_key 字符串=替换、null=清除、省略或空串=保留已存的值。
 * 这样页面改 base_url、开关时不会把密钥清掉，也不需要把真值发给浏览器。
 */
export function mergeSecrets(input: PublicConfigInput, current: StoredConfig, now = new Date()): StoredConfig {
  const next = normalizeConfig(input)
  next.schema_version = 1
  next.version = current.version + 1
  next.updated_at = now.toISOString()

  for (const provider of next.providers) {
    const submitted = input.providers.find((item) => item.id === provider.id)
    const existing = current.providers.find((item) => item.id === provider.id)
    if (submitted?.api_key === null) {
      delete provider.api_key
    } else if (typeof submitted?.api_key === 'string' && submitted.api_key.trim()) {
      provider.api_key = submitted.api_key.trim()
    } else if (existing?.api_key) {
      provider.api_key = existing.api_key
    }
  }
  return next
}
