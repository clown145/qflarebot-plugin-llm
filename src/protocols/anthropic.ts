import type { ChatMessage, ChatRequest, ToolCall, ToolChoice } from '../contract.js'
import type { ProviderConfig } from '../config/types.js'
import { LLMError } from '../errors.js'
import { asArray, asNumber, asString, isRecord } from '../json.js'
import { readSSE } from '../sse.js'
import type { BuiltRequest, ParsedResponse, ParsedStreamEvent, ProtocolAdapter, Target } from './types.js'
import {
  anthropicFinish,
  anthropicUsage,
  endpointUrl,
  modelsUrl,
} from './shared.js'

const VERSION = '2023-06-01'

interface TextBlock {
  type: 'text'
  text: string
}

interface ToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}

interface ToolResultBlock {
  type: 'tool_result'
  tool_use_id: string
  content: string
  is_error?: boolean
}

type Block = TextBlock | ToolUseBlock | ToolResultBlock

interface WireMessage {
  role: 'user' | 'assistant'
  content: Block[]
}

function toolInput(argumentsText: string): Record<string, unknown> {
  if (!argumentsText.trim()) return {}
  let value: unknown
  try {
    value = JSON.parse(argumentsText)
  } catch {
    throw new LLMError('bad_request', 'assistant 的工具调用参数不是合法 JSON')
  }
  if (!isRecord(value)) throw new LLMError('bad_request', 'assistant 的工具调用参数必须是 JSON 对象')
  return value
}

function mapMessages(messages: ChatMessage[]): { system: string; messages: WireMessage[] } {
  const system: string[] = []
  const out: WireMessage[] = []

  const push = (role: WireMessage['role'], blocks: Block[]) => {
    if (blocks.length === 0) return
    const last = out[out.length - 1]
    if (last?.role === role) last.content.push(...blocks)
    else out.push({ role, content: blocks })
  }

  for (const message of messages) {
    if (message.role === 'system') {
      if (message.content?.trim()) system.push(message.content.trim())
      continue
    }
    if (message.role === 'user') {
      push('user', [{ type: 'text', text: message.content ?? '' }])
      continue
    }
    if (message.role === 'assistant') {
      const blocks: Block[] = []
      if (message.content) blocks.push({ type: 'text', text: message.content })
      for (const call of message.tool_calls ?? []) {
        blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: toolInput(call.arguments) })
      }
      if (blocks.length === 0) throw new LLMError('bad_request', 'assistant 消息既没有内容也没有工具调用')
      push('assistant', blocks)
      continue
    }
    if (!message.tool_call_id) throw new LLMError('bad_request', 'tool 消息缺少 tool_call_id')
    push('user', [{
      type: 'tool_result',
      tool_use_id: message.tool_call_id,
      content: message.content ?? '',
      ...(message.is_error ? { is_error: true } : {}),
    }])
  }

  return { system: system.join('\n\n'), messages: out }
}

function mapToolChoice(choice: ToolChoice): unknown {
  if (choice === 'auto') return { type: 'auto' }
  if (choice === 'none') return { type: 'none' }
  if (choice === 'required') return { type: 'any' }
  return { type: 'tool', name: choice.name }
}

function buildChat(target: Target, request: ChatRequest, stream: boolean): BuiltRequest {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: stream ? 'text/event-stream' : 'application/json',
    'anthropic-version': VERSION,
  }
  for (const [key, value] of Object.entries(target.provider.headers ?? {})) headers[key] = value
  if (target.provider.api_key) headers['x-api-key'] = target.provider.api_key

  const mapped = mapMessages(request.messages)
  const body: Record<string, unknown> = {
    ...(request.extra_body ?? {}),
    model: target.model.model,
    max_tokens: request.max_tokens ?? 1024,
    messages: mapped.messages,
  }
  if (mapped.system) body['system'] = mapped.system
  if (request.temperature !== undefined) body['temperature'] = request.temperature
  if (request.top_p !== undefined) body['top_p'] = request.top_p
  if (request.stop !== undefined) {
    body['stop_sequences'] = Array.isArray(request.stop) ? request.stop : [request.stop]
  }
  if (request.tools?.length) {
    body['tools'] = request.tools.map((tool) => ({
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      input_schema: tool.parameters,
    }))
    if (request.tool_choice) body['tool_choice'] = mapToolChoice(request.tool_choice)
  }
  if (stream) body['stream'] = true

  return {
    url: endpointUrl(target.provider.base_url, '/messages'),
    init: { method: 'POST', headers, body: JSON.stringify(body) },
  }
}

