/** 配置与对外视图的类型。存储结构和页面提交结构都在这里，服务与页面共用。 */

import type { Capability } from '../contract.js'

export type ProtocolId = 'openai' | 'anthropic' | 'gemini'

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
  /**
   * 允许明文 HTTP 与内网地址（默认关）。
   *
   * 只给一种场景开：**上游只能用 IP 访问**。IP 签不出证书，自签证书 Cloudflare
   * 的 fetch 也不认，所以只能走 http；内网部署同理。
   *
   * 打开后 API Key 会明文过链路，也会被发到内网地址——这正是默认关的原因。
   * 页面上必须有明确提示，不能让人不知不觉选上。
   */
  allow_http?: boolean
}

export interface ModelConfig {
  /** 调用方使用的别名，全局唯一 */
  alias: string
  provider: string
  model: string
  /** 默认请求输出上限；和模型自身上限 max_output_tokens 不是一回事 */
  max_tokens?: number
  temperature?: number
  /**
   * 思考等级（推理深度）。不填 = 不干预，交给上游模型的默认值。
   *
   * ## 为什么是「等级」而不是「token 预算」
   *
   * 三个协议对「想多深」的表达方式完全不同，同一协议内还随模型世代变化：
   *
   * | 协议 | 字段 | 取值 |
   * | --- | --- | --- |
   * | OpenAI 兼容 | `reasoning_effort` | minimal / low / medium / high |
   * | Anthropic | `thinking.budget_tokens` | 具体 token 数（≥1024） |
   * | Gemini 2.5 | `thinkingConfig.thinkingBudget` | 具体 token 数 |
   * | Gemini 3.x | `thinkingConfig.thinkingLevel` | minimal / low / medium / high |
   *
   * 让用户在页面上填 token 数既难懂又不可移植（换模型就得重算），所以统一成
   * **四个语义等级**，由各协议适配器翻译成自己的形状。换算表见 `protocols/thinking.ts`。
   *
   * ## 为什么放在模型配置里
   *
   * 它与 `temperature` / `max_tokens` 同类：都是「这个模型的默认生成参数」，
   * 调用方不传就用这里的值。放这里之后，「快问快答模型」和「深度推理模型」
   * 可以各自配各自的等级。
   */
  reasoning_effort?: ReasoningEffort
  /** 输入上下文上限（tokens） */
  context_window?: number
  /** 模型输出上限（tokens） */
  max_output_tokens?: number
  /** 模型能力；不填时按协议给默认值 */
  capabilities?: Capability[]
  enabled: boolean
}

/**
 * 思考等级。语义对齐 OpenAI 的 `reasoning_effort`，作为跨协议的公共词汇。
 *
 * `minimal` 在 Anthropic / Gemini 上没有直接对应物，会退化成「明确关闭思考」
 * 或最小预算——见 `protocols/thinking.ts` 的映射表。
 */
export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high'

/** 面板显示顺序：从浅到深 */
export const REASONING_EFFORTS: ReasoningEffort[] = ['minimal', 'low', 'medium', 'high']

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
  /** 配置里能填的超时上限（向后兼容，老配置里 25000/28000 仍然合法） */
  timeout_max: 28000,
  /**
   * 单次调用实际允许的上限。一次 QQ 事件里**所有插件合计**只有 30 秒（平台硬限），
   * 框架 25 秒就告警；28 秒会直接把事件预算吃光，调用方在工具循环里连第二次都调不了。
   * 所以配置允许填到 28000，但真正发请求时压到这个值，剩下的留给调用方收尾。
   */
  call_timeout_max: 20000,
  max_retries: 2,
  max_tokens_max: 131072,
  /** 请求体上限（按字节算，不是字符数） */
  body_max_bytes: 256 * 1024,
  /** 非流式响应体上限；LLM 的非流式响应极少超过 2 MB，再大基本是上游故障 */
  response_max_bytes: 2 * 1024 * 1024,
  /** 流式累计文本 / 工具参数上限 */
  stream_max_bytes: 8 * 1024 * 1024,
  /** 管理页拉上游模型列表的上限 */
  models_response_max_bytes: 2 * 1024 * 1024,
} as const

export const CAPABILITIES: Record<ProtocolId, Capability[]> = {
  openai: ['text', 'tools', 'json'],
  anthropic: ['text', 'tools'],
  gemini: ['text', 'tools', 'json'],
}

/** 面板和校验共用；顺序也是面板上的显示顺序 */
export const CAPABILITY_VALUES: Capability[] = ['text', 'image', 'audio', 'tools', 'json', 'reasoning']

export function capabilitiesOf(protocol: ProtocolId): Capability[] {
  return CAPABILITIES[protocol] ?? ['text']
}
