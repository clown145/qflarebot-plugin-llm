import type { Capability } from '../src/contract.js'
import type { ModelConfig, ProtocolId, PublicConfig, PublicConfigInput, PublicProvider, PublicProviderInput, ReasoningEffort } from '../src/config/types.js'
import { CAPABILITY_VALUES, REASONING_EFFORTS } from '../src/config/types.js'
import { canReuseSecret } from '../src/config/secrets.js'
import { DEFAULT_TIMEOUT_MS } from '../src/config/defaults.js'

export type Tab = 'overview' | 'service' | 'settings' | 'usage'

export interface ProviderDraft extends Omit<PublicProvider, 'api_key_set'> {
  api_key?: string
  api_key_set: boolean
  /** 页面点了“清除”，保存时发 null */
  clear_key?: boolean
}

/** 导出文件不包含密钥状态，也不包含容易被误当成密钥的请求头 */
export type ExportProvider = Omit<PublicProvider, 'api_key_set'> & {
  /** 导出时被剔除的请求头名（只记名字，不记值） */
  headers_omitted?: string[]
}

export interface ExportConfig {
  schema_version: 1
  version: number
  providers: ExportProvider[]
  models: ModelConfig[]
  default_model: string
  request_timeout_ms: number
  max_retries: number
  updated_at: string
}

/**
 * 导出白名单：只有这些「展示 / 来源标注」类请求头会写进导出文件。
 *
 * 以前是 denylist（只排除 Authorization 等已知敏感头），结果是 `x-hf-token`、
 * `X-Custom-Auth` 这类第三方鉴权头会原样导出，等于把密钥写进用户随手分享的文件。
 * 改成白名单后，任何新出现的鉴权头默认都不会泄漏；用户自定义的头会被剔除，
 * 但名字记在 `headers_omitted` 里，导入时可以提示需要重填。
 */
const EXPORTABLE_HEADERS = new Set([
  'x-title',
  'http-referer',
  'x-referer',
  'user-agent',
  'accept-language',
  'openai-beta',
])

interface ExportedHeaders {
  headers?: Record<string, string>
  headers_omitted?: string[]
}

