import type { LLMErrorCode } from './contract.js'

export interface LLMErrorOptions {
  provider?: string
  alias?: string
  status?: number
  /** 上游返回的短摘要，已截断；不要放 key */
  detail?: string
  cause?: unknown
}

/** 服务对外抛的错误；跨插件无法 instanceof，调用方读 code */
export class LLMError extends Error {
  readonly code: LLMErrorCode
  readonly provider?: string
  readonly alias?: string
  readonly status?: number
  readonly detail?: string

  constructor(code: LLMErrorCode, message: string, options: LLMErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined)
    this.name = 'LLMError'
    this.code = code
    if (options.provider) this.provider = options.provider
    if (options.alias) this.alias = options.alias
    if (options.status !== undefined) this.status = options.status
    if (options.detail) this.detail = options.detail
  }
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || (err as { code?: string }).code === 'ABORT_ERR')
}

/** 日志里只留状态码、短消息和错误码，调用方自己决定要不要记 */
export function errorFields(err: unknown): { code?: string; status?: number; message: string } {
  if (err instanceof LLMError) {
    return { code: err.code, ...(err.status !== undefined ? { status: err.status } : {}), message: err.message }
  }
  return { message: errorMessage(err) }
}
