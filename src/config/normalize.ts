import type { ModelConfig, ProtocolId, ProviderConfig, StoredConfig } from './types.js'

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.trim() : fallback
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function stringMap(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined
  const out: Record<string, string> = {}
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw !== 'string') continue
    const name = key.trim()
    if (name) out[name] = raw
  }
  return Object.keys(out).length ? out : undefined
}

export function normalizeProvider(raw: unknown, index: number): ProviderConfig {
  const item = isRecord(raw) ? raw : {}
  const protocol: ProtocolId = item['protocol'] === 'anthropic' ? 'anthropic' : 'openai'
  const id = text(item['id'])
  const baseUrl = text(item['base_url']).replace(/\/+$/, '')
  const apiKey = text(item['api_key'])
  const headers = stringMap(item['headers'])
  const timeout = numberOrUndefined(item['timeout_ms'])
  return {
    id,
    name: text(item['name']) || id || `供应商 ${index + 1}`,
    protocol,
    base_url: baseUrl,
    ...(apiKey ? { api_key: apiKey } : {}),
    ...(headers ? { headers } : {}),
    ...(timeout !== undefined ? { timeout_ms: timeout } : {}),
    enabled: typeof item['enabled'] === 'boolean' ? item['enabled'] : true,
  }
}

export function normalizeModel(raw: unknown): ModelConfig {
  const item = isRecord(raw) ? raw : {}
  const maxTokens = numberOrUndefined(item['max_tokens'])
  const temperature = numberOrUndefined(item['temperature'])
  return {
    alias: text(item['alias']),
    provider: text(item['provider']),
    model: text(item['model']),
    ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    enabled: typeof item['enabled'] === 'boolean' ? item['enabled'] : true,
  }
}

/** 把 KV 里的旧值 / 页面草稿统一成完整结构；缺的字段补默认值，多的字段丢掉 */
export function normalizeConfig(raw: unknown): StoredConfig {
  const item = isRecord(raw) ? raw : {}
  const providers = Array.isArray(item['providers']) ? item['providers'].map(normalizeProvider) : []
  const models = Array.isArray(item['models']) ? item['models'].map(normalizeModel) : []
  const version = numberOrUndefined(item['version'])
  const timeout = numberOrUndefined(item['request_timeout_ms'])
  const retries = numberOrUndefined(item['max_retries'])
  const updatedAt = text(item['updated_at'])
  return {
    schema_version: 1,
    version: typeof version === 'number' && Number.isInteger(version) && version >= 0 ? version : 1,
    providers,
    models,
    default_model: text(item['default_model']),
    request_timeout_ms: timeout ?? 25000,
    max_retries: retries ?? 1,
    updated_at: updatedAt || new Date().toISOString(),
  }
}
