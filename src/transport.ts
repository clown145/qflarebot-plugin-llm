import type { Logger } from '@qqbot/sdk'
import { LLMError, errorMessage } from './errors.js'
import { createAbortHandle, readJsonLimited, sleep, type AbortHandle } from './http.js'
import { LIMITS } from './config/types.js'
import type { BuiltRequest } from './protocols/types.js'
import { fetchError, retryDelay, shouldRetryStatus, upstreamError, type UpstreamContext } from './upstream.js'

/** 非流式响应体上限；再大基本是上游故障，按 §9 的 CPU/内存预算不值得整个读进来 */
export const MAX_RESPONSE_BYTES = LIMITS.response_max_bytes

export interface TransportOptions {
  fetch: typeof fetch
  logger: Logger
  context: UpstreamContext
  timeoutMs: number
  maxRetries: number
  signal?: AbortSignal
}

/** 退避等待时用来判断「这次失败算超时还是调用方取消」的来源 */
interface AbortState {
  timedOut(): boolean
  parentAborted(): boolean
}

function logRetry(options: TransportOptions, attempt: number, status: number | undefined, delay: number): void {
  options.logger.warn('llm.retry', {
    provider: options.context.provider,
    alias: options.context.alias,
    attempt: attempt + 1,
    ...(status !== undefined ? { status } : {}),
    delay_ms: delay,
  })
}

function timeout(options: TransportOptions): LLMError {
  return new LLMError('timeout', `上游响应超时（${options.timeoutMs}ms）`, {
    provider: options.context.provider,
    alias: options.context.alias,
  })
}

/**
 * 退避等待。取消必须映射成 LLMError('aborted')，不能把原始 DOMException 漏给调用方：
 * README 约定跨插件读 `err.code`，而 DOMException 的 code 是数字 20，调用方识别不出来。
 * `sleep()` 会 reject，所以这里必须自己 catch 再映射——旧实现把它放在 catch 块里，
 * 异常直接穿透出了 fetchJson/openStream。
 */
async function backoff(delay: number, options: TransportOptions, state: AbortState): Promise<void> {
  try {
    await sleep(delay, options.signal)
  } catch (err) {
    throw fetchError(err, options.context, state.timedOut(), state.parentAborted())
  }
}

/** 非流式：读完 JSON 才返回；重试只发生在拿到响应之前 */
export async function fetchJson(built: BuiltRequest, options: TransportOptions): Promise<unknown> {
  const deadline = Date.now() + options.timeoutMs
  for (let attempt = 0; ; attempt += 1) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw timeout(options)
    const handle = createAbortHandle(remaining, options.signal)
    try {
      const fetchImpl = options.fetch
      const response = await fetchImpl(built.url, { ...built.init, signal: handle.signal })
      if (!response.ok) {
        const error = await upstreamError(response, options.context)
        if (attempt < options.maxRetries && shouldRetryStatus(response.status) && deadline - Date.now() > 1500) {
          const delay = retryDelay(response.headers.get('retry-after'), attempt, deadline - Date.now())
          logRetry(options, attempt, response.status, delay)
          await backoff(delay, options, handle)
          continue
        }
        throw error
      }
      try {
        return await readJsonLimited(response, MAX_RESPONSE_BYTES)
      } catch (err) {
        if (handle.timedOut() || handle.parentAborted()) {
          throw fetchError(err, options.context, handle.timedOut(), handle.parentAborted())
        }
        throw new LLMError('bad_response', `读取上游响应失败：${errorMessage(err)}`, {
          provider: options.context.provider,
          alias: options.context.alias,
          cause: err,
        })
      }
    } catch (err) {
      if (err instanceof LLMError) throw err
      const mapped = fetchError(err, options.context, handle.timedOut(), handle.parentAborted())
      if (mapped.code === 'network' && attempt < options.maxRetries && deadline - Date.now() > 1500) {
        const delay = retryDelay(null, attempt, deadline - Date.now())
        logRetry(options, attempt, undefined, delay)
        await backoff(delay, options, handle)
        continue
      }
      throw mapped
    } finally {
      handle.cleanup()
    }
  }
}

/** 流式：拿到 2xx 就把 response 与仍在计时的 handle 交给调用方，读完再 cleanup/abort */
export async function openStream(
  built: BuiltRequest,
  options: TransportOptions,
): Promise<{ response: Response; handle: AbortHandle }> {
  const deadline = Date.now() + options.timeoutMs
  for (let attempt = 0; ; attempt += 1) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw timeout(options)
    const handle = createAbortHandle(remaining, options.signal)
    // 成功拿到 2xx 时把 handle 交给调用方，其余路径一律在这里收尾，避免定时器泄漏
    let handedOff = false
    try {
      const fetchImpl = options.fetch
      const response = await fetchImpl(built.url, { ...built.init, signal: handle.signal })
      if (!response.ok) {
        const error = await upstreamError(response, options.context)
        if (attempt < options.maxRetries && shouldRetryStatus(response.status) && deadline - Date.now() > 1500) {
          const delay = retryDelay(response.headers.get('retry-after'), attempt, deadline - Date.now())
          logRetry(options, attempt, response.status, delay)
          // 退避期间 handle 仍然活着，取消才会被映射成 aborted 而不是原始 DOMException
          await backoff(delay, options, handle)
          continue
        }
        throw error
      }
      if (!response.body) {
        throw new LLMError('bad_response', '上游没有返回响应体', {
          provider: options.context.provider,
          alias: options.context.alias,
        })
      }
      handedOff = true
      return { response, handle }
    } catch (err) {
      if (err instanceof LLMError) throw err
      const mapped = fetchError(err, options.context, handle.timedOut(), handle.parentAborted())
      if (mapped.code === 'network' && attempt < options.maxRetries && deadline - Date.now() > 1500) {
        const delay = retryDelay(null, attempt, deadline - Date.now())
        logRetry(options, attempt, undefined, delay)
        await backoff(delay, options, handle)
        continue
      }
      throw mapped
    } finally {
      if (!handedOff) handle.cleanup()
    }
  }
}
