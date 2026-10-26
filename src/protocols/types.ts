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
  toolCalls?: ToolCall[]
  finishReason?: FinishReason
  usage?: Usage
}

export type ParsedStreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_call_delta'; index: number; id?: string; name?: string; argumentsDelta?: string }
  | { type: 'usage'; usage: Usage }
  | { type: 'finish'; reason?: FinishReason }

export interface ProtocolAdapter {
  readonly id: ProtocolId
  readonly label: string
  readonly capabilities: Capability[]
  readonly defaultBaseUrl: string
  readonly baseUrlHint: string
  buildChat(target: Target, request: ChatRequest, stream: boolean): BuiltRequest
  parseResponse(json: unknown): ParsedResponse
  parseStream(body: ReadableStream<Uint8Array>): AsyncGenerator<ParsedStreamEvent>
  buildListModels(provider: ProviderConfig): BuiltRequest
  parseListModels(json: unknown): string[]
}
