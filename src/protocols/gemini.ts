import type { ChatMessage, ChatRequest, ContentPart, FinishReason, MessageContent, ThoughtSignature, ToolCall, ToolDefinition, Usage } from '../contract.js'
import type { ProviderConfig } from '../config/types.js'
import { LLMError } from '../errors.js'
import { asArray, asNumber, asString, isRecord } from '../json.js'
import { readSSE } from '../sse.js'
import { streamError, type UpstreamContext } from '../upstream.js'
import * as thinking from './thinking.js'
import type { BuildHooks, BuiltRequest, ParsedResponse, ParsedStreamEvent, ProtocolAdapter, StreamContext, Target } from './types.js'
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

/**
 * JSON Schema → Gemini 受限子集。参考 AstrBot 的转换行为，实现独立编写。
 */
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
  } else if (isRecord(schema['properties'])) {
    // **未声明 type 但有 properties：按 object 推断。**
    //
    // 旧实现一律写 `type: 'null'`：上游收到 `{type:'null', properties:{…}}`，
    // 参数校验会把所有字段都当成「不允许有值」，模型永远填不出合法参数。
    // 这是 JSON Schema 里最常见的省略写法（`type` 可省，靠其它关键字推断）。
    out['type'] = 'object'
  } else if (schema['items'] !== undefined || schema['enum'] !== undefined) {
    // 只有 items / enum、没有 type：按 JSON Schema 惯例推成 string / array
    if (schema['items'] !== undefined) out['type'] = 'array'
    else out['type'] = 'string'
  } else {
    // 真的什么都没有（或声明了我们不认识的自定义类型）：
    // 宁可声明成 string（最宽松的标量），也不要用 'null' —— 它会让参数永远缺失。
    out['type'] = 'string'
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

  // 工具调用 id → 函数名。tool 消息只有 id，而 Gemini 的 functionResponse
  // 要的是函数名；先扫一遍历史建立索引，后面处理 tool 消息时才能填对。
  const toolCallNames = new Map<string, string>()
  for (const message of messages) {
    for (const call of message.tool_calls ?? []) {
      if (call.id && call.name) toolCallNames.set(call.id, call.name)
    }
  }

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
        const target = textParts[item.part_index] ?? textParts[textParts.length - 1]
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
    // **functionResponse.name 必须是函数名，不是调用 id。**
    //
    // Gemini 靠这个字段把结果对回是哪次调用，而调用 id（`call_xxx`）跟函数名是两回事：
    // 用 id 填进去，上游会认为「返回了一个不存在的函数的结果」，表现为模型接着说
    // 「我没法调用工具」或者干脆忽略结果。
    //
    // 契约里的 tool 消息只带 tool_call_id，所以要从历史里的 assistant.tool_calls 反查。
    // 反查不到时退回 id（至少不会拼出空字段，上游会给出可读的报错）。
    const name = toolCallNames.get(message.tool_call_id) ?? message.tool_call_id
    // **tool 消息的 content 可能是内容片段数组**（契约允许 `MessageContent`），
    // 而旧实现只认字符串：数组走到 `[]` 分支，functionResponse 的 response 变成 `{}`，
    // 模型拿到的工具结果是空的——不报错，只是「答非所问」。
    // 这里统一用 textOf() 取纯文本，再按 JSON 解析；非文本片段在 functionResponse 里没有表达。
    const toolText = textOf(message.content)
    let response: Record<string, unknown> = {}
    if (toolText.trim()) {
      try {
        const parsed = JSON.parse(toolText) as unknown
        response = isRecord(parsed) ? parsed : { result: toolText }
      } catch {
        response = { result: toolText }
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

function buildChat(target: Target, request: ChatRequest, stream: boolean, hooks: BuildHooks = {}): BuiltRequest {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: stream ? 'text/event-stream' : 'application/json',
  }
  applyHeaders(headers, target.provider.headers)
  if (target.provider.api_key) headers['x-goog-api-key'] = target.provider.api_key

  const mapped = mapMessages(request.messages)
  const requestedMaxTokens = request.max_tokens ?? target.model.max_output_tokens ?? DEFAULT_MAX_TOKENS
  const extra = request.extra_body ?? {}
  // 思考等级：Gemini 按模型世代二选一（2.5 用 thinkingBudget / 3.x 用 thinkingLevel）。
  const effort = thinking.effectiveEffort(request, target.model)
  const extraGeneration = isRecord(extra['generationConfig']) ? extra['generationConfig'] : {}
  const extraThinking = isRecord(extraGeneration['thinkingConfig']) ? extraGeneration['thinkingConfig'] : undefined
  // **`thinkingBudget` 与 `maxOutputTokens` 互相约束**：上游要求
  // `maxOutputTokens > thinkingBudget`，否则直接
  //   `400 INVALID_ARGUMENT: maxOutputTokens must be greater than thinkingBudget`
  // 旧实现各算各的（ping 的 max_tokens:16 + 配置的 high → 8192 必坏）。
  const plan = thinking.planGeminiOutput({
    effort,
    model: target.model.model,
    requestedMaxTokens,
    outputCap: target.model.max_output_tokens,
  })
  // 调用方自己通过 extra_body 传了 thinkingConfig 时以它为准，但要保证
  // `maxOutputTokens` 跟它自洽（预算能塞进模型输出上限里）；塞不进就放弃它并告警。
  let callerThinking = extraThinking
  /** 调用方的 thinkingConfig 被判定不可用时置 true：合并后要从 generationConfig 里删掉 */
  let droppedCallerThinking = false
  let maxOutputTokens = plan.maxTokens
  if (callerThinking) {
    const customBudget = asNumber(callerThinking['thinkingBudget'])
    if (customBudget !== undefined && customBudget > 0) {
      const fitted = thinking.maxTokensForBudget({
        requestedMaxTokens,
        budget: customBudget,
        outputCap: target.model.max_output_tokens,
        // Gemini 只要严格大于预算；留 1 token 余量即可，不必像 Anthropic 那样留 1024
        reserve: 1,
      })
      if (fitted.fits) {
        maxOutputTokens = fitted.maxTokens
      } else {
        hooks.warn?.('调用方指定的 thinkingBudget 超过模型输出上限，本次不发送 thinkingConfig', {
          thinkingBudget: customBudget,
          maxOutputTokens: fitted.maxTokens,
          model: target.model.model,
        })
        callerThinking = undefined
        droppedCallerThinking = true
      }
    }
  }
  const body: Record<string, unknown> = {
    ...extra,
    // 不写 `model`：模型名已经在 URL 路径里（`/models/{model}:generateContent`），
    // 请求体没有这个字段。官方端点对多余字段是「能忽略就忽略」，但流式端点对
    // 未知字段直接 400（见上面对 `stream` 的说明），所以不给自己留隐患。
    contents: mapped.contents,
    // `generationConfig` 必须与 `extra_body` 里的同名对象**深合并**。
    //
    // 浅展开会把整个 `generationConfig` 覆盖掉：调用方通过 `extra_body` 传的
    // `thinkingConfig` / `responseMimeType` 等字段会静默消失，而且不报错——
    // 只有直连官方端点比对请求体才能发现。其余字段（tools、systemInstruction 等）
    // 是这层自己的，仍按「extra_body 优先、随后被权威值覆盖」处理。
    generationConfig: {
      ...extraGeneration,
      maxOutputTokens,
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.top_p !== undefined ? { topP: request.top_p } : {}),
      ...(request.stop !== undefined
        ? { stopSequences: Array.isArray(request.stop) ? request.stop : [request.stop] }
        : {}),
      // 同理，`thinkingConfig` 也要按字段合并：调用方可能只想改 `includeThoughts`
      ...(callerThinking
        ? { thinkingConfig: callerThinking }
        : plan.thinkingConfig
          ? { thinkingConfig: plan.thinkingConfig }
          : {}),
    },
  }
  // `extraGeneration` 的浅展开已经把调用方原始的 thinkingConfig 带进来了；
  // 汇总判定它不可用时，必须显式删掉（否则又会被发出去）
  if (droppedCallerThinking) delete (body['generationConfig'] as Record<string, unknown>)['thinkingConfig']
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
  // **不要往 body 里塞 `stream`**：流式由 URL 上的 `:streamGenerateContent` 决定，
  // body 里多一个 `stream` 字段会被官方端点当成未知字段直接 400：
  //   Invalid JSON payload received. Unknown name "stream" at 'request'
  // 宽松的兼容网关会忽略它，所以本地测不出来——只有直连 generativelanguage 才炸。

  return {
    url: generateContentUrl(target.provider.base_url, target.model.model, stream),
    init: { method: 'POST', headers, body: JSON.stringify(body) },
  }
}

/**
 * 从一个 part 里取出 functionCall。
 *
 * **响应是 camelCase，请求是 snake_case**——这是 Gemini REST 的既定差异，不是笔误：
 *
 * ```
 * 请求: { "function_call": ... }  /  contents[].parts[].functionCall 响应
 * 响应: { "functionCall": { name, args, id } }
 * ```
 *
 * 官方 SDK 在内部完成这层映射，所以照 SDK 写的代码看不到这个差异；
 * 手写 REST 调用则必须同时接受两种写法。只认 snake_case 的后果是**静默丢工具调用**：
 * 上游正常返回，模型却认为「没有可调用的工具」，对话照常进行但永远不触发函数。
 *
 * 同文件里 `thoughtSignature`、`finishReason`、`usageMetadata` 早就做了双写兜底，
 * 唯独这个字段漏了——工具调用走不通就是因为这一处。
 */
function asFunctionCall(part: Record<string, unknown>): Record<string, unknown> | undefined {
  const camel = part['functionCall']
  if (isRecord(camel)) return camel
  const snake = part['function_call']
  return isRecord(snake) ? snake : undefined
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
  // 回传时 parts 重建顺序是「先文本 part、后 functionCall part」，签名里的 part_index 按这个口径记。
  //
  // **只数「会出现在重建 parts 里的文本 part」**：thought part 的文本不回传
  // （`ChatResult.reasoning` 是独立字段，调用方回传时只放 `text`），所以它不占下标。
  // 流式路径曾经对 thought part 也自增，导致同一条响应在流式/非流式下算出的
  // part_index 差 1（见 parseStream 的同名计数）。
  let textPartIndex = 0
  parts.forEach((raw, index) => {
    if (!isRecord(raw)) return
    const thought = raw['thought'] === true
    const partText = asString(raw['text'])
    const signature = asString(raw['thoughtSignature']) || asString(raw['thought_signature'])
    if (partText && thought) {
      // thought part 的文本不回传，但签名仍要保留（回传时贴在重建的文本 part 上）
      if (signature) signatures.push({ part_index: textPartIndex, part_kind: 'text', signature })
      reasoning += partText
      return
    }
    if (partText) {
      if (signature) signatures.push({ part_index: textPartIndex, part_kind: 'text', signature })
      textPartIndex += 1
      text += partText
      return
    }
    // Gemini 的 REST 响应是 **camelCase**（functionCall），而请求体是 snake_case（function_call）。
    // 官方 Python/JS SDK 内部做这层映射，手写 REST 客户端必须自己兜住——
    // 只读 snake_case 会让工具调用被静默丢弃：上游明明返回了 functionCall，模型侧却拿到空结果，
    // 表现为「能对话、但从不调用工具」，而且没有任何报错。
    const call = asFunctionCall(raw)
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
  // **有工具调用时 finishReason 必须是 tool_calls，即使上游给的是 STOP。**
  // Gemini 不像 OpenAI/Anthropic 那样返回专门的 tool_calls/tool_use 结束原因：
  // 它照样返回 `STOP`，只在 `finishMessage` 里写一句「Model generated function call(s).」。
  // 直接透传会让调用方看到「正常结束 + 有 tool_calls」这种自相矛盾的结果。
  // service.ts 的 `parsed.finishReason ?? (toolCalls ? 'tool_calls' : ...)` 里的 `??`
  // 会优先取到 'stop'，工具调用虽然还在，结束时却会走「正常结束」分支。
  const finishReason = toolCalls.length
    ? 'tool_calls'
    : geminiFinish(candidate['finish_reason'] ?? candidate['finishReason'])
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
  // **思考 token 并入 output_tokens**（Gemini 2.5/3.x 的 thinking 消耗）。
  //
  // Gemini 的 `candidatesTokenCount` 不含思考 token，而 `totalTokenCount` 含；
  // 直接透出会让「input + output ≠ total」，成本核算少算一截，也看不出差在哪。
  // OpenAI 的 `completion_tokens` 本来就是含推理 token 的，所以并进 output
  // 是跨协议一致的口径，不需要为此扩展契约（Usage 没有 reasoning_tokens 字段）。
  const thoughts = asNumber(raw['thoughts_token_count'] ?? raw['thoughtsTokenCount']) ?? 0
  if (input !== undefined) usage.input_tokens = input
  if (output !== undefined) usage.output_tokens = output + thoughts
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
  // 文本 part 计数：签名里的 part_index 按「重建顺序」记（先文本、后 functionCall）。
  // **只数会出现在重建 parts 里的文本 part**（thought part 的文本不回传），
  // 口径必须与非流式 parseResponse 完全一致，否则同一条响应在两条路径下签名落点不同。
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
          if (!thought) textPartIndex += 1
          yield { type: thought ? 'reasoning_delta' : 'text_delta', text }
          continue
        }
        const call = asFunctionCall(partRaw)
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
      // 与非流式同一规则：Gemini 在有工具调用时照样返回 STOP，只在 finishMessage 里提一句。
      // 这里必须改写成 tool_calls，否则调用方会当成「正常结束」而不再继续跑工具。
      if (reason) yield { type: 'finish', reason: toolIndex > 0 ? 'tool_calls' : reason }
    }
  }
}

