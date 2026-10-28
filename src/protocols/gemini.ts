import type { ChatMessage, ChatRequest, ContentPart, FinishReason, MessageContent, ThoughtSignature, ToolCall, ToolDefinition, Usage } from '../contract.js'
import type { ProviderConfig } from '../config/types.js'
import { LLMError } from '../errors.js'
import { asArray, asNumber, asString, isRecord } from '../json.js'
import { readSSE } from '../sse.js'
import { streamError, type UpstreamContext } from '../upstream.js'
import type { BuiltRequest, ParsedResponse, ParsedStreamEvent, ProtocolAdapter, StreamContext, Target } from './types.js'
import { endpointUrl, mergeUsage, toParts, textOf } from './shared.js'

/**
 * Google Gemini 原生协议（generativelanguage / Vertex 兼容网关同理）。
 *
 * 与 OpenAI/Anthropic 的关键差异：
 * - 鉴权用 `x-goog-api-key` 头，不是 Bearer
 * - `contents: [{role: 'user'|'model', parts: [...]}]`，system 是顶层字段
 * - 多模态 inline：`inline_data: {mime_type, data}`（base64）；url 图片用 `file_data: {file_uri}`
 * - 工具是 `tools: [{function_declarations: [...]}]`，参数 Schema 是受限 JSON Schema 子集
 * - 思考内容是带 `thought: true` 的 text part
 * - 流式端点 `:streamGenerateContent?alt=sse`
 * - tool result 回传为 user role 的 `functionResponse` part（没有独立 tool 角色）
 */

const DEFAULT_MAX_TOKENS = 8192

interface GeminiPart {
  text?: string
  thought?: boolean
  /** 思考签名：Gemini 2.5/3.x 要求带签名的 part 原样回传，缺失会 400 */
  thoughtSignature?: string
  inline_data?: { mime_type: string; data: string }
  file_data?: { file_uri: string; mime_type?: string }
  function_call?: { name: string; args?: Record<string, unknown>; id?: string }
  functionResponse?: { name: string; response?: Record<string, unknown>; id?: string }
}

interface GeminiContent {
  role: 'user' | 'model'
  parts: GeminiPart[]
}

/** JSON Schema → Gemini 受限子集。参考 AstrBot 的转换行为，实现独立编写。 */
function convertSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const SUPPORTED_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'array', 'object', 'null'])
  const out: Record<string, unknown> = {}

  if (Array.isArray(schema['anyOf'])) {
    return { anyOf: (schema['anyOf'] as unknown[]).filter(isRecord).map(convertSchema) }
  }

  // Gemini 的 type 只接受字符串枚举；JSON Schema 允许数组（如 ["string","null"]），取第一个非 null
  let type = schema['type']
  if (Array.isArray(type)) {
    type = (type.find((item) => item !== 'null') as string | undefined) ?? 'string'
  }
  if (typeof type === 'string' && SUPPORTED_TYPES.has(type)) {
    out['type'] = type
  } else {
    out['type'] = 'null'
  }

  for (const key of ['title', 'description', 'enum', 'minimum', 'maximum', 'maxItems', 'minItems', 'nullable', 'required'] as const) {
    if (schema[key] !== undefined) out[key] = schema[key]
  }

  const properties = schema['properties']
  if (isRecord(properties)) {
    const mapped: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(properties)) {
      if (!isRecord(value)) continue
      const converted = convertSchema(value)
      delete converted['default'] // Gemini 的 properties 不接受 default
      delete converted['additionalProperties']
      mapped[key] = converted
    }
    if (Object.keys(mapped).length) out['properties'] = mapped
  }

  if (out['type'] === 'array') {
    const items = schema['items']
    out['items'] = isRecord(items) ? convertSchema(items) : { type: 'string' } // Gemini 要求 array 必带 items
  }
  return out
}

/** image/file/audio 片段 → inline_data / file_data；image 的 data: URI 拆回 base64 */
function inlinePart(part: ContentPart, where: string): GeminiPart {
  if (part.type === 'text') return { text: part.text }
  if (part.type === 'audio') {
    if (!part.data) throw new LLMError('bad_request', `${where} 的音频片段需要 base64 data`)
    return { inline_data: { mime_type: part.media_type ?? `audio/${part.format ?? 'wav'}`, data: part.data } }
  }
  if (part.data) {
    return { inline_data: { mime_type: part.media_type ?? 'application/octet-stream', data: part.data } }
  }
  if (part.url) {
    const dataUri = parseDataUri(part.url)
    if (dataUri) return { inline_data: { mime_type: part.media_type ?? dataUri.mediaType, data: dataUri.data } }
    // https url 走 file_data（Gemini 服务端拉取）
    return { file_data: { file_uri: part.url, ...(part.media_type ? { mime_type: part.media_type } : {}) } }
  }
  throw new LLMError('bad_request', `${where} 缺少 url 或 data`)
}

