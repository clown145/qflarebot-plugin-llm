import type { ModelConfig, ProtocolId, PublicConfig, PublicConfigInput, PublicProvider, PublicProviderInput } from '../src/config/types.js'

export type Tab = 'overview' | 'providers' | 'models' | 'settings' | 'usage'

export interface ProviderDraft extends Omit<PublicProvider, 'api_key_set'> {
  api_key?: string
  api_key_set: boolean
  /** 页面点了“清除”，保存时发 null */
  clear_key?: boolean
}

export interface AppConfigDraft {
  providers: ProviderDraft[]
  models: ModelConfig[]
  default_model: string
  request_timeout_ms: number
  max_retries: number
}

export function clone<T>(value: T): T {
  return structuredClone(value)
}

export function fromPublicConfig(config: PublicConfig): AppConfigDraft {
  return {
    providers: config.providers.map((provider) => ({ ...provider, api_key_set: provider.api_key_set, clear_key: false })),
    models: clone(config.models),
    default_model: config.default_model,
    request_timeout_ms: config.request_timeout_ms,
    max_retries: config.max_retries,
  }
}

/** 提交给后端的形状：api_key 省略=保留、null=清除、字符串=替换 */
export function toInput(config: AppConfigDraft): PublicConfigInput {
  return {
    providers: config.providers.map((provider) => {
      const { api_key_set, clear_key, api_key, ...rest } = provider
      const out: PublicProviderInput = { ...rest, enabled: provider.enabled }
      if (clear_key) out.api_key = null
      else if (api_key?.trim()) out.api_key = api_key.trim()
      return out
    }),
    models: clone(config.models),
    default_model: config.default_model,
    request_timeout_ms: config.request_timeout_ms,
    max_retries: config.max_retries,
  }
}

/** 导出永远不带密钥；导入时用户需要重新填 */
export function toExport(config: AppConfigDraft, version: number, updatedAt: string): PublicConfig {
  return {
    schema_version: 1,
    version,
    providers: config.providers.map((provider) => {
      const { api_key, clear_key, ...rest } = provider
      return { ...rest, api_key_set: provider.api_key_set && !clear_key }
    }),
    models: clone(config.models),
    default_model: config.default_model,
    request_timeout_ms: config.request_timeout_ms,
    max_retries: config.max_retries,
    updated_at: updatedAt,
  }
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function headersOf(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const out: Record<string, string> = {}
  for (const [key, raw] of Object.entries(value)) if (typeof raw === 'string') out[key] = raw
  return Object.keys(out).length ? out : undefined
}

export function normalizeDraft(value: unknown): AppConfigDraft {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('配置文件必须是 JSON 对象')
  const raw = value as Record<string, unknown>
  const providersRaw = Array.isArray(raw['providers']) ? raw['providers'] : []
  const modelsRaw = Array.isArray(raw['models']) ? raw['models'] : []

  const providers: ProviderDraft[] = providersRaw.map((item, index) => {
    const p = item && typeof item === 'object' ? (item as Record<string, unknown>) : {}
    const apiKey = text(p['api_key'])
    const protocol: ProtocolId = p['protocol'] === 'anthropic' ? 'anthropic' : 'openai'
    const timeout = numberOrUndefined(p['timeout_ms'])
    const headers = headersOf(p['headers'])
    return {
      id: text(p['id']) || `provider-${index + 1}`,
      name: text(p['name']) || `供应商 ${index + 1}`,
      protocol,
      base_url: text(p['base_url']),
      ...(apiKey ? { api_key: apiKey } : {}),
      api_key_set: typeof p['api_key_set'] === 'boolean' ? p['api_key_set'] : Boolean(apiKey),
      clear_key: false,
      ...(headers ? { headers } : {}),
      ...(timeout !== undefined ? { timeout_ms: timeout } : {}),
      enabled: typeof p['enabled'] === 'boolean' ? p['enabled'] : true,
    }
  })

  const models: ModelConfig[] = modelsRaw.map((item) => {
    const m = item && typeof item === 'object' ? (item as Record<string, unknown>) : {}
    const maxTokens = numberOrUndefined(m['max_tokens'])
    const temperature = numberOrUndefined(m['temperature'])
    return {
      alias: text(m['alias']),
      provider: text(m['provider']),
      model: text(m['model']),
      ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
      ...(temperature !== undefined ? { temperature } : {}),
      enabled: typeof m['enabled'] === 'boolean' ? m['enabled'] : true,
    }
  })

  return {
    providers,
    models,
    default_model: text(raw['default_model']),
    request_timeout_ms: numberOrUndefined(raw['request_timeout_ms']) ?? 25000,
    max_retries: numberOrUndefined(raw['max_retries']) ?? 1,
  }
}
