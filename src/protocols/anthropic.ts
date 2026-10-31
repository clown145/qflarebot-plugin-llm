import type { ChatMessage, ChatRequest, MessageContent, ReasoningSignature, ToolCall, ToolChoice } from '../contract.js'
import type { ProviderConfig } from '../config/types.js'
import { LLMError } from '../errors.js'
import { asArray, asNumber, asString, isRecord } from '../json.js'
import { readSSE } from '../sse.js'
import { streamError, type UpstreamContext } from '../upstream.js'
import type { BuildHooks, BuiltRequest, ParsedResponse, ParsedStreamEvent, ProtocolAdapter, StreamContext, Target } from './types.js'
import {
  anthropicFinish,
  anthropicUsage,
  endpointUrl,
  modelsUrl,
  partUrl,
  textOf,
  toParts,
} from './shared.js'
import * as thinking from './thinking.js'

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

/**
 * 思考 block。**必须与签名成对回传**：多轮工具调用时，assistant 的 `content`
 * 必须以 `thinking` / `redacted_thinking` 打头，否则上游直接
 *
 * ```
 * 400 messages.1.content.0.type: Expected `thinking` or `redacted_thinking`, but found `tool_use`
 * ```
 *
 * `redacted_thinking` 是上游加密后的思考内容，插件无法解读，只能原样保留。
 */
type ThinkingBlock =
  | { type: 'thinking'; thinking: string; signature: string }
  | { type: 'redacted_thinking'; data: string }

interface ToolResultBlock {
  type: 'tool_result'
  tool_use_id: string
  content: string | Array<Record<string, unknown>>
  is_error?: boolean
}

type Block = TextBlock | ImageBlock | DocumentBlock | ToolUseBlock | ThinkingBlock | ToolResultBlock

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

/** 解析 `data:<media_type>;base64,<payload>` 形态的 URI；非该形态返回 undefined */
function parseDataUri(url: string): { mediaType: string; data: string } | undefined {
  if (!url.startsWith('data:')) return undefined
  const comma = url.indexOf(',')
  if (comma < 0) return undefined
  const meta = url.slice(5, comma)
  const payload = url.slice(comma + 1)
  // 只拆 base64 形态；percent-encoded 的非 base64 data URI 不支持，让调用方改用 data 片段
  if (!meta.endsWith(';base64')) return undefined
  const mediaType = meta.slice(0, -';base64'.length) || 'application/octet-stream'
  if (!/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(mediaType)) return undefined
  return { mediaType, data: payload }
}

/**
 * base64 source（`data` + `media_type`）或 url source；两者都没有时抛 bad_request。
 * `url` 里的 `data:` URI 会拆回 base64 source——Anthropic 的 url source 只接受 https，
 * 原样透传会直接 invalid_request_error（OpenAI 端 image_url.url 接受 data URI，两家行为不能分叉）。
 */
function mediaSource(part: { url?: string; data?: string; media_type?: string }, where: string): Record<string, unknown> {
  if (part.data) {
    return {
      type: 'base64',
      media_type: part.media_type ?? 'application/octet-stream',
      data: part.data,
    }
  }
  if (part.url) {
    const dataUri = parseDataUri(part.url)
    if (dataUri) {
      return {
        type: 'base64',
        media_type: part.media_type ?? dataUri.mediaType,
        data: dataUri.data,
      }
    }
    return { type: 'url', url: part.url }
  }
  throw new LLMError('bad_request', `${where} 缺少 url 或 data`)
}

/** 把契约里的内容片段转成 Anthropic block；audio 明确不支持 */
function contentBlocks(content: MessageContent | undefined, where: string): Block[] {
  if (content === undefined) return []
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : []
  return toParts(content).map((part) => {
    if (part.type === 'text') return { type: 'text', text: part.text }
    if (part.type === 'image') return { type: 'image', source: mediaSource(part, `${where} 的图片片段`) }
    if (part.type === 'file') {
      // document block 的 title 承载文件名；不传也能工作，传了上游展示更友好
      const block: Record<string, unknown> = { type: 'document', source: mediaSource(part, `${where} 的文件片段`) }
      if (part.filename) block['title'] = part.filename
      return block as unknown as Block
    }
    throw new LLMError('unsupported', 'Anthropic 协议不支持音频输入')
  })
}

/**
 * assistant 的 `reasoning_signatures` → thinking block，**按 part_index 排好且放在最前面**。
 *
 * 顺序是上游的硬约束：thinking / redacted_thinking 必须排在正文与 `tool_use` 之前。
 * 回传的签名如果缺正文或缺 data（调用方没存全），那一条**宁可丢掉**：
 * 发一个残缺的 thinking block 只会让上游 400，丢一条只会让模型少看到自己的旧思考。
 */