function parseDataUri(url: string): { mediaType: string; data: string } | undefined {
  if (!url.startsWith('data:')) return undefined
  const comma = url.indexOf(',')
  if (comma < 0) return undefined
  const meta = url.slice(5, comma)
  if (!meta.endsWith(';base64')) return undefined
  const mediaType = meta.slice(0, -';base64'.length) || 'application/octet-stream'
  if (!/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(mediaType)) return undefined
  return { mediaType, data: url.slice(comma + 1) }
}

/** 契约消息 → contents。system 抽顶层；tool 消息转 user 的 functionResponse；assistant 转带 functionCall 的 model */
function mapMessages(messages: ChatMessage[]): { system: string; contents: GeminiContent[] } {
  const system: string[] = []
  const contents: GeminiContent[] = []

  const push = (role: GeminiContent['role'], parts: GeminiPart[]) => {
    if (!parts.length) return
    const last = contents[contents.length - 1]
    if (last?.role === role) last.parts.push(...parts)
    else contents.push({ role, parts })
  }

  const contentParts = (content: MessageContent | undefined, where: string): GeminiPart[] => {
    if (content === undefined) return []
    if (typeof content === 'string') return content ? [{ text: content }] : []
    return toParts(content).map((part) => {
      if (part.type === 'text') return { text: part.text } as GeminiPart
      return inlinePart(part, where)
    })
  }

  messages.forEach((message, index) => {
    const where = `messages[${index}]`
    if (message.role === 'system') {
      const text = textOf(message.content).trim()
      if (text) system.push(text)
      return
    }
    if (message.role === 'user') {
      push('user', contentParts(message.content, where))
      return
    }
    if (message.role === 'assistant') {
      const parts: GeminiPart[] = []
      // 思考内容文本不回传（Gemini 的 thought part 无法重建），但签名必须回传。
      // 重建顺序固定为「先文本 part、后 functionCall part」，与 parseResponse 记 part_index 的口径一致。
      const textParts = contentParts(message.content, where)
      const callEntries: Array<{ call: ToolCall; args: Record<string, unknown>; callIndex: number; signature?: string }> = (message.tool_calls ?? []).map((call, callIndex) => {
        let args: Record<string, unknown>
        try {
          args = JSON.parse(call.arguments || '{}') as Record<string, unknown>
        } catch {
          throw new LLMError('bad_request', `${where} 的工具调用参数不是合法 JSON`)
        }
        if (!isRecord(args)) throw new LLMError('bad_request', `${where} 的工具调用参数必须是 JSON 对象`)
        return { call, args, callIndex }
      })

      // 把签名贴回对应 part：functionCall 优先按 tool_call_id 匹配，其次工具名，最后下标兜底
      for (const item of message.thought_signatures ?? []) {
        if (item.part_kind === 'function_call') {
          const target =
            callEntries.find((entry) => item.tool_call_id && entry.call.id === item.tool_call_id) ??
            callEntries.find((entry) => item.tool_name && entry.call.name === item.tool_name) ??
            (item.tool_call_index !== undefined ? callEntries[item.tool_call_index] : undefined)
          if (target) target.signature = item.signature
          continue
        }
        // 文本 part：按下标贴；下标越界时退回最后一个文本 part（上游把签名放在承载该轮思考的 part 上）
        const index = item.part_index - (textParts.length ? 0 : 0)
        const target = textParts[index] ?? textParts[textParts.length - 1]
        if (target) target.thoughtSignature = item.signature
      }

      parts.push(...textParts)
      for (const entry of callEntries) {
        parts.push({
          function_call: {
            name: entry.call.name,
            args: entry.args,
            ...(entry.call.id ? { id: entry.call.id } : {}),
          },
          ...(entry.signature ? { thoughtSignature: entry.signature } : {}),
        })
      }
      if (!parts.length) throw new LLMError('bad_request', `${where} 既没有内容也没有工具调用`)
      push('model', parts)
      return
    }
    // tool → user 的 functionResponse
    if (!message.tool_call_id) throw new LLMError('bad_request', `${where} 缺少 tool_call_id`)
    let name = message.tool_call_id
    let response: Record<string, unknown> = {}
    if (typeof message.content === 'string' && message.content.trim()) {
      try {
        const parsed = JSON.parse(message.content) as unknown
        if (isRecord(parsed)) response = parsed
        else response = { result: message.content }
      } catch {
        response = { result: message.content }
      }
    }
    push('user', [{ functionResponse: { name, response, id: message.tool_call_id } }])
  })

  // Gemini 要求 contents 以 user 开头（model 开头会 400）
  while (contents.length && contents[0]?.role === 'model') contents.shift()
  return { system: system.join('\n\n'), contents }
}

