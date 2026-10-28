import type { ContentPart, FinishReason, MessageContent, Usage } from '../contract.js'
import { asNumber, isRecord } from '../json.js'

/** 去掉尾部斜杠；如果用户已经写到了具体端点，就不再重复拼。`?` 与 `#` 之后的部分原样保留 */
export function endpointUrl(baseUrl: string, endpoint: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '')
  if (base.endsWith(endpoint)) return base
  // 与 modelsUrl 一致：fragment（#）同 query（?）一样不属于路径，端点要拼在它前面
  const split = base.search(/[?#]/)
  if (split >= 0) {
    const path = base.slice(0, split).replace(/\/+$/, '')
    const suffix = base.slice(split)
    if (path.endsWith(endpoint)) return base
    return `${path}${endpoint}${suffix}`
  }
  return `${base}${endpoint}`
}

/** 非文本片段的 url：`data` + `media_type` 拼成 data URI；只有 url 时原样返回 */
export function partUrl(part: Exclude<ContentPart, { type: 'text' }>): string {
  if (part.url) return part.url
  if (!part.data) return ''
  const mediaType = part.media_type ?? 'application/octet-stream'
  return `data:${mediaType};base64,${part.data}`
}

/** 把消息内容统一成片段数组；字符串视为单个 text 片段（空字符串得到空数组） */
export function toParts(content: MessageContent | undefined): ContentPart[] {
  if (content === undefined) return []
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : []
  return content
}

/** 内容里所有 text 片段拼起来的纯文本 */
export function textOf(content: MessageContent | undefined): string {
  if (content === undefined) return ''
  if (typeof content === 'string') return content
  return content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('')
}

/** 拉模型列表用：如果 base_url 写到了 chat 端点，退回到它的上一级 */
export function modelsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim()
  let splitAt = -1
  for (const mark of ['?', '#']) {
    const at = trimmed.indexOf(mark)
    if (at >= 0 && (splitAt < 0 || at < splitAt)) splitAt = at
  }
  let path = splitAt >= 0 ? trimmed.slice(0, splitAt) : trimmed
  const suffix = splitAt >= 0 ? trimmed.slice(splitAt) : ''
  path = path.replace(/\/+$/, '')
  for (const endpoint of ['/chat/completions', '/messages']) {
    if (path.endsWith(endpoint)) {
      path = path.slice(0, -endpoint.length)
      break
    }
  }
  return `${path}/models${suffix}`
}

export function openAIUsage(raw: unknown): Usage | undefined {
  if (!isRecord(raw)) return undefined
  const usage: Usage = {}
  const input = asNumber(raw['prompt_tokens'])
  const output = asNumber(raw['completion_tokens'])
  const total = asNumber(raw['total_tokens'])
  if (input !== undefined) usage.input_tokens = input
  if (output !== undefined) usage.output_tokens = output
  if (total !== undefined) usage.total_tokens = total
  return Object.keys(usage).length ? usage : undefined
}

export function anthropicUsage(raw: unknown): Usage | undefined {
  if (!isRecord(raw)) return undefined
  const input = asNumber(raw['input_tokens'])
  const output = asNumber(raw['output_tokens'])
  const usage: Usage = {}
  if (input !== undefined) usage.input_tokens = input
  if (output !== undefined) usage.output_tokens = output
  if (input !== undefined || output !== undefined) usage.total_tokens = (input ?? 0) + (output ?? 0)
  return Object.keys(usage).length ? usage : undefined
}

export function mergeUsage(previous: Usage | undefined, next: Usage | undefined): Usage | undefined {
  if (!previous) return next
  if (!next) return previous
  // Anthropic 的 message_delta.usage 是**累计值**，不是增量；而且它给的 total 只覆盖本次 delta
  // （message_start 给 input，message_delta 只带 output）。所以不能信 next.total_tokens——
  // 信了就会把 {input:2, output:3} 算成 total 3。统一用合并后的 input+output 重算。
  const input = next.input_tokens ?? previous.input_tokens
  const output = next.output_tokens ?? previous.output_tokens
  const total = input !== undefined || output !== undefined ? (input ?? 0) + (output ?? 0) : previous.total_tokens
  return {
    ...(input !== undefined ? { input_tokens: input } : {}),
    ...(output !== undefined ? { output_tokens: output } : {}),
    ...(total !== undefined ? { total_tokens: total } : {}),
  }
}

export function openAIFinish(reason: unknown): FinishReason | undefined {
  switch (reason) {
    case 'stop':
      return 'stop'
    case 'length':
      return 'length'
    case 'tool_calls':
    case 'function_call':
      return 'tool_calls'
    case 'content_filter':
      return 'content_filter'
    case undefined:
    case null:
      return undefined
    default:
      return typeof reason === 'string' ? 'other' : undefined
  }
}

export function anthropicFinish(reason: unknown): FinishReason | undefined {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop'
    case 'max_tokens':
      return 'length'
    case 'tool_use':
      return 'tool_calls'
    case undefined:
    case null:
      return undefined
    default:
      return 'other'
  }
}
