import type { Logger } from '@qqbot/sdk'
import { LLMError, errorMessage } from './errors.js'
import { createAbortHandle, readJsonLimited, sleep, type AbortHandle } from './http.js'
import type { BuiltRequest } from './protocols/types.js'
import { fetchError, retryDelay, shouldRetryStatus, upstreamError, type UpstreamContext } from './upstream.js'

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024

export interface TransportOptions {
  fetch: typeof fetch
  logger: Logger
  context: UpstreamContext
  timeoutMs: number
  maxRetries: number
  signal?: AbortSignal
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
          await sleep(delay, options.signal)
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
        await sleep(delay, options.signal)
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
    try {
      const fetchImpl = options.fetch
      const response = await fetchImpl(built.url, { ...built.init, signal: handle.signal })
      if (!response.ok) {
        const error = await upstreamError(response, options.context)
        handle.cleanup()
        if (attempt < options.maxRetries && shouldRetryStatus(response.status) && deadline - Date.now() > 1500) {
          const delay = retryDelay(response.headers.get('retry-after'), attempt, deadline - Date.now())
          logRetry(options, attempt, response.status, delay)
          await sleep(delay, options.signal)
          continue
        }
        throw error
      }
      if (!response.body) {
        handle.cleanup()
        throw new LLMError('bad_response', '上游没有返回响应体', {
          provider: options.context.provider,
          alias: options.context.alias,
        })
      }
      return { response, handle }
    } catch (err) {
      handle.cleanup()
      if (err instanceof LLMError) throw err
      const mapped = fetchError(err, options.context, handle.timedOut(), handle.parentAborted())
      if (mapped.code === 'network' && attempt < options.maxRetries && deadline - Date.now() > 1500) {
        const delay = retryDelay(null, attempt, deadline - Date.now())
        logRetry(options, attempt, undefined, delay)
        await sleep(delay, options.signal)
        continue
      }
      throw mapped
    }
  }
}