/**
 * 拼 Gemini 的 generateContent 地址。
 *
 * 官方 REST 形态是 **`{base}/models/{model}:generateContent`**：
 *
 * ```
 * https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash:generateContent
 * ```
 *
 * 之前这里只拼了 `{base}:generateContent`，**把 `/models/{model}` 整段漏掉**，
 * 于是拉取模型列表（`/v1beta/models`，拼得对）正常，但一调用就 404——
 * 那个 URL 根本不存在，服务端当然找不到。
 *
 * 要处理三种 base_url 写法：
 * 1. 常规：`https://host/v1beta` → 补 `/models/{model}:generateContent`
 * 2. 用户已经把模型写进去：`.../v1beta/models/gemini-3-flash` → 只补方法后缀
 * 3. 用户把整个端点写进去：`.../models/gemini-3-flash:generateContent` → 原样用
 *
 * 模型名要剥掉可能带的 `models/` 前缀（列表接口返回的是 `models/xxx`，
 * 用户复制粘贴时也会带），否则会拼出 `/models/models/xxx`。
 */
function generateContentUrl(baseUrl: string, modelName: string, stream: boolean): string {
  const url = new URL(baseUrl.trim())
  // 先分离路径与查询串，再切换端点，避免把方法后缀拼进 key 等参数里。
  let path = url.pathname.replace(/\/+$/, '').replace(/:(?:streamGenerateContent|generateContent)$/, '')
  if (!/\/models\/[^/]+$/.test(path)) {
    const model = modelName.trim().replace(/^models\//, '')
    path += `/models/${model}`
  }
  url.pathname = `${path}:${stream ? 'streamGenerateContent' : 'generateContent'}`
  if (stream) url.searchParams.set('alt', 'sse')
  else if (url.searchParams.get('alt') === 'sse') url.searchParams.delete('alt')
  return url.toString()
}

function buildListModels(provider: ProviderConfig): BuiltRequest {
  const headers: Record<string, string> = { accept: 'application/json' }
  applyHeaders(headers, provider.headers)
  if (provider.api_key) headers['x-goog-api-key'] = provider.api_key
  const base = provider.base_url.replace(/\/+$/, '')
  // Gemini 的模型列表在 /models（v1beta），带 generateContent 端点时退回上一级
  let path = base
  // 查询串/片段不属于路径，先切掉（旧实现把 `?` 写成了 `?te`，等于从不处理 `?`）
  const splitAt = path.search(/[?#]/)
  if (splitAt >= 0) path = path.slice(0, splitAt)
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
