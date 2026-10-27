import type { LLMErrorCode } from './contract.js'
import { LLMError } from './errors.js'
import { parseRetryAfter, readTextLimited, redact, safeDetail, truncate } from './http.js'
import { isRecord } from './json.js'

export interface UpstreamContext {
  provider: string
  alias: string
  apiKey?: string
  timeoutMs: number
}

function codeFor(status: number): LLMErrorCode {
  if (status === 401 || status === 403) return 'auth'
  if (status === 429) return 'rate_limit'
  if (status === 400 || status === 404 || status === 409 || status === 422) return 'bad_request'
  return 'upstream'
}

function hintFor(status: number): string {
  if (status === 401 || status === 403) return '，请检查 API Key'
  if (status === 404) return '，请检查接口地址与模型名'
  if (status === 429) return '，请稍后重试或检查配额'
  if (status >= 500) return '，上游暂时不可用'
  return ''
}

function messageFrom(body: unknown): string {
  if (!isRecord(body)) return ''
  const error = isRecord(body['error']) ? body['error'] : undefined
  if (error) {
    const text = error['message']
    if (typeof text === 'string') return text
  }
  const direct = body['message']
  return typeof direct === 'string' ? direct : ''
}

/** 把上游错误压成短消息；detail 里已经脱敏，日志和返回值都不会带 key */
export async function upstreamError(response: Response, ctx: UpstreamContext): Promise<LLMError> {
  const text = await readTextLimited(response, 8192).catch(() => '')
  let body: unknown = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = null
  }
  const message = messageFrom(body) || text
  // safeDetail = 截断 + 精确值替换 + 凭据形态模式匹配；上游常把 key 截断/拼进 Bearer 里回显
  const detail = safeDetail(message, [ctx.apiKey], 400)
  const code = codeFor(response.status)
  const prefix = code === 'auth' ? '认证失败' : code === 'rate_limit' ? '被上游限流' : '上游返回错误'
  return new LLMError(code, `${prefix}（HTTP ${response.status}）${detail ? `：${detail}` : ''}${hintFor(response.status)}`, {
    provider: ctx.provider,
    alias: ctx.alias,
    status: response.status,
    ...(detail ? { detail } : {}),
  })
}

/**
 * 把流内的 `{"error":…}` 映射成 LLMError。
 *
 * OpenAI 兼容网关（OpenRouter、各类中转、vLLM）经常在 **HTTP 200 的 SSE 流里**下发错误，
 * 而不是用 4xx；旧实现忽略这些事件，最后误报成「上游没有返回内容」，真实原因（配额、鉴权、
 * 内容策略）全被吞掉。
 */
export function streamError(error: unknown, ctx: UpstreamContext): LLMError {
  const record = isRecord(error) ? error : {}
  const type = typeof record['type'] === 'string' ? record['type'] : ''
  const code = typeof record['code'] === 'string' ? record['code'] : ''
  const message = typeof record['message'] === 'string' ? record['message'] : ''
  const mapped = codeForStream(type || code)
  const detail = safeDetail(message || type || code || '上游流式返回错误', [ctx.apiKey], 400)
  return new LLMError(mapped, detail, {
    provider: ctx.provider,
    alias: ctx.alias,
    ...(type || code ? { detail: type || code } : {}),
  })
}

function codeForStream(value: string): LLMErrorCode {
  const lower = value.toLowerCase()
  if (lower.includes('auth') || lower.includes('permission') || lower.includes('invalid_api_key')) return 'auth'
  if (lower.includes('rate') || lower.includes('quota') || lower.includes('limit')) return 'rate_limit'
  if (lower.includes('invalid') || lower.includes('not_found') || lower.includes('too_large')) return 'bad_request'
  if (lower.includes('timeout')) return 'timeout'
  return 'upstream'
}

export function shouldRetryStatus(status: number): boolean {
  return status === 429 || status >= 500
}

/** 优先听 Retry-After；留 1 秒给下一次尝试，避免把超时预算耗在退避上 */
export function retryDelay(retryAfter: string | null, attempt: number, remainingMs: number): number {
  const base = parseRetryAfter(retryAfter) ?? Math.min(2000, 300 * 2 ** attempt)
  const jitter = Math.floor(Math.random() * 150)
  return Math.max(0, Math.min(base + jitter, remainingMs - 1000))
}

export function fetchError(err: unknown, ctx: UpstreamContext, timedOut: boolean, parentAborted: boolean): LLMError {
  if (parentAborted) {
    return new LLMError('aborted', '调用已取消', { provider: ctx.provider, alias: ctx.alias, cause: err })
  }
  if (timedOut) {
    return new LLMError('timeout', `上游响应超时（${ctx.timeoutMs}ms）`, {
      provider: ctx.provider,
      alias: ctx.alias,
      cause: err,
    })
  }
  return new LLMError('network', `连接上游失败：${truncate(redact(err instanceof Error ? err.message : String(err)), 200)}`, {
    provider: ctx.provider,
    alias: ctx.alias,
    cause: err,
  })
}
