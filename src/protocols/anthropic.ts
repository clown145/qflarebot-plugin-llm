import type { ChatMessage, ChatRequest, LLMErrorCode, MessageContent, ToolCall, ToolChoice } from '../contract.js'
import type { ProviderConfig } from '../config/types.js'
import { LLMError } from '../errors.js'
import { asArray, asNumber, asString, isRecord } from '../json.js'
import { readSSE } from '../sse.js'
import { streamError, type UpstreamContext } from '../upstream.js'
import type { BuiltRequest, ParsedResponse, ParsedStreamEvent, ProtocolAdapter, StreamContext, Target } from './types.js'
import {
  anthropicFinish,
  anthropicUsage,
  endpointUrl,
  modelsUrl,
  partUrl,
  textOf,
  toParts,
} from './shared.js'

const VERSION = '2023-06-01'

/** 未传 max_tokens 时的兜底值：Anthropic 必填，太小会静默截断长回答 */
const DEFAULT_MAX_TOKENS = 4096

interface TextBlock {
  type: 'text'
  text: string
}

interface ImageBlock {
  type: 'image'
  source: Record<string, unknown>
}

interface DocumentBlock {
  type: 'document'
  source: Record<string, unknown>
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
  content: string | Array<Record<string, unknown>>
  is_error?: boolean
}

type Block = TextBlock | ImageBlock | DocumentBlock | ToolUseBlock | ToolResultBlock

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

/** base64 source（`data` + `media_type`）或 url source；两者都没有时抛 bad_request */
function mediaSource(part: { url?: string; data?: string; media_type?: string }, where: string): Record<string, unknown> {
  if (part.data) {
    return {
      type: 'base64',
      media_type: part.media_type ?? 'application/octet-stream',
      data: part.data,
    }
  }
  if (part.url) return { type: 'url', url: part.url }
  throw new LLMError('bad_request', `${where} 缺少 url 或 data`)
}

/** 把契约里的内容片段转成 Anthropic block；audio 明确不支持 */
function contentBlocks(content: MessageContent | undefined, where: string): Block[] {
  if (content === undefined) return []
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : []
  return toParts(content).map((part) => {
    if (part.type === 'text') return { type: 'text', text: part.text }
    if (part.type === 'image') return { type: 'image', source: mediaSource(part, `${where} 的图片片段`) }
    if (part.type === 'file') return { type: 'document', source: mediaSource(part, `${where} 的文件片段`) }
    throw new LLMError('unsupported', 'Anthropic 协议不支持音频输入')
  })
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

  messages.forEach((message, index) => {
    const where = `messages[${index}]`
    if (message.role === 'system') {
      // system 只接受纯文本；这里取 text 片段，图片等非文本片段在 system 里没有意义
      const text = textOf(message.content).trim()
      if (text) system.push(text)
      return
    }
    if (message.role === 'user') {
      push('user', contentBlocks(message.content, where))
      return
    }
    if (message.role === 'assistant') {
      const blocks: Block[] = []
      // reasoning 不回传：Anthropic 的 thinking block 带签名，重建会校验失败
      blocks.push(...contentBlocks(message.content, where))
      for (const call of message.tool_calls ?? []) {
        blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: toolInput(call.arguments) })
      }
      if (blocks.length === 0) throw new LLMError('bad_request', 'assistant 消息既没有内容也没有工具调用')
      push('assistant', blocks)
      return
    }
    if (!message.tool_call_id) throw new LLMError('bad_request', 'tool 消息缺少 tool_call_id')
    push('user', [{
      type: 'tool_result',
      tool_use_id: message.tool_call_id,
      content: textOf(message.content),
      ...(message.is_error ? { is_error: true } : {}),
    }])
  })

  return { system: system.join('\n\n'), messages: out }
}

/**
 * Anthropic 的 tool_choice 只有 `auto` / `any` / `tool`，没有 `none`。
 * 调用方要求禁用工具时，直接不发送 tools 字段（返回 undefined）。
 */
function mapToolChoice(choice: ToolChoice): unknown | undefined {
  if (choice === 'none') return undefined
  if (choice === 'auto') return { type: 'auto' }
  if (choice === 'required') return { type: 'any' }
  return { type: 'tool', name: choice.name }
}