function mapTools(tools: ToolDefinition[]): Record<string, unknown>[] {
  return tools.map((tool) => ({
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    ...(isRecord(tool.parameters) && Object.keys(tool.parameters).length
      ? { parameters: convertSchema(tool.parameters) }
      : {}),
  }))
}

/**
 * Gemini 没有 tool_choice 'none'；表示禁用工具时直接不发送 tools（同 Anthropic 策略）。
 * 'required' → ANY；指定工具 → ANY + allowed_function_names。
 */
function toolConfig(choice: ChatRequest['tool_choice']): Record<string, unknown> | undefined {
  if (choice === 'required') return { function_calling_config: { mode: 'ANY' } }
  if (typeof choice === 'object' && choice.name) {
    return { function_calling_config: { mode: 'ANY', allowed_function_names: [choice.name] } }
  }
  return undefined // auto / 未传
}

function applyHeaders(headers: Record<string, string>, custom: Record<string, string> | undefined): void {
  for (const [key, value] of Object.entries(custom ?? {})) {
    if (GEMINI_MANAGED_HEADERS.has(key.toLowerCase())) continue
    headers[key] = value
  }
}

const GEMINI_MANAGED_HEADERS = new Set(['authorization', 'proxy-authorization', 'x-api-key', 'api-key', 'x-goog-api-key', 'host', 'content-length', 'content-type'])

function buildChat(target: Target, request: ChatRequest, stream: boolean): BuiltRequest {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: stream ? 'text/event-stream' : 'application/json',
  }
  applyHeaders(headers, target.provider.headers)
  if (target.provider.api_key) headers['x-goog-api-key'] = target.provider.api_key

  const mapped = mapMessages(request.messages)
  const maxTokens = request.max_tokens ?? target.model.max_output_tokens ?? DEFAULT_MAX_TOKENS
  const body: Record<string, unknown> = {
    ...(request.extra_body ?? {}),
    model: target.model.model,
    contents: mapped.contents,
    generationConfig: {
      maxOutputTokens: maxTokens,
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.top_p !== undefined ? { topP: request.top_p } : {}),
      ...(request.stop !== undefined
        ? { stopSequences: Array.isArray(request.stop) ? request.stop : [request.stop] }
        : {}),
    },
  }
  if (mapped.system) body['systemInstruction'] = { parts: [{ text: mapped.system }] }
  if (request.json) {
    // Gemini 的 JSON 模式：response_mime_type + 宽松 schema
    body['generationConfig'] = {
      ...(body['generationConfig'] as Record<string, unknown>),
      response_mime_type: 'application/json',
    }
  }
  const sendTools = Boolean(request.tools?.length) && request.tool_choice !== 'none'
  if (sendTools) {
    body['tools'] = [{ function_declarations: mapTools(request.tools!) }]
    const config = toolConfig(request.tool_choice)
    if (config) body['tool_config'] = config
  }
  if (stream) body['stream'] = true

  const base = target.provider.base_url.replace(/\/+$/, '')
  const path = stream ? ':streamGenerateContent?alt=sse' : ':generateContent'
  const url = base.endsWith(':generateContent') || base.endsWith(':streamGenerateContent')
    ? base
    : `${endpointUrl(base, path)}${base.includes('?') ? '' : ''}`
  return { url, init: { method: 'POST', headers, body: JSON.stringify(body) } }
}

