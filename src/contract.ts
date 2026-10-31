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

/**
 * Gemini 思考签名（`thoughtSignature`）。
 *
 * 签名挂在 part 上，Gemini 2.5/3.x 的思考模型对 functionCall part 的签名做**严格校验**：
 * 多轮工具调用时必须把带签名的 part 原样回传，缺签名会直接 `400 INVALID_ARGUMENT`。
 * 并行工具调用时上游只在**第一个** functionCall part 上给签名。
 *
 * 用数组 + part 定位表达，而不是挂在单条消息上：一次响应里可能有多个文本 part
 * 各自带不同签名，每个 functionCall part 也可以各自带签名。
 * 形状与 serverless-agent 的 `GeminiThoughtSignature` 一致（字段名按本插件的 snake_case 约定）。
 */
export interface ThoughtSignature {
  /**
   * 签名所属 part 在**回传时重建的 parts 数组**里的下标（0-based）。
   *
   * 重建顺序固定为「先 content 里的文本 part，后 tool_calls 的 functionCall part」。
   * 回传时优先按 `tool_call_id` / `tool_name` 精确匹配，匹配不到才退回这个下标。
   */
  part_index: number
  /** part 类型：文本或工具调用 */
  part_kind: 'text' | 'function_call'
  /** 签名原文，原样回传，不要改动 */
  signature: string
  /** `part_kind = 'function_call'` 时：该调用在 `tool_calls` 里的下标 */
  tool_call_index?: number
  /** `part_kind = 'function_call'` 时：对应的 tool call id，回传时优先按它匹配 */
  tool_call_id?: string
  /** `part_kind = 'function_call'` 时：对应的工具名，id 匹配不到时按名字兜底 */
  tool_name?: string
}

/**
 * Anthropic 思考签名（`thinking` / `redacted_thinking` block）。
 *
 * Anthropic 在多轮工具调用时要求**把上一轮的思考 block 原样回传**，而且必须排在
 * assistant `content` 的最前面；缺了直接 400：
 *
 * ```
 * Expected `thinking` or `redacted_thinking`, but found `tool_use`
 * ```
 *
 * `reasoning` 只是把思考正文拼成的一段纯文本，装不下签名，所以另开这个数组：
 * 一条 `thinking` block = 正文 + 签名，两者必须成对回传；`redacted_thinking`
 * 是上游加密后的思考内容，插件只能原样保留、无法解读。
 *
 * 形状与 `ThoughtSignature` 同构（数组 + part 定位），其他协议不产生也不需要。
 */
export interface ReasoningSignature {
  /**
   * 该 block 在**回传时重建的 assistant `content` 数组**里的下标（0-based）。
   *
   * 重建顺序固定为「先推理 block（按本下标升序）、后正文 block、后 `tool_use` block」，
   * 与 Anthropic 对 thinking block 必须打头的要求一致。
   */
  part_index: number
  /** block 类型：`thinking`（正文 + 签名）/ `redacted_thinking`（加密数据） */
  block_type: 'thinking' | 'redacted_thinking'
  /** `block_type = 'thinking'` 时的思考正文；回传时必须与签名一起原样带上 */
  thinking?: string
  /** `block_type = 'thinking'` 时的签名原文，不要改动 */
  signature?: string
  /** `block_type = 'redacted_thinking'` 时的加密数据原文，不要改动 */
  data?: string
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
   * 只是一段展示用的纯文本，不会回传到上游；Anthropic 的思考 block 回传走
   * `reasoning_signatures`（签名与正文必须成对，纯文本装不下签名）。
   */
  reasoning?: string
  /**
   * Gemini 思考签名集合（文本 part 与 functionCall part 都在这里）。
   *
   * 调用方原样保存 `ChatResult.thought_signatures`，下一轮塞回 assistant 消息即可；
   * 其他协议不产生也不需要这个字段。
   */
  thought_signatures?: ThoughtSignature[]
  /**
   * Anthropic 思考签名集合。调用方原样保存 `ChatResult.reasoning_signatures`，
   * 下一轮塞回含 `tool_use` 的 assistant 消息，否则多轮工具调用必 400。
   * 其他协议不产生也不需要这个字段。
   */
  reasoning_signatures?: ReasoningSignature[]
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
  /**
   * 思考等级（推理深度）。不传则用模型配置里的 `reasoning_effort`；
   * 两边都没有就不干预，交给上游默认值。
   *
   * 这是**跨协议的公共词汇**，各协议翻译成自己的形状：
   * - OpenAI 兼容 → `reasoning_effort`
   * - Anthropic → `thinking.budget_tokens`
   * - Gemini 2.5 → `thinkingConfig.thinkingBudget`；3.x → `thinkingLevel`
   *
   * 注意：不是所有模型都支持。不支持的上游有的静默忽略、有的报错，
   * 所以只在显式配置时才发送（见 protocols/thinking.ts）。
   */
  reasoning_effort?: 'minimal' | 'low' | 'medium' | 'high'
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
  /**
   * Gemini 思考签名集合；需要调用方保存并在下一轮作为
   * `ChatMessage.thought_signatures` 原样回传。
   */
  thought_signatures?: ThoughtSignature[]
  /**
   * Anthropic 思考签名集合；需要调用方保存并在下一轮作为
   * `ChatMessage.reasoning_signatures` 原样回传（仅在开启思考时产生）。
   */
  reasoning_signatures?: ReasoningSignature[]
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
  /** Gemini 思考签名；调用方收集后在下一轮作为 `thought_signatures` 回传 */
  | ({ type: 'thought_signature' } & ThoughtSignature)
  /** Anthropic 思考签名；调用方收集后在下一轮作为 `reasoning_signatures` 回传 */
  | ({ type: 'reasoning_signature' } & ReasoningSignature)
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
  /** 该模型配置的默认思考等级；没配时不返回 */
  reasoning_effort?: 'minimal' | 'low' | 'medium' | 'high'
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