/**
 * 用户自定义头。受管头一律丢掉：保存时 validateConfig 已把它们拦成 error，
 * 但 KV 里可能还有历史遗留配置，而 `Headers` 对大小写不同的同名键会合并成坏值。
 */
const MANAGED_HEADERS = new Set(['authorization', 'proxy-authorization', 'x-api-key', 'api-key', 'host', 'content-length', 'content-type'])

function applyHeaders(headers: Record<string, string>, custom: Record<string, string> | undefined): void {
  for (const [key, value] of Object.entries(custom ?? {})) {
    if (MANAGED_HEADERS.has(key.toLowerCase())) continue
    headers[key] = value
  }
}

function buildChat(target: Target, request: ChatRequest, stream: boolean): BuiltRequest {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: stream ? 'text/event-stream' : 'application/json',
    'anthropic-version': VERSION,
  }
  applyHeaders(headers, target.provider.headers)
  if (target.provider.api_key) headers['x-api-key'] = target.provider.api_key

  const mapped = mapMessages(request.messages)
  // max_tokens 必填：请求值 → 模型配置的输出上限 → 兜底 4096（旧实现的 1024 会静默截断长回答）
  const maxTokens = request.max_tokens ?? target.model.max_output_tokens ?? DEFAULT_MAX_TOKENS
  const body: Record<string, unknown> = {
    ...(request.extra_body ?? {}),
    model: target.model.model,
    max_tokens: maxTokens,
    messages: mapped.messages,
  }
  if (mapped.system) body['system'] = mapped.system
  if (request.temperature !== undefined) body['temperature'] = request.temperature
  if (request.top_p !== undefined) body['top_p'] = request.top_p
  if (request.stop !== undefined) {
    body['stop_sequences'] = Array.isArray(request.stop) ? request.stop : [request.stop]
  }
  // tool_choice: 'none' 表示调用方不要工具 → 连 tools 都不发（Anthropic 没有 none 类型）
  const toolChoice = request.tool_choice ? mapToolChoice(request.tool_choice) : undefined
  const sendTools = Boolean(request.tools?.length) && request.tool_choice !== 'none'
  if (sendTools) {
    body['tools'] = request.tools!.map((tool) => ({
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      input_schema: tool.parameters,
    }))
    if (toolChoice !== undefined) body['tool_choice'] = toolChoice
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
  let reasoning = ''
  const toolCalls: ToolCall[] = []
  for (const block of content) {
    if (!isRecord(block)) continue
    if (block['type'] === 'text') {
      text += asString(block['text'])
    } else if (block['type'] === 'thinking') {
      // 扩展思考：只取正文，签名不回传（回传会校验失败）
      reasoning += asString(block['thinking'])
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
    ...(reasoning ? { reasoning } : {}),
    ...(toolCalls.length ? { toolCalls } : {}),
    ...(finishReason ? { finishReason } : {}),
    ...(usage ? { usage } : {}),
  }
}

function streamErrorCode(type: string | undefined): LLMErrorCode {
  switch (type) {
    case 'authentication_error':
    case 'permission_error':
      return 'auth'
    case 'rate_limit_error':
      return 'rate_limit'
    case 'invalid_request_error':
    case 'not_found_error':
    case 'request_too_large':
      return 'bad_request'
    case 'overloaded_error':
    case 'api_error':
      return 'upstream'
    default:
      return 'upstream'
  }
}

function upstreamOf(ctx: StreamContext | undefined): UpstreamContext {
  return { provider: '', alias: '', timeoutMs: 0, ...(ctx?.apiKey ? { apiKey: ctx.apiKey } : {}) }
}

async function* parseStream(
  body: ReadableStream<Uint8Array>,
  ctx?: StreamContext,
): AsyncGenerator<ParsedStreamEvent> {
  const upstream = upstreamOf(ctx)
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
      } else if (delta['type'] === 'thinking_delta') {
        const thinking = asString(delta['thinking'])
        if (thinking) yield { type: 'reasoning_delta', text: thinking }
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
      // 走统一的流内错误映射：message 必须脱敏，上游常把 key 原样回显在里面
      throw streamError(error, upstream)
    }
  }
}

function buildListModels(provider: ProviderConfig): BuiltRequest {
  const headers: Record<string, string> = {
    accept: 'application/json',
    'anthropic-version': VERSION,
  }
  applyHeaders(headers, provider.headers)
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
