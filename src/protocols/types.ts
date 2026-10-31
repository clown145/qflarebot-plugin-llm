import type { Capability, ChatRequest, FinishReason, ReasoningSignature, ThoughtSignature, ToolCall, Usage } from '../contract.js'
import type { ModelConfig, ProtocolId, ProviderConfig } from '../config/types.js'

export interface Target {
  provider: ProviderConfig
  model: ModelConfig
}

export interface BuiltRequest {
  url: string
  init: RequestInit
}

export interface ParsedResponse {
  text: string
  /** 推理模型的思考内容（DeepSeek reasoning_content / Anthropic thinking） */
  reasoning?: string
  /** Gemini 思考签名集合（其他协议不产生） */
  thoughtSignatures?: ThoughtSignature[]
  /** Anthropic 思考签名集合（其他协议不产生） */
  reasoningSignatures?: ReasoningSignature[]
  toolCalls?: ToolCall[]
  finishReason?: FinishReason
  usage?: Usage
}

export type ParsedStreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'reasoning_delta'; text: string }
  | { type: 'tool_call_delta'; index: number; id?: string; name?: string; argumentsDelta?: string }
  /** Gemini 思考签名（文本 part 或 functionCall part）；可能在任意时刻到达 */
  | ({ type: 'thought_signature' } & ThoughtSignature)
  /**
   * Anthropic 思考签名。
   *
   * 在 `content_block_stop` 时**一次性**给出（`thinking_delta` 是正文增量，
   * `signature_delta` 才是签名）；`redacted_thinking` 在 block 开始时就能给出。
   */
  | ({ type: 'reasoning_signature' } & ReasoningSignature)
  | { type: 'usage'; usage: Usage }
  | { type: 'finish'; reason?: FinishReason }

/** 解析流式数据时用得上的上游上下文；只有需要脱敏/映射错误的适配器才会用 */
export interface StreamContext {
  apiKey?: string
  /** 自定义请求头里的凭据（如 Azure 的 api-key）；流内 error 的 message 脱敏要与非流式路径同标准 */
  secrets?: ReadonlyArray<string>
}

/**
 * 更宽的自定义头脱敏集合：除请求头的**值**之外，还包含 base_url 的查询串/片段。
 *
 * 有些网关把凭据放在地址里（`?key=…`），过去 `fetchError` 只按 apiKey + 头值替换，
 * 自建网关那种「任意格式的 key」会原样出现在错误消息与日志里。
 */
export interface BuildHooks {
  /** 适配器需要告警时（例如 tool_choice 因上游约束被降级）回调到装配层 */
  warn?: (message: string, data?: unknown) => void
}

export interface ProtocolAdapter {
  readonly id: ProtocolId
  readonly label: string
  readonly capabilities: Capability[]
  readonly defaultBaseUrl: string
  readonly baseUrlHint: string
  buildChat(target: Target, request: ChatRequest, stream: boolean, hooks?: BuildHooks): BuiltRequest
  parseResponse(json: unknown): ParsedResponse
  /** `ctx` 可选，用于给流内 error 事件脱敏；不传时退化为不做精确值替换 */
  parseStream(body: ReadableStream<Uint8Array>, ctx?: StreamContext): AsyncGenerator<ParsedStreamEvent>
  buildListModels(provider: ProviderConfig): BuiltRequest
  parseListModels(json: unknown): string[]
}