function parseResponse(json: unknown): ParsedResponse {
  if (!isRecord(json)) throw new Error('上游返回的不是 JSON 对象')
  const content = asArray(json['content'])
  let text = ''
  const toolCalls: ToolCall[] = []
  for (const block of content) {
    if (!isRecord(block)) continue
    if (block['type'] === 'text') {
      text += asString(block['text'])
    } else if (block['type'] === 'tool_use') {
      const name = asString(block['name'])
      if (!name) continue
      toolCalls.push({
        id: asString(block['id']) || `call_${toolCalls.length}`,
        name,
        arguments: JSON.stringify(isRecord(block['input']) ? block['input'] : {}),
      })
    }
  }
  const finishReason = anthropicFinish(json['stop_reason'])
  const usage = anthropicUsage(json['usage'])
  return {
    text,
    ...(toolCalls.length ? { toolCalls } : {}),
    ...(finishReason ? { finishReason } : {}),
    ...(usage ? { usage } : {}),
  }
}

async function* parseStream(body: ReadableStream<Uint8Array>): AsyncGenerator<ParsedStreamEvent> {
  for await (const message of readSSE(body)) {
    let json: unknown
    try {
      json = JSON.parse(message.data)
    } catch {
      throw new Error('上游流式数据不是合法 JSON')
    }
    if (!isRecord(json)) continue
    const event = message.event ?? asString(json['type'])

    if (event === 'message_start') {
      const start = isRecord(json['message']) ? json['message'] : {}
      const next = anthropicUsage(start['usage'])
      if (next) yield { type: 'usage', usage: next }
      continue
    }

    if (event === 'content_block_start') {
      const block = isRecord(json['content_block']) ? json['content_block'] : {}
      if (block['type'] === 'tool_use') {
        const index = asNumber(json['index']) ?? 0
        const id = asString(block['id'])
        const name = asString(block['name'])
        yield { type: 'tool_call_delta', index, ...(id ? { id } : {}), ...(name ? { name } : {}) }
      }
      continue
    }

    if (event === 'content_block_delta') {
      const delta = isRecord(json['delta']) ? json['delta'] : {}
      const index = asNumber(json['index']) ?? 0
      if (delta['type'] === 'text_delta') {
        const text = asString(delta['text'])
        if (text) yield { type: 'text_delta', text }
      } else if (delta['type'] === 'input_json_delta') {
        const partial = asString(delta['partial_json'])
        if (partial) yield { type: 'tool_call_delta', index, argumentsDelta: partial }
      }
      continue
    }

    if (event === 'message_delta') {
      const delta = isRecord(json['delta']) ? json['delta'] : {}
      const reason = anthropicFinish(delta['stop_reason'])
      if (reason) yield { type: 'finish', reason }
      const next = anthropicUsage(json['usage'])
      if (next) yield { type: 'usage', usage: next }
      continue
    }

    if (event === 'message_stop') return
    if (event === 'error') {
      const error = isRecord(json['error']) ? json['error'] : {}
      throw new Error(asString(error['message']) || '上游流式返回错误')
    }
  }
}

function buildListModels(provider: ProviderConfig): BuiltRequest {
  const headers: Record<string, string> = {
    accept: 'application/json',
    'anthropic-version': VERSION,
  }
  for (const [key, value] of Object.entries(provider.headers ?? {})) headers[key] = value
  if (provider.api_key) headers['x-api-key'] = provider.api_key
  return { url: modelsUrl(provider.base_url), init: { method: 'GET', headers } }
}

function parseListModels(json: unknown): string[] {
  const list = isRecord(json) ? asArray(json['data']) : asArray(json)
  const out = new Set<string>()
  for (const item of list) {
    const id = typeof item === 'string' ? item : isRecord(item) ? asString(item['id']) : ''
    if (id) out.add(id)
  }
  return [...out]
}

export const anthropic: ProtocolAdapter = {
  id: 'anthropic',
  label: 'Anthropic Messages',
  capabilities: ['tools'],
  defaultBaseUrl: 'https://api.anthropic.com/v1',
  baseUrlHint: '以 /v1 结尾，例如 https://api.anthropic.com/v1',
  buildChat,
  parseResponse,
  parseStream,
  buildListModels,
  parseListModels,
}
