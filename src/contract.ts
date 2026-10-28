/**
 * 对其他插件公开的服务契约（类型）。
 *
 * 调用方在 depends 里声明 `{ llm: '*' }`，然后 `ctx.service<LLMService>('llm')`。
 * 这个文件只导出类型；外部插件不能安装本包，按 README 的声明片段结构对齐即可。
 */

export type Capability = 'text' | 'image' | 'audio' | 'tools' | 'json' | 'reasoning'

/** 多模态内容片段。文本之外的片段只在模型声明了对应能力时才有意义 */
export type ContentPart =
  | { type: 'text'; text: string }
  /** `url` 支持 https 地址或 `data:` URI；`data` + `media_type` 用于直接给 base64 */
  | { type: 'image'; url?: string; data?: string; media_type?: string; detail?: 'auto' | 'low' | 'high' }
  /** 音频：OpenAI 兼容协议按 `input_audio` 传；Anthropic 协议不支持，会抛 unsupported */
  | { type: 'audio'; url?: string; data?: string; media_type?: string; format?: string }
  /** 文档/文件：Anthropic 走 document block；OpenAI 兼容协议不支持，会抛 unsupported */
  | { type: 'file'; url?: string; data?: string; media_type?: string; filename?: string }

/**
 * 消息内容。字符串是最常见的写法；需要图片/音频时传片段数组。
 * 片段数组里的 `text` 片段会被拼成 `ChatResult.text`，其余片段只影响请求。
 */
export type MessageContent = string | ContentPart[]

export interface ToolDefinition {
  name: string
  description?: string
  /** JSON Schema 对象，交给上游原样转换 */
  parameters: Record<string, unknown>
}

export interface ToolCall {
  id: string
  name: string
  /** 统一成 JSON 字符串：OpenAI 原样，Anthropic 的 input 对象序列化 */
  arguments: string
}

export type Role = 'system' | 'user' | 'assistant' | 'tool'

export interface ChatMessage {
  role: Role
  content?: MessageContent
  /** assistant 消息里的工具调用 */
  tool_calls?: ToolCall[]
  /** tool 消息对应的调用 id */
  tool_call_id?: string
  /** tool 消息可标记为错误结果（Anthropic 会转成 is_error） */
  is_error?: boolean
  /**
   * assistant 消息里的推理内容（DeepSeek reasoning_content / Anthropic thinking）。
   * 回传不会被读取：上游 thinking 带签名无法重建（见 README「推理内容」），
   * 该字段只作为调用方本地记录的存在，发给本服务时会被静默忽略。
   */
  reasoning?: string
}

export type ToolChoice = 'auto' | 'none' | 'required' | { name: string }

export interface ChatRequest {
  /** 模型别名；省略时用配置里的 default_model */
  model?: string
  messages: ChatMessage[]
  tools?: ToolDefinition[]
  tool_choice?: ToolChoice
  temperature?: number
  max_tokens?: number
  top_p?: number
  stop?: string | string[]
  /** 要求 JSON 对象输出；Anthropic 协议不支持，会抛 unsupported */
  json?: boolean
  /**
   * 本次调用的超时（毫秒）。不传用配置里的值；超过上限会被压到上限。
   * 一次 QQ 事件的所有插件合计只有 30 秒，工具循环请自己留余量（见 README「限制」）。
   */
  timeout_ms?: number
  signal?: AbortSignal
  /** 透传给上游的额外字段；model/messages/stream 等核心字段不会被覆盖 */
  extra_body?: Record<string, unknown>
}

export interface Usage {
  input_tokens?: number
  output_tokens?: number
  total_tokens?: number
}

export type FinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'other'

export interface ChatResult {
  text: string
  /** 推理模型的思考内容；上游没返回时不出现 */
  reasoning?: string
  tool_calls?: ToolCall[]
  finish_reason?: FinishReason
  alias: string
  /** 供应商标识（配置里的 id） */
  provider: string
  /** 上游模型名 */
  model: string
  usage?: Usage
  latency_ms: number
}

export type StreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'reasoning_delta'; text: string }
  | { type: 'tool_call_delta'; index: number; id?: string; name?: string; arguments_delta?: string }
  | { type: 'done'; result: ChatResult }

export interface ModelInfo {
  alias: string
  provider: string
  model: string
  capabilities: Capability[]
  /** 输入上下文上限（tokens），未知时不返回 */
  context_window?: number
  /** 模型输出上限（tokens），未知时不返回 */
  max_output_tokens?: number
  max_tokens?: number
  temperature?: number
}

export interface ResolvedModel extends ModelInfo {
  provider_name: string
}

export interface PingResult {
  ok: boolean
  latency_ms: number
  alias?: string
  /** 解析出供应商时才出现；配置读失败等早期错误没有 */
  provider?: string
  model?: string
  text?: string
  usage?: Usage
  error?: string
}

export interface LLMService {
  readonly contractVersion: 1
  /** 只列启用且供应商启用的别名 */
  listModels(): Promise<ModelInfo[]>
  /** 不发起请求，只解析别名；不含 key / base_url */
  resolve(alias?: string): Promise<ResolvedModel>
  chat(req: ChatRequest): Promise<ChatResult>
  stream(req: ChatRequest): AsyncIterable<StreamEvent>
  /** 管理页与健康检查用：发一条极小的请求 */
  ping(opts?: { alias?: string; provider?: string }): Promise<PingResult>
}

export type LLMErrorCode =
  | 'config'
  | 'unknown_model'
  | 'auth'
  | 'rate_limit'
  | 'timeout'
  | 'aborted'
  | 'network'
  | 'upstream'
  | 'bad_request'
  | 'bad_response'
  | 'unsupported'
