/** HTTP 小工具：JSON 响应、请求体上限、超时/取消、错误体截断与脱敏。 */

import { redact, redactAll } from './redact.js'

export class HttpError extends Error {
  readonly status: number
  readonly payload?: unknown

  constructor(status: number, message: string, payload?: unknown) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    if (payload !== undefined) this.payload = payload
  }
}

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

/**
 * 读请求体并限制大小。
 *
 * 上限按**字节**算：`text.length` 是 UTF-16 码元数，中文一个字占 3 字节，
 * 按字符算等于把上限放大三倍。`content-length` 缺失（chunked）时也要靠读入后的字节数兜底，
 * 所以先读再判，但用 `arrayBuffer` 一次拿到字节数，避免先解码再计数多一遍拷贝。
 */
export async function readJson(request: Request, maxBytes = 256 * 1024): Promise<unknown> {
  const declared = Number(request.headers.get('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > maxBytes) throw new HttpError(413, '请求体过大')

  const buffer = await request.arrayBuffer()
  if (buffer.byteLength > maxBytes) throw new HttpError(413, '请求体过大')

  let text: string
  try {
    // workers-types 的 TextDecoder 构造参数要求 ignoreBOM；fatal 让坏字节直接抛错而不是替换成 U+FFFD
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false })
    text = decoder.decode(buffer)
  } catch {
    throw new HttpError(400, '请求体不是合法的 UTF-8 文本')
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new HttpError(400, '请求体不是合法 JSON')
  }
}

/** 读响应体，最多 maxBytes；超出部分直接丢掉，避免上游的错误页/坏流把内存吃满 */
export async function readTextLimited(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let out = ''
  let bytes = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      out += decoder.decode(value, { stream: true })
      if (bytes >= maxBytes) {
        await reader.cancel().catch(() => {})
        break
      }
    }
    out += decoder.decode()
    return out
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // 已取消的 reader 再 release 可能抛错，忽略
    }
  }
}

export async function readJsonLimited(response: Response, maxBytes: number): Promise<unknown> {
  const text = await readTextLimited(response, maxBytes)
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('上游返回的不是合法 JSON')
  }
}

export interface AbortHandle {
  signal: AbortSignal
  abort(): void
  cleanup(): void
  timedOut(): boolean
  parentAborted(): boolean
}

/** 组合调用方的 signal 与本次超时；cleanup 必须放在 finally 里 */
export function createAbortHandle(timeoutMs: number, parent?: AbortSignal): AbortHandle {
  const controller = new AbortController()
  let timedOut = false
  let parentAborted = false

  const onParentAbort = () => {
    parentAborted = true
    controller.abort()
  }
  if (parent) {
    if (parent.aborted) onParentAbort()
    else parent.addEventListener('abort', onParentAbort, { once: true })
  }

  const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, Math.max(0, timeoutMs))

  return {
    signal: controller.signal,
    abort() {
      controller.abort()
    },
    cleanup() {
      clearTimeout(timer)
      parent?.removeEventListener('abort', onParentAbort)
    },
    timedOut: () => timedOut,
    parentAborted: () => parentAborted,
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, Math.max(0, ms))
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Retry-After 可能是秒数，也可能是 HTTP 日期 */
export function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
  const date = Date.parse(value)
  if (Number.isNaN(date)) return undefined
  return Math.max(0, date - Date.now())
}

export { redact, redactAll }

export function truncate(text: string, max = 400): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max)}…` : clean
}

/** 截断 + 脱敏，错误消息进日志和跨插件异常前的统一出口 */
export function safeDetail(text: string, secrets: ReadonlyArray<string | undefined> = [], max = 400): string {
  return truncate(redactAll(text, secrets), max)
}