function parseResponse(json: unknown): ParsedResponse {
  if (!isRecord(json)) throw new Error('上游返回的不是 JSON 对象')
  if (isRecord(json['error'])) throw streamError(json['error'], { provider: '', alias: '', timeoutMs: 0 })
  const candidates = asArray(json['candidates'])
  const candidate = isRecord(candidates[0]) ? candidates[0] : null
  if (!candidate) throw new Error('上游没有返回 candidates')
  const content = isRecord(candidate['content']) ? candidate['content'] : {}
  const parts = asArray(content['parts'])
  let text = ''
  let reasoning = ''
  const signatures: ThoughtSignature[] = []
  const toolCalls: ToolCall[] = []
  // 回传时 parts 重建顺序是「先文本 part、后 functionCall part」，签名里的 part_index 按这个口径记
  let textPartIndex = 0
  parts.forEach((raw, index) => {
    if (!isRecord(raw)) return
    const thought = raw['thought'] === true
    const partText = asString(raw['text'])
    const signature = asString(raw['thoughtSignature']) || asString(raw['thought_signature'])
    if (partText && thought) {
      // thought part 的文本不回传，但签名仍要保留（回传时贴在重建的文本 part 上）
      if (signature) {
        signatures.push({ part_index: textPartIndex, part_kind: 'text', signature })
        textPartIndex += 1
      }
      reasoning += partText
      return
    }
    if (partText) {
      if (signature) signatures.push({ part_index: textPartIndex, part_kind: 'text', signature })
      textPartIndex += 1
      text += partText
      return
    }
    const call = isRecord(raw['function_call']) ? raw['function_call'] : undefined
    if (call) {
      const name = asString(call['name'])
      if (!name) return
      const args = isRecord(call['args']) ? call['args'] : {}
      const callIndex = toolCalls.length
      const id = asString(call['id']) || `call_${index}`
      toolCalls.push({ id, name, arguments: JSON.stringify(args) })
      if (signature) {
        signatures.push({
          part_index: textPartIndex + callIndex,
          part_kind: 'function_call',
          signature,
          tool_call_index: callIndex,
          tool_call_id: id,
          tool_name: name,
        })
      }
    }
  })
  const finishReason = geminiFinish(candidate['finish_reason'] ?? candidate['finishReason'])
  const usage = geminiUsage(json['usage_metadata'] ?? json['usageMetadata'])
  return {
    text,
    ...(reasoning ? { reasoning } : {}),
    ...(signatures.length ? { thoughtSignatures: signatures } : {}),
    ...(toolCalls.length ? { toolCalls } : {}),
    ...(finishReason ? { finishReason } : {}),
    ...(usage ? { usage } : {}),
  }
}

function geminiFinish(reason: unknown): FinishReason | undefined {
  switch (reason) {
    case 'STOP':
      return 'stop'
    case 'MAX_TOKENS':
      return 'length'
    case 'SAFETY':
    case 'RECITATION':
    case 'BLOCKLIST':
    case 'PROHIBITED_CONTENT':
    case 'IMAGE_SAFETY':
    case 'SPII':
      return 'content_filter'
    case 'MALFORMED_FUNCTION_CALL':
    case 'TOO_MANY_FUNCTION_CALLS':
      return 'other'
    case undefined:
    case null:
      return undefined
    default:
      return typeof reason === 'string' ? 'other' : undefined
  }
}

function geminiUsage(raw: unknown): Usage | undefined {
  if (!isRecord(raw)) return undefined
  const usage: Usage = {}
  const input = asNumber(raw['prompt_token_count'] ?? raw['promptTokenCount'])
  const output = asNumber(raw['candidates_token_count'] ?? raw['candidatesTokenCount'])
  const total = asNumber(raw['total_token_count'] ?? raw['totalTokenCount'])
  if (input !== undefined) usage.input_tokens = input
  if (output !== undefined) usage.output_tokens = output
  if (total !== undefined) usage.total_tokens = total
  return Object.keys(usage).length ? usage : undefined
}

function upstreamOf(ctx: StreamContext | undefined): UpstreamContext {
  return {
    provider: '',
    alias: '',
    timeoutMs: 0,
    ...(ctx?.apiKey ? { apiKey: ctx.apiKey } : {}),
    ...(ctx?.secrets?.length ? { secrets: ctx.secrets } : {}),
  }
}

