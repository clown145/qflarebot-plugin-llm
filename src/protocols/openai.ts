import type { ChatMessage, ChatRequest, ToolCall, ToolDefinition, ToolChoice } from '../contract.js'
import type { ProviderConfig } from '../config/types.js'
import { asArray, asNumber, asString, isRecord } from '../json.js'
import { readSSE } from '../sse.js'
import type { BuiltRequest, ParsedResponse, ParsedStreamEvent, ProtocolAdapter, Target } from './types.js'
import {
  endpointUrl,
  modelsUrl,
  openAIFinish,
  openAIUsage,
} from './shared.js'

function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => (isRecord(part) && part['type'] === 'text' ? asString(part['text']) : ''))
    .join('')
}

function mapToolCalls(raw: unknown): ToolCall[] {
  return asArray(raw).flatMap((item) => {
    if (!isRecord(item)) return []
    const fn = isRecord(item['function']) ? item['function'] : {}
    const name = asString(fn['name'])
    if (!name) return []
    const index = asNumber(item['index'])
    return [{
      id: asString(item['id']) || `call_${index ?? 0}`,
      name,
      arguments: asString(fn['arguments']) || '{}',
    }]
  })
}

function mapMessages(messages: ChatMessage[]): Record<string, unknown>[] {
  return messages.map((message) => {
    if (message.role === 'assistant') {
      const toolCalls = message.tool_calls ?? []
      return {
        role: 'assistant',
        content: message.content ?? (toolCalls.length ? null : ''),
        ...(toolCalls.length
          ? {
              tool_calls: toolCalls.map((call) => ({
                id: call.id,
                type: 'function',
                function: { name: call.name, arguments: call.arguments },
              })),
            }
          : {}),
      }
    }
    if (message.role === 'tool') {
      return {
        role: 'tool',
        tool_call_id: message.tool_call_id ?? '',
        content: message.content ?? '',
      }
    }
    return { role: message.role, content: message.content ?? '' }
  })
}

function mapTools(tools: ToolDefinition[]): Record<string, unknown>[] {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description ?? '',
      parameters: tool.parameters,
    },
  }))
}

function mapToolChoice(choice: ToolChoice): unknown {
  if (choice === 'auto' || choice === 'none' || choice === 'required') return choice
  return { type: 'function', function: { name: choice.name } }
}

function buildChat(target: Target, request: ChatRequest, stream: boolean): BuiltRequest {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: stream ? 'text/event-stream' : 'application/json',
  }
  for (const [key, value] of Object.entries(target.provider.headers ?? {})) headers[key] = value
  if (target.provider.api_key) headers['authorization'] = `Bearer ${target.provider.api_key}`

  const body: Record<string, unknown> = {
    ...(request.extra_body ?? {}),
    model: target.model.model,
    messages: mapMessages(request.messages),
    stream,
  }
  if (request.temperature !== undefined) body['temperature'] = request.temperature
  if (request.max_tokens !== undefined) body['max_tokens'] = request.max_tokens
  if (request.top_p !== undefined) body['top_p'] = request.top_p
  if (request.stop !== undefined) body['stop'] = request.stop
  if (request.json) body['response_format'] = { type: 'json_object' }
  if (request.tools?.length) {
    body['tools'] = mapTools(request.tools)
    if (request.tool_choice) body['tool_choice'] = mapToolChoice(request.tool_choice)
  }

  return {
    url: endpointUrl(target.provider.base_url, '/chat/completions'),
    init: { method: 'POST', headers, body: JSON.stringify(body) },
  }
}

function parseResponse(json: unknown): ParsedResponse {
  if (!isRecord(json)) throw new Error('上游返回的不是 JSON 对象')
  const choices = asArray(json['choices'])
  const choice = isRecord(choices[0]) ? choices[0] : null
  if (!choice) throw new Error('上游没有返回 choices')
  const message = isRecord(choice['message']) ? choice['message'] : {}
  const text = contentText(message['content'])
  const toolCalls = mapToolCalls(message['tool_calls'])
  const finishReason = openAIFinish(choice['finish_reason'])
  const usage = openAIUsage(json['usage'])
  return {
    text,
    ...(toolCalls.length ? { toolCalls } : {}),
    ...(finishReason ? { finishReason } : {}),
    ...(usage ? { usage } : {}),
  }
}

async function* parseStream(body: ReadableStream<Uint8Array>): AsyncGenerator<ParsedStreamEvent> {
  for await (const message of readSSE(body)) {
    if (message.data === '[DONE]') return
    let json: unknown
    try {
      json = JSON.parse(message.data)
    } catch {
      throw new Error('上游流式数据不是合法 JSON')
    }
    if (!isRecord(json)) continue

    const usage = openAIUsage(json['usage'])
    if (usage) yield { type: 'usage', usage }

    const choices = asArray(json['choices'])
    for (const raw of choices) {
      if (!isRecord(raw)) continue
      const delta = isRecord(raw['delta']) ? raw['delta'] : {}

      const text = contentText(delta['content'])
      if (text) yield { type: 'text_delta', text }

      for (const item of asArray(delta['tool_calls'])) {
        if (!isRecord(item)) continue
        const fn = isRecord(item['function']) ? item['function'] : {}
        const index = asNumber(item['index']) ?? 0
        const id = asString(item['id'])
        const name = asString(fn['name'])
        const args = asString(fn['arguments'])
        yield {
          type: 'tool_call_delta',
          index,
          ...(id ? { id } : {}),
          ...(name ? { name } : {}),
          ...(args ? { argumentsDelta: args } : {}),
        }
      }

      const reason = openAIFinish(raw['finish_reason'])
      if (reason) yield { type: 'finish', reason }
    }
  }
}

function buildListModels(provider: ProviderConfig): BuiltRequest {
  const headers: Record<string, string> = { accept: 'application/json' }
  for (const [key, value] of Object.entries(provider.headers ?? {})) headers[key] = value
  if (provider.api_key) headers['authorization'] = `Bearer ${provider.api_key}`
  return { url: modelsUrl(provider.base_url), init: { method: 'GET', headers } }
}

function parseListModels(json: unknown): string[] {
  const list = isRecord(json) ? (asArray(json['data']).length ? asArray(json['data']) : asArray(json['models'])) : asArray(json)
  const out = new Set<string>()
  for (const item of list) {
    const id = typeof item === 'string' ? item : isRecord(item) ? asString(item['id']) : ''
    if (id) out.add(id)
  }
  return [...out]
}

export const openai: ProtocolAdapter = {
  id: 'openai',
  label: 'OpenAI 兼容',
  capabilities: ['tools', 'json'],
  defaultBaseUrl: 'https://api.openai.com/v1',
  baseUrlHint: '以 /v1 结尾，例如 https://api.deepseek.com/v1',
  buildChat,
  parseResponse,
  parseStream,
  buildListModels,
  parseListModels,
}