function exportableHeaders(headers: Record<string, string> | undefined): ExportedHeaders {
  if (!headers) return {}
  const out: Record<string, string> = {}
  const omitted: string[] = []
  for (const [key, value] of Object.entries(headers)) {
    if (EXPORTABLE_HEADERS.has(key.toLowerCase())) out[key] = value
    else omitted.push(key)
  }
  return {
    ...(Object.keys(out).length ? { headers: out } : {}),
    ...(omitted.length ? { headers_omitted: omitted } : {}),
  }
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

export function uniqueAlias(models: ModelConfig[], base: string): string {
  const used = new Set(models.map((item) => item.alias))
  if (!used.has(base)) return base
  for (let i = 2; ; i += 1) {
    const next = `${base}-${i}`
    if (!used.has(next)) return next
  }
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
export function toExport(config: AppConfigDraft, version: number, updatedAt: string): ExportConfig {
  return {
    schema_version: 1,
    version,
    providers: config.providers.map((provider) => {
      const { api_key, api_key_set, clear_key, headers, ...rest } = provider
      void api_key
      void api_key_set
      void clear_key
      return { ...rest, ...exportableHeaders(headers) }
    }),
    models: clone(config.models),
    default_model: config.default_model,
    request_timeout_ms: config.request_timeout_ms,
    max_retries: config.max_retries,
    updated_at: updatedAt,
  }
}

/**
 * 导入文件不携带可信的 Key 状态：按 `(id + protocol + 规范化 base_url)` 三元组与本机配置对齐。
 *
 * 只按 id 对齐会让「改地址不改 Key」成立：导入一个把 base_url 指到第三方的配置，
 * 本机已存的 Key 会被服务端按 id 沿用并发到那个地址。所以三者必须都一致才继承
 * `api_key_set`；不一致时标记 `clear_key`，让服务端丢掉旧密钥。
 *
 * 返回被丢弃的 provider id 列表，供页面提示「这些供应商地址/协议变了，API Key 需要重新填写」。
 */
export function reconcileKeyState(
  draft: AppConfigDraft,
  local: AppConfigDraft | null,
): { draft: AppConfigDraft; dropped: string[] } {
  const dropped: string[] = []
  const localProviders = local?.providers ?? []
  for (const provider of draft.providers) {
    if (provider.api_key?.trim()) {
      // 文件里手写了 Key，直接用
      provider.api_key_set = true
      provider.clear_key = false
      continue
    }
    const existing = localProviders.find((item) => item.id === provider.id)
    if (existing?.api_key_set && canReuseSecret(provider, existing)) {
      provider.api_key_set = true
      provider.clear_key = false
      continue
    }
    provider.api_key_set = false
    // 本机按 id 存着 Key 但地址/协议变了：必须显式清掉，否则服务端会沿用旧 Key
    provider.clear_key = Boolean(existing?.api_key_set)
    if (existing?.api_key_set) dropped.push(provider.id)
  }
  return { draft, dropped }
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

function capabilitiesOf(value: unknown): Capability[] | undefined {
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

/** 思考等级：只接受四个合法值；其它（老文件里的脏值）丢弃，不静默变成一个不存在的等级 */
function effortOf(value: unknown): ReasoningEffort | undefined {
  if (typeof value !== 'string') return undefined
  return (REASONING_EFFORTS as string[]).includes(value) ? (value as ReasoningEffort) : undefined
}

export function normalizeDraft(value: unknown): AppConfigDraft {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('配置文件必须是 JSON 对象')
  const raw = value as Record<string, unknown>
  const providersRaw = Array.isArray(raw['providers']) ? raw['providers'] : []
  const modelsRaw = Array.isArray(raw['models']) ? raw['models'] : []

  const providers: ProviderDraft[] = providersRaw.map((item, index) => {
    const p = item && typeof item === 'object' ? (item as Record<string, unknown>) : {}
    const apiKey = text(p['api_key'])
    const rawProtocol = p['protocol']
    if (rawProtocol !== undefined && rawProtocol !== 'openai' && rawProtocol !== 'anthropic' && rawProtocol !== 'gemini') {
      throw new Error(`第 ${index + 1} 个供应商的协议不支持：${String(rawProtocol)}`)
    }
    const protocol: ProtocolId = rawProtocol === 'anthropic' || rawProtocol === 'gemini'
      ? (rawProtocol as ProtocolId)
      : 'openai'
    const timeout = numberOrUndefined(p['timeout_ms'])
    const headers = headersOf(p['headers'])
    return {
      id: text(p['id']) || `provider-${index + 1}`,
      name: text(p['name']) || `供应商 ${index + 1}`,
      protocol,
      base_url: text(p['base_url']),
      ...(apiKey ? { api_key: apiKey } : {}),
      // 文件里的 api_key_set 可能来自另一台机器；导入后由 reconcileKeyState 按本机状态重算
      api_key_set: Boolean(apiKey),
      clear_key: false,
      ...(headers ? { headers } : {}),
      ...(timeout !== undefined ? { timeout_ms: timeout } : {}),
      enabled: typeof p['enabled'] === 'boolean' ? p['enabled'] : true,
      // **allow_http 必须一起导入**，否则「导出 → 导入」后内网/明文 HTTP 供应商
      // 会被服务端按默认（关）拦成 400，用户会以为配置文件坏了。
      // toExport 一直在导出它，只是导入端过去没接。
      ...(p['allow_http'] === true ? { allow_http: true } : {}),
    }
  })

  const models: ModelConfig[] = modelsRaw.map((item) => {
    const m = item && typeof item === 'object' ? (item as Record<string, unknown>) : {}
    const maxTokens = numberOrUndefined(m['max_tokens'])
    const temperature = numberOrUndefined(m['temperature'])
    const contextWindow = numberOrUndefined(m['context_window'])
    const maxOutput = numberOrUndefined(m['max_output_tokens'])
    const caps = capabilitiesOf(m['capabilities'])
    const effort = effortOf(m['reasoning_effort'])
    return {
      alias: text(m['alias']),
      provider: text(m['provider']),
      model: text(m['model']),
      ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
      ...(temperature !== undefined ? { temperature } : {}),
      ...(contextWindow !== undefined ? { context_window: contextWindow } : {}),
      ...(maxOutput !== undefined ? { max_output_tokens: maxOutput } : {}),
      ...(caps ? { capabilities: caps } : {}),
      // **reasoning_effort 同属模型的默认请求参数**：漏掉它会让「导出 → 导入」
      // 静默丢掉思考等级（用户以为迁过去了，实际回退成「不干预」）。
      ...(effort ? { reasoning_effort: effort } : {}),
      enabled: typeof m['enabled'] === 'boolean' ? m['enabled'] : true,
    }
  })

  return {
    providers,
    models,
    default_model: text(raw['default_model']),
    request_timeout_ms: numberOrUndefined(raw['request_timeout_ms']) ?? DEFAULT_TIMEOUT_MS,
    max_retries: numberOrUndefined(raw['max_retries']) ?? 1,
  }
}
