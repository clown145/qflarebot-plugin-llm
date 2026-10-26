/**
 * 对其他插件公开的服务契约（类型）。
 *
 * 调用方在 depends 里声明 `{ llm: '*' }`，然后 `ctx.service<LLMService>('llm')`。
 * 这个文件只导出类型；外部插件不能安装本包，按 README 的声明片段结构对齐即可。
 */

export type Capability = 'tools' | 'json'

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
  content?: string
  /** assistant 消息里的工具调用 */
  tool_calls?: ToolCall[]
  /** tool 消息对应的调用 id */
  tool_call_id?: string
  /** tool 消息可标记为错误结果（Anthropic 会转成 is_error） */
  is_error?: boolean
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
  | { type: 'tool_call_delta'; index: number; id?: string; name?: string; arguments_delta?: string }
  | { type: 'done'; result: ChatResult }

export interface ModelInfo {
  alias: string
  provider: string
  model: string
  capabilities: Capability[]
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
  provider: string
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
