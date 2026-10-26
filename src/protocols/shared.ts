import type { FinishReason, Usage } from '../contract.js'
import { asNumber, isRecord } from '../json.js'

/** 去掉尾部斜杠；如果用户已经写到了具体端点，就不再重复拼 */
export function endpointUrl(baseUrl: string, endpoint: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '')
  if (base.endsWith(endpoint)) return base
  const query = base.indexOf('?')
  if (query >= 0) {
    const path = base.slice(0, query)
    if (path.endsWith(endpoint)) return base
    return `${path}${endpoint}${base.slice(query)}`
  }
  return `${base}${endpoint}`
}

/** 拉模型列表用：如果 base_url 写到了 chat 端点，退回到它的上一级 */
export function modelsUrl(baseUrl: string): string {
  let base = baseUrl.trim().replace(/\/+$/, '')
  for (const suffix of ['/chat/completions', '/messages']) {
    if (base.endsWith(suffix)) base = base.slice(0, -suffix.length)
  }
  return `${base}/models`
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
  // Anthropic 的 message_delta.usage 是累计值，不是增量；用最新值覆盖，再重算 total
  const input = next.input_tokens ?? previous.input_tokens
  const output = next.output_tokens ?? previous.output_tokens
  const total =
    next.total_tokens ??
    (input !== undefined || output !== undefined ? (input ?? 0) + (output ?? 0) : previous.total_tokens)
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
