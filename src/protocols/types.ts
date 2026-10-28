import type { Capability, ChatRequest, FinishReason, ToolCall, Usage } from '../contract.js'
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
  toolCalls?: ToolCall[]
  finishReason?: FinishReason
  usage?: Usage
}

export type ParsedStreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'reasoning_delta'; text: string }
  | { type: 'tool_call_delta'; index: number; id?: string; name?: string; argumentsDelta?: string }
  | { type: 'usage'; usage: Usage }
  | { type: 'finish'; reason?: FinishReason }

/** 解析流式数据时用得上的上游上下文；只有需要脱敏/映射错误的适配器才会用 */
export interface StreamContext {
  apiKey?: string
  /** 自定义请求头里的凭据（如 Azure 的 api-key）；流内 error 的 message 脱敏要与非流式路径同标准 */
  secrets?: ReadonlyArray<string>
}

export interface ProtocolAdapter {
  readonly id: ProtocolId
  readonly label: string
  readonly capabilities: Capability[]
  readonly defaultBaseUrl: string
  readonly baseUrlHint: string
  buildChat(target: Target, request: ChatRequest, stream: boolean): BuiltRequest
  parseResponse(json: unknown): ParsedResponse
  /** `ctx` 可选，用于给流内 error 事件脱敏；不传时退化为不做精确值替换 */
  parseStream(body: ReadableStream<Uint8Array>, ctx?: StreamContext): AsyncGenerator<ParsedStreamEvent>
  buildListModels(provider: ProviderConfig): BuiltRequest
  parseListModels(json: unknown): string[]
}
