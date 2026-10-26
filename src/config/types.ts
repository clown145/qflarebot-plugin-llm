/** 配置与对外视图的类型。存储结构和页面提交结构都在这里，服务与页面共用。 */

import type { Capability } from '../contract.js'

export type ProtocolId = 'openai' | 'anthropic'

export interface ProviderConfig {
  /** 页面生成的稳定标识；模型别名靠它引用供应商 */
  id: string
  name: string
  protocol: ProtocolId
  base_url: string
  api_key?: string
  /** 只放非密钥头；Authorization / x-api-key 由适配器按 api_key 生成 */
  headers?: Record<string, string>
  timeout_ms?: number
  enabled: boolean
}

export interface ModelConfig {
  /** 调用方使用的别名，全局唯一 */
  alias: string
  provider: string
  model: string
  max_tokens?: number
  temperature?: number
  enabled: boolean
}

export interface StoredConfig {
  schema_version: 1
  /** 每次保存 +1，页面据此做乐观并发 */
  version: number
  providers: ProviderConfig[]
  models: ModelConfig[]
  default_model: string
  request_timeout_ms: number
  max_retries: number
  updated_at: string
}

/** 公开视图：不含 api_key，只告诉页面有没有设置 */
export interface PublicProvider extends Omit<ProviderConfig, 'api_key'> {
  api_key_set: boolean
}

export interface PublicConfig {
  schema_version: 1
  version: number
  providers: PublicProvider[]
  models: ModelConfig[]
  default_model: string
  request_timeout_ms: number
  max_retries: number
  updated_at: string
}

/** 页面提交的供应商：api_key 省略=保留、null=清除、字符串=替换 */
export interface PublicProviderInput extends Omit<ProviderConfig, 'api_key' | 'enabled'> {
  enabled?: boolean
  api_key?: string | null
  api_key_set?: boolean
}

export interface PublicConfigInput {
  providers: PublicProviderInput[]
  models: ModelConfig[]
  default_model: string
  request_timeout_ms: number
  max_retries: number
}

export interface ConfigIssue {
  level: 'error' | 'warn'
  /** 点分路径，例如 providers.0.base_url；页面按它定位 */
  path: string
  message: string
}

export interface ProtocolMeta {
  id: ProtocolId
  label: string
  capabilities: Capability[]
  default_base_url: string
  base_url_hint: string
}

export const LIMITS = {
  timeout_min: 1000,
  timeout_max: 28000,
  max_retries: 2,
  max_tokens_max: 131072,
  body_max_bytes: 256 * 1024,
} as const

export const CAPABILITIES: Record<ProtocolId, Capability[]> = {
  openai: ['tools', 'json'],
  anthropic: ['tools'],
}

export function capabilitiesOf(protocol: ProtocolId): Capability[] {
  return CAPABILITIES[protocol] ?? []
}
