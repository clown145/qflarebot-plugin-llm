import type { ChatMessage, ChatRequest, ToolCall, ToolDefinition, ToolChoice } from '../contract.js'
import type { ProviderConfig } from '../config/types.js'
import { LLMError } from '../errors.js'
import { asArray, asNumber, asString, isRecord } from '../json.js'
import { readSSE } from '../sse.js'
import { streamError, type UpstreamContext } from '../upstream.js'
import type { BuiltRequest, ParsedResponse, ParsedStreamEvent, ProtocolAdapter, StreamContext, Target } from './types.js'
import {
  endpointUrl,
  modelsUrl,
  openAIFinish,
  openAIUsage,
  partUrl,
  toParts,
} from './shared.js'

function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => (isRecord(part) && part['type'] === 'text' ? asString(part['text']) : ''))
    .join('')
}

/** DeepSeek 用 `reasoning_content`，部分兼容网关用 `reasoning` */
function reasoningText(raw: Record<string, unknown>): string {
  return asString(raw['reasoning_content']) || asString(raw['reasoning'])
}

/**
 * 并行工具调用可能不带 id（部分本地/中转网关）。用递增计数器兜底，
 * 不能按下标——同一批里两条无 id 的调用会得到同一个 `call_0`，调用方回传结果时上游分不清。
 */
function mapToolCalls(raw: unknown, counter: { n: number }): ToolCall[] {
  return asArray(raw).flatMap((item) => {
    if (!isRecord(item)) return []
    const fn = isRecord(item['function']) ? item['function'] : {}
    const name = asString(fn['name'])
    if (!name) return []
    const id = asString(item['id']) || `call_${counter.n++}`
    return [{
      id,
      name,
      arguments: asString(fn['arguments']) || '{}',
    }]
  })
}

/**
 * 把契约里的 `ContentPart[]` 转成 OpenAI Chat Completions 的 content 数组。
 * 不支持的类型抛 `unsupported`，别把图片悄悄丢掉让调用方以为是模型没看图。
 */
function mapContent(content: ChatMessage['content'], where: string): unknown {
  if (content === undefined) return ''
  if (typeof content === 'string') return content
  const parts = toParts(content)
  if (parts.length === 1 && parts[0]?.type === 'text') return parts[0].text
  return parts.map((part) => {
    if (part.type === 'text') return { type: 'text', text: part.text }
    if (part.type === 'image') {
      const url = partUrl(part)
      if (!url) throw new LLMError('bad_request', `${where} 的图片片段缺少 url 或 data`)
      return { type: 'image_url', image_url: { url, ...(part.detail ? { detail: part.detail } : {}) } }
    }
    if (part.type === 'audio') {
      // OpenAI 的 input_audio 只接受 base64 + format，不接受 URL
      if (!part.data) throw new LLMError('unsupported', `${where} 的音频片段需要 base64 data 与 format`)
      return { type: 'input_audio', input_audio: { data: part.data, format: part.format ?? 'wav' } }
    }
    throw new LLMError('unsupported', 'OpenAI 兼容协议不支持 file 片段')
  })
}

function mapMessages(messages: ChatMessage[]): Record<string, unknown>[] {
  const counter = { n: 0 }
  return messages.map((message, index) => {
    const where = `messages[${index}]`
    if (message.role === 'assistant') {
      const toolCalls = message.tool_calls ?? []
      const content = mapContent(message.content, where)
      return {
        role: 'assistant',
        // 有工具调用又没有文本时 content 得是 null，否则部分上游会报错
        content: content === '' && toolCalls.length ? null : content,
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
        content: mapContent(message.content, where),
      }
    }
    return { role: message.role, content: mapContent(message.content, where) }
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

/**
 * 用户自定义头。受管头（Authorization / x-api-key / content-type 等）一律丢掉：
 * 保存时已被 validateConfig 拦成 error，但 KV 里可能还有历史遗留配置，
 * 而 `Headers` 对大小写不同的同名键会**合并**成 `"Bearer a, Bearer b"` 这种坏值。
 */
function applyHeaders(headers: Record<string, string>, custom: Record<string, string> | undefined): void {
  for (const [key, value] of Object.entries(custom ?? {})) {
    if (MANAGED_HEADERS.has(key.toLowerCase())) continue
    headers[key] = value
  }
}

const MANAGED_HEADERS = new Set(['authorization', 'proxy-authorization', 'x-api-key', 'api-key', 'host', 'content-length', 'content-type'])

function buildChat(target: Target, request: ChatRequest, stream: boolean): BuiltRequest {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: stream ? 'text/event-stream' : 'application/json',
  }
  applyHeaders(headers, target.provider.headers)
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
  const toolCalls = mapToolCalls(message['tool_calls'], { n: 0 })
  const reasoning = reasoningText(message)
  const finishReason = openAIFinish(choice['finish_reason'])
  const usage = openAIUsage(json['usage'])
  return {
    text,
    ...(reasoning ? { reasoning } : {}),
    ...(toolCalls.length ? { toolCalls } : {}),
    ...(finishReason ? { finishReason } : {}),
    ...(usage ? { usage } : {}),
  }
}

/** 上游上下文；适配器用它给流内 error 的 message 脱敏 */
function upstreamOf(ctx: StreamContext | undefined, target?: Target): UpstreamContext {
  return {
    provider: target?.provider.id ?? '',
    alias: target?.model.alias ?? '',
    timeoutMs: 0,
    ...(ctx?.apiKey ? { apiKey: ctx.apiKey } : {}),
  }
}

async function* parseStream(
  body: ReadableStream<Uint8Array>,
  ctx?: StreamContext,
): AsyncGenerator<ParsedStreamEvent> {
  const upstream = upstreamOf(ctx)
  for await (const message of readSSE(body)) {
    if (message.data === '[DONE]') return
    let json: unknown
    try {
      json = JSON.parse(message.data)
    } catch {
      throw new Error('上游流式数据不是合法 JSON')
    }
    if (!isRecord(json)) continue

    // HTTP 200 的流里也可能下发错误（OpenRouter、各类中转、vLLM 的配额/鉴权失败都这么干）。
    // 旧实现忽略它，流正常结束，最后误报成「上游没有返回内容」，真实原因全被吞掉。
    const error = json['error']
    if (isRecord(error) || typeof error === 'string') {
      throw streamError(isRecord(error) ? error : { message: error }, upstream)
    }

    const usage = openAIUsage(json['usage'])
    if (usage) yield { type: 'usage', usage }

    const choices = asArray(json['choices'])
    for (const raw of choices) {
      if (!isRecord(raw)) continue
      const delta = isRecord(raw['delta']) ? raw['delta'] : {}

      const text = contentText(delta['content'])
      if (text) yield { type: 'text_delta', text }

      const reasoning = reasoningText(delta)
      if (reasoning) yield { type: 'reasoning_delta', text: reasoning }

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
  applyHeaders(headers, provider.headers)
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