async function* parseStream(
  body: ReadableStream<Uint8Array>,
  ctx?: StreamContext,
): AsyncGenerator<ParsedStreamEvent> {
  const upstream = upstreamOf(ctx)
  // 工具槽位在整条流内连续递增：Gemini 一次响应里 parts 可能分多帧下发，
  // 每帧重置会让多个工具调用塌缩到 index 0
  let toolIndex = 0
  // 文本 part 计数：签名里的 part_index 按「重建顺序」记（先文本、后 functionCall）
  let textPartIndex = 0
  for await (const message of readSSE(body)) {
    if (!message.data.trim()) continue
    let json: unknown
    try {
      json = JSON.parse(message.data)
    } catch {
      throw new Error('上游流式数据不是合法 JSON')
    }
    if (!isRecord(json)) continue

    // HTTP 200 的流里也可能下发错误（配额/鉴权失败），同 OpenAI 适配器策略
    const error = json['error']
    if (isRecord(error) || typeof error === 'string') {
      throw streamError(isRecord(error) ? error : { message: error }, upstream)
    }

    const usage = geminiUsage(json['usage_metadata'] ?? json['usageMetadata'])
    if (usage) yield { type: 'usage', usage }

    const candidates = asArray(json['candidates'])
    for (const raw of candidates) {
      if (!isRecord(raw)) continue
      const content = isRecord(raw['content']) ? raw['content'] : {}
      const parts = asArray(content['parts'])
      for (const partRaw of parts) {
        if (!isRecord(partRaw)) continue
        const thought = partRaw['thought'] === true
        const text = asString(partRaw['text'])
        const signature = asString(partRaw['thoughtSignature']) || asString(partRaw['thought_signature'])
        if (text) {
          // 文本 part 的签名按「重建顺序里的文本 part 下标」透出，调用方原样收集即可
          if (signature) {
            yield { type: 'thought_signature', part_index: textPartIndex, part_kind: 'text', signature }
          }
          textPartIndex += 1
          yield { type: thought ? 'reasoning_delta' : 'text_delta', text }
          continue
        }
        const call = isRecord(partRaw['function_call']) ? partRaw['function_call'] : undefined
        if (call) {
          const name = asString(call['name'])
          if (name) {
            const args = isRecord(call['args']) ? call['args'] : {}
            const index = toolIndex++
            const id = asString(call['id']) || `call_${index}`
            if (signature) {
              yield {
                type: 'thought_signature',
                part_index: textPartIndex + index,
                part_kind: 'function_call',
                signature,
                tool_call_index: index,
                tool_call_id: id,
                tool_name: name,
              }
            }
            yield {
              type: 'tool_call_delta',
              index,
              id: asString(call['id']) || undefined,
              name,
              argumentsDelta: JSON.stringify(args),
            }
          }
        } else if (signature) {
          // 既无文本也非工具调用的 part 上的签名（如纯 thinking part）：单独透出，不丢
          yield { type: 'thought_signature', part_index: textPartIndex, part_kind: 'text', signature }
        }
      }
      const reason = geminiFinish(raw['finish_reason'] ?? raw['finishReason'])
      if (reason) yield { type: 'finish', reason }
    }
  }
}

function buildListModels(provider: ProviderConfig): BuiltRequest {
  const headers: Record<string, string> = { accept: 'application/json' }
  applyHeaders(headers, provider.headers)
  if (provider.api_key) headers['x-goog-api-key'] = provider.api_key
  const base = provider.base_url.replace(/\/+$/, '')
  // Gemini 的模型列表在 /models（v1beta），带 generateContent 端点时退回上一级
  let path = base
  for (const mark of ['?te', '#']) {
    const at = path.search(/[?#]/)
    if (at >= 0) path = path.slice(0, at)
  }
  if (path.endsWith(':generateContent') || path.endsWith(':streamGenerateContent')) {
    path = path.slice(0, path.lastIndexOf(':'))
  }
  return { url: `${path.replace(/\/+$/, '')}/models`, init: { method: 'GET', headers } }
}

function parseListModels(json: unknown): string[] {
  // Gemini 的 /models 返回 {models: [{name: 'models/gemini-2.0-flash', ...}]}
  const list = isRecord(json) ? asArray(json['models']) : asArray(json)
  const out = new Set<string>()
  for (const item of list) {
    const raw = typeof item === 'string' ? item : isRecord(item) ? asString(item['name']) : ''
    if (!raw) continue
    out.add(raw.startsWith('models/') ? raw.slice('models/'.length) : raw)
  }
  return [...out]
}

export const gemini: ProtocolAdapter = {
  id: 'gemini',
  label: 'Google Gemini',
  capabilities: ['tools', 'json'],
  defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
  baseUrlHint: '以 /v1beta 结尾，例如 https://generativelanguage.googleapis.com/v1beta',
  buildChat,
  parseResponse,
  parseStream,
  buildListModels,
  parseListModels,
}
