import type { PingResult } from './contract.js'
import type { ConfigIssue, ProtocolMeta, PublicConfig, PublicConfigInput, PublicProviderInput } from './config/types.js'

export interface MetaResponse {
  ok: true
  plugin: { name: string; version: string }
  service: { name: 'llm'; contractVersion: 1 }
  protocols: ProtocolMeta[]
  limits: {
    timeout_min: number
    timeout_max: number
    max_retries: number
    max_tokens_max: number
    body_max_bytes: number
  }
}

export interface ConfigGetResponse {
  ok: true
  config: PublicConfig
  issues: ConfigIssue[]
  corrupt: boolean
}

export interface ConfigPutRequest {
  version: number
  config: PublicConfigInput
}

export interface ConfigPutResponse {
  ok: true
  config: PublicConfig
  issues: ConfigIssue[]
}

export interface TestRequest {
  target?: { alias?: string; provider?: string }
  draft?: PublicConfigInput
}

export interface TestResponse {
  ok: true
  result: PingResult
}

export interface ModelsRequest {
  provider: PublicProviderInput
}

export interface ModelsResponse {
  ok: true
  models: string[]
}

export interface ApiError {
  ok: false
  error: string
  code?: string
  errors?: ConfigIssue[]
  config?: PublicConfig
}
