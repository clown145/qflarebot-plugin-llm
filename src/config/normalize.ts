import type { Capability } from '../contract.js'
import type { ModelConfig, ProtocolId, ProviderConfig, StoredConfig } from './types.js'
import { CAPABILITY_VALUES, LIMITS } from './types.js'
import { DEFAULT_TIMEOUT_MS } from './defaults.js'

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

const PROVIDER_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/
const MODEL_ALIAS = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,39}$/

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

function capabilities(value: unknown): Capability[] | undefined {
  if (!Array.isArray(value)) return undefined
  const allowed = new Set<string>(CAPABILITY_VALUES)
  const out: Capability[] = []
  for (const item of value) {
    if (typeof item !== 'string' || !allowed.has(item)) continue
    if (!out.includes(item as Capability)) out.push(item as Capability)
  }
  if (!out.length) return undefined
  if (!out.includes('text')) out.unshift('text')
  return out
}

export function normalizeModel(raw: unknown): ModelConfig {
  const item = isRecord(raw) ? raw : {}
  const maxTokens = numberOrUndefined(item['max_tokens'])
  const temperature = numberOrUndefined(item['temperature'])
  const contextWindow = numberOrUndefined(item['context_window'])
  const maxOutput = numberOrUndefined(item['max_output_tokens'])
  const caps = capabilities(item['capabilities'])
  return {
    alias: text(item['alias']),
    provider: text(item['provider']),
    model: text(item['model']),
    ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    ...(contextWindow !== undefined ? { context_window: contextWindow } : {}),
    ...(maxOutput !== undefined ? { max_output_tokens: maxOutput } : {}),
    ...(caps ? { capabilities: caps } : {}),
    enabled: typeof item['enabled'] === 'boolean' ? item['enabled'] : true,
  }
}

/**
 * 把 KV 里的旧值 / 页面草稿统一成完整结构；缺的字段补默认值，多的字段丢掉。
 *
 * 只做类型窄化和 trim，不在这里丢非法 id/alias：非法项若被静默丢掉，用户会看到「配置突然少了一个供应商」
 * 却不知道原因。合法性交给 validateConfig 报出来（保存前拦截、页面加载后展示）。
 */
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
    // 老配置里可能存着 25000/28000：保留原值（validateConfig 会 warn），实际调用时由 service 压到 call_timeout_max
    request_timeout_ms: clampTimeout(timeout ?? DEFAULT_TIMEOUT_MS),
    max_retries: clampRetries(retries ?? 1),
    updated_at: updatedAt || new Date().toISOString(),
  }
}

function clampTimeout(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_TIMEOUT_MS
  return Math.min(Math.max(Math.trunc(value), LIMITS.timeout_min), LIMITS.timeout_max)
}

function clampRetries(value: number): number {
  if (!Number.isFinite(value)) return 1
  return Math.min(Math.max(Math.trunc(value), 0), LIMITS.max_retries)
}

export { MODEL_ALIAS, PROVIDER_ID }
