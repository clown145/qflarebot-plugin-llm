import type { LLMErrorCode } from './contract.js'
import { isAbortError, LLMError } from './errors.js'
import { parseRetryAfter, readTextLimited, redact, redactAll, safeDetail, truncate } from './http.js'
import { isRecord } from './json.js'

export interface UpstreamContext {
  provider: string
  alias: string
  apiKey?: string
  /** 所有需要脱敏的凭据（apiKey + 自定义请求头里的值），供错误消息精确替换 */
  secrets?: ReadonlyArray<string>
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
  let text = ''
  try {
    text = await readTextLimited(response, 8192)
  } catch (err) {
    // 读错误体期间连接被掐（常因超时/取消）：保留归因，别吞成状态码错误
    if (isAbortError(err)) throw fetchError(err, ctx, false, false)
    text = ''
  }
  let body: unknown = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = null
  }
  const message = messageFrom(body) || text
  // safeDetail = 截断 + 精确值替换 + 凭据形态模式匹配；上游常把 key 截断/拼进 Bearer 里回显
  const detail = safeDetail(message, secretList(ctx), 400)
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
/** apiKey + 自定义请求头里的所有凭据；保底塞一个 undefined，保证 pattern 匹配那一趟始终执行 */
function secretList(ctx: UpstreamContext): ReadonlyArray<string | undefined> {
  const list: (string | undefined)[] = []
  if (ctx.apiKey) list.push(ctx.apiKey)
  for (const secret of ctx.secrets ?? []) {
    if (secret) list.push(secret)
  }
  if (list.length === 0) list.push(undefined)
  return list
}

export function streamError(error: unknown, ctx: UpstreamContext): LLMError {
  const record = isRecord(error) ? error : {}
  const type = typeof record['type'] === 'string' ? record['type'] : ''
  // code 可能是字符串（OpenRouter "insufficient_quota"）或数值（Gemini 401/429/500）；
  // 数值直接按 HTTP 状态语义映射，字符串继续走子串匹配
  const rawCode = record['code']
  const code = typeof rawCode === 'string' ? rawCode : typeof rawCode === 'number' && Number.isFinite(rawCode) ? codeForStatus(rawCode) : ''
  const message = typeof record['message'] === 'string' ? record['message'] : ''
  const mapped = codeForStream(type || code)
  const detail = safeDetail(message || type || (typeof rawCode === 'string' || typeof rawCode === 'number' ? String(rawCode) : '') || '上游流式返回错误', secretList(ctx), 400)
  return new LLMError(mapped, detail, {
    provider: ctx.provider,
    alias: ctx.alias,
    ...(type || rawCode !== undefined ? { detail: type || String(rawCode) } : {}),
  })
}

/** 数值型 code 按 HTTP 状态同义处理：401/403 → auth、429 → rate_limit、5xx → upstream、其余 → bad_request */
function codeForStatus(status: number): string {
  if (status === 401 || status === 403) return 'invalid_api_key'
  if (status === 429) return 'rate_limit'
  if (status >= 500) return 'internal'
  return 'invalid_request'
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
  // 精确替换所有凭据（apiKey 与自定义请求头的值）：network 分支过去只用模式匹配，
  // 自建网关任意格式的 key（如 base_url?key=…）会被裸露在错误消息里
  return new LLMError('network', `连接上游失败：${truncate(redactAll(err instanceof Error ? err.message : String(err), secretList(ctx)), 200)}`, {
    provider: ctx.provider,
    alias: ctx.alias,
    cause: err,
  })
}