function thinkingBlocks(signatures: ReasoningSignature[] | undefined): ThinkingBlock[] {
  if (!signatures?.length) return []
  const indexed = signatures
    .map((item, index) => ({ item, index }))
    // part_index 决定回传顺序；缺失或重复时按数组顺序兜底（稳定排序）
    .sort((left, right) => {
      const a = Number.isFinite(left.item.part_index) ? left.item.part_index : left.index
      const b = Number.isFinite(right.item.part_index) ? right.item.part_index : right.index
      return a === b ? left.index - right.index : a - b
    })
  const out: ThinkingBlock[] = []
  for (const { item } of indexed) {
    if (item.block_type === 'redacted_thinking') {
      if (item.data) out.push({ type: 'redacted_thinking', data: item.data })
      continue
    }
    if (item.thinking !== undefined && item.signature) {
      out.push({ type: 'thinking', thinking: item.thinking, signature: item.signature })
    }
  }
  return out
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
      // 思考 block 必须打头，且只有带签名的才发得出去（旧实现完全丢弃 → 多轮工具调用必 400）
      const blocks: Block[] = [...thinkingBlocks(message.reasoning_signatures)]
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
 *
 * **开启 extended thinking 时只支持 `auto` / `none`**：`any`（= required）与
 * `tool`（= 指定工具）都会被上游拒绝：
 *
 * ```
 * 400 thinking may not be enabled when tool_choice forces tool use
 * ```
 *
 * 于是降级成 `auto` 并交回给调用方决定（见 `buildChat` 里的 warn 日志）。
 */
function mapToolChoice(choice: ToolChoice, thinkingOn: boolean): { value: unknown | undefined; downgraded: boolean } {
  if (choice === 'none') return { value: undefined, downgraded: false }
  if (choice === 'auto') return { value: { type: 'auto' }, downgraded: false }
  if (thinkingOn) {
    // required / {name} 都与思考互斥，降级为 auto（工具仍然可用，只是不强制）
    return { value: { type: 'auto' }, downgraded: true }
  }
  if (choice === 'required') return { value: { type: 'any' }, downgraded: false }
  return { value: { type: 'tool', name: choice.name }, downgraded: false }
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

/**
 * 思考开启时 `temperature` / `top_p` 的可用区间。
 *
 * Anthropic 对 extended thinking 有**硬约束**：
 *
 * - `temperature` 只能为 1（不传等价于 1）；发 0 或 0.7 直接
 *   `400 temperature: 1 is the only temperature supported when thinking is enabled`
 * - `top_p` 只能在 0.95–1 之间（不传等价于 1）；发 0.9 直接
 *   `400 top_p must be in [0.95, 1] when thinking is enabled`
 *
 * 页面/模型配置会**自动**给请求填 temperature（`service.prepare`），`ping()` 更是
 * 硬编码 0，所以这里必须做丢弃而不是期望调用方自己知道。
 */
const THINKING_TEMPERATURE = 1
const THINKING_TOP_P_MIN = 0.95

/**
 * Anthropic 会把上游拒绝的 `tool_choice` 降级这件事交给调用方看一眼。
 *
 * 适配器是纯函数（不持有 logger），所以用「可选回调」把 warn 抛到装配层，
 * 由 `service.ts` 用 ctx.logger 落地；测试里也能直接收集。
 */
function buildChat(target: Target, request: ChatRequest, stream: boolean, hooks: BuildHooks = {}): BuiltRequest {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: stream ? 'text/event-stream' : 'application/json',
    'anthropic-version': VERSION,
  }
  applyHeaders(headers, target.provider.headers)
  if (target.provider.api_key) headers['x-api-key'] = target.provider.api_key

  const mapped = mapMessages(request.messages)
  // 思考等级：Anthropic 用 `thinking.budget_tokens` 表达，没有等级枚举。
  const effort = thinking.effectiveEffort(request, target.model)
  // max_tokens 必填：请求值 → 模型配置的输出上限 → 兜底 4096（旧实现的 1024 会静默截断长回答）
  const requestedMaxTokens = request.max_tokens ?? target.model.max_output_tokens ?? DEFAULT_MAX_TOKENS
  // **思考预算必须和 `max_tokens`、模型的输出上限一起算。**
  //
  // 旧实现无条件把 max_tokens 抬到预算的两倍：`high` → 16384，直接撞上
  // claude-3-5-sonnet 的 8192 输出上限（400 invalid_request_error）。
  // planAnthropicOutput 保证 budget ≥ 1024、budget < max_tokens、正文有余量，
  // 且不超过模型的 max_output_tokens；真放不下就连思考一起放弃。
  const plan = thinking.planAnthropicOutput({
    effort,
    requestedMaxTokens,
    outputCap: target.model.max_output_tokens,
  })
  const body: Record<string, unknown> = {
    ...(request.extra_body ?? {}),
    model: target.model.model,
    max_tokens: plan.maxTokens,
    messages: mapped.messages,
  }
  // 调用方自己通过 extra_body 传了 thinking 就以它为准；否则用等级翻译出来的值。
  // **但「优先」不等于可以发一个必 400 的组合**：budget_tokens 必须严格小于 max_tokens。
  // 调用方给了更大的预算时把 max_tokens 抬上去；模型的输出上限都放不下就放弃它并告警。
  const callerThinking = body['thinking']
  if (callerThinking !== undefined) {
    const budget = isRecord(callerThinking) ? asNumber(callerThinking['budget_tokens']) : undefined
    if (budget !== undefined) {
      const fitted = thinking.maxTokensForBudget({
        requestedMaxTokens: plan.maxTokens,
        budget,
        outputCap: target.model.max_output_tokens,
      })
      if (fitted.fits) {
        body['max_tokens'] = fitted.maxTokens
      } else {
        delete body['thinking']
        hooks.warn?.('调用方指定的 thinking 预算超过模型输出上限，本次不发送 thinking', {
          budget_tokens: budget,
          max_tokens: fitted.maxTokens,
          model: target.model.model,
        })
      }
    }
  } else if (plan.thinking) {
    body['thinking'] = plan.thinking
  }
  const thinkingOn = body['thinking'] !== undefined
  if (mapped.system) body['system'] = mapped.system
  // **开了思考时 temperature / top_p 有硬约束**（见上面的注释）：
  // 不合法的值一律丢弃（= 让上游用默认值 1），而不是原样发出去吃 400。
  if (request.temperature !== undefined) {
    if (!thinkingOn) {
      body['temperature'] = request.temperature
    } else if (request.temperature === THINKING_TEMPERATURE) {
      // 等于 1 是允许的，原样带上（有些网关要求字段必须存在）
      body['temperature'] = request.temperature
    }
  }
  if (request.top_p !== undefined) {
    if (!thinkingOn) {
      body['top_p'] = request.top_p
    } else if (request.top_p >= THINKING_TOP_P_MIN && request.top_p <= 1) {
      body['top_p'] = request.top_p
    }
  }
  if (request.stop !== undefined) {
    body['stop_sequences'] = Array.isArray(request.stop) ? request.stop : [request.stop]
  }
  // tool_choice: 'none' 表示调用方不要工具 → 连 tools 都不发（Anthropic 没有 none 类型）
  const mappedChoice = request.tool_choice ? mapToolChoice(request.tool_choice, thinkingOn) : undefined
  const toolChoice = mappedChoice?.value
  const sendTools = Boolean(request.tools?.length) && request.tool_choice !== 'none'
  if (sendTools) {
    body['tools'] = request.tools!.map((tool) => ({
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      input_schema: tool.parameters,
    }))
    if (toolChoice !== undefined) body['tool_choice'] = toolChoice
    if (mappedChoice?.downgraded) {
      hooks.warn?.('Anthropic 开启思考时不支持强制工具调用，tool_choice 已降级为 auto', {
        tool_choice: request.tool_choice,
        model: target.model.model,
      })
    }
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
  const signatures: ReasoningSignature[] = []
  // 回传时重建顺序固定为「推理 block 在前、正文在后、tool_use 最后」，
  // 所以签名里的 part_index 按「推理 block 在重建数组里的下标」记（从 0 开始连续）。
  let signatureIndex = 0
  for (const block of content) {
    if (!isRecord(block)) continue
    if (block['type'] === 'text') {
      text += asString(block['text'])
    } else if (block['type'] === 'thinking') {
      // **思考正文与签名必须成对回传**：多轮工具调用时缺签名上游直接 400
      //   Expected `thinking` or `redacted_thinking`, but found `tool_use`
      // 旧实现只留正文、把签名丢掉，于是 assistant 的 tool_use 永远发不出合法请求。
      const body = asString(block['thinking'])
      const signature = asString(block['signature'])
      reasoning += body
      if (signature) {
        signatures.push({ part_index: signatureIndex, block_type: 'thinking', thinking: body, signature })
        signatureIndex += 1
      }
    } else if (block['type'] === 'redacted_thinking') {
      // 上游加密过的思考内容：插件读不懂，只能原样保留并回传
      const data = asString(block['data'])
      if (data) {
        signatures.push({ part_index: signatureIndex, block_type: 'redacted_thinking', data })
        signatureIndex += 1
      }
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
    ...(signatures.length ? { reasoningSignatures: signatures } : {}),
    ...(toolCalls.length ? { toolCalls } : {}),
    ...(finishReason ? { finishReason } : {}),
    ...(usage ? { usage } : {}),
  }
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
  // Anthropic 的 content block 序号是「文本块/工具块共用」的索引（text 块=0、tool_use 块=1），
  // 不等于下游 tool_call_delta 的紧凑序号。这里按 block index 映射成连续的工具槽位，
  // 避免调用方拿 index 当下标累积时错位（contract.ts 中 index 只是分组键）。
  const toolSlotByBlock = new Map<number, number>()
  let nextToolSlot = 0
  const toolSlotFor = (blockIndex: number | undefined): number => {
    const up = blockIndex ?? 0
    let s = toolSlotByBlock.get(up)
    if (s === undefined) {
      s = nextToolSlot++
      toolSlotByBlock.set(up, s)
    }
    return s
  }
  // 流式下 thinking block 分两步到达：`thinking_delta` 给正文、`signature_delta` 给签名，
  // 两者都齐了才在 `content_block_stop` 一次性产出 `reasoning_signature`
  // （正文与签名必须成对，调用方才能在下一轮原样回传）。
  const thinkingByBlock = new Map<number, string>()
  const signatureByBlock = new Map<number, string>()
  let nextSignatureIndex = 0
  for await (const message of readSSE(body)) {
    // 空 data 帧是合法心跳（`data:` 后直接空行），JSON.parse('') 会抛错
    if (!message.data.trim()) continue
    let json: unknown
    try {
      json = JSON.parse(message.data)
    } catch {
      throw new Error('上游流式数据不是合法 JSON')
    }
    if (!isRecord(json)) continue
    const event = message.event ?? asString(json['type'])
    const blockIndex = asNumber(json['index'])

    if (event === 'message_start') {
      const start = isRecord(json['message']) ? json['message'] : {}
      const next = anthropicUsage(start['usage'])
      if (next) yield { type: 'usage', usage: next }
      continue
    }

    if (event === 'content_block_start') {
      const block = isRecord(json['content_block']) ? json['content_block'] : {}
      if (block['type'] === 'tool_use') {
        const index = toolSlotFor(blockIndex)
        const id = asString(block['id'])
        const name = asString(block['name'])
        yield { type: 'tool_call_delta', index, ...(id ? { id } : {}), ...(name ? { name } : {}) }
      } else if (block['type'] === 'redacted_thinking') {
        // 加密思考块不增量下发，开始就能拿全
        const data = asString(block['data'])
        if (data) {
          yield { type: 'reasoning_signature', part_index: nextSignatureIndex, block_type: 'redacted_thinking', data }
          nextSignatureIndex += 1
        }
      }
      continue
    }

    if (event === 'content_block_delta') {
      const delta = isRecord(json['delta']) ? json['delta'] : {}
      const index = blockIndex ?? 0
      if (delta['type'] === 'text_delta') {
        const text = asString(delta['text'])
        if (text) yield { type: 'text_delta', text }
      } else if (delta['type'] === 'thinking_delta') {
        const thinking = asString(delta['thinking'])
        if (thinking) {
          thinkingByBlock.set(index, (thinkingByBlock.get(index) ?? '') + thinking)
          yield { type: 'reasoning_delta', text: thinking }
        }
      } else if (delta['type'] === 'signature_delta') {
        const signature = asString(delta['signature'])
        if (signature) signatureByBlock.set(index, (signatureByBlock.get(index) ?? '') + signature)
      } else if (delta['type'] === 'input_json_delta') {
        const partial = asString(delta['partial_json'])
        if (partial) yield { type: 'tool_call_delta', index: toolSlotFor(index), argumentsDelta: partial }
      }
      continue
    }

    if (event === 'content_block_stop') {
      const index = blockIndex ?? 0
      const signature = signatureByBlock.get(index)
      if (signature) {
        yield {
          type: 'reasoning_signature',
          part_index: nextSignatureIndex,
          block_type: 'thinking',
          // 正文可能为空（上游只回签名），照实传空串，调用方回传时同样要带上
          thinking: thinkingByBlock.get(index) ?? '',
          signature,
        }
        nextSignatureIndex += 1
      }
      thinkingByBlock.delete(index)
      signatureByBlock.delete(index)
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
