/**
 * 「额外请求头」的本地校验。
 *
 * 服务端把 MANAGED_HEADERS 里的头当 **error**（保存直接 400）：Authorization / x-api-key
 * 由适配器按 API Key 生成，用户再写一份只会拼出坏值（实测 "Bearer a, Bearer b"）。
 * 所以前端保存前先拦一次，并把字段高亮，不用等一次失败的 PUT。
 */

import { looksLikeSecret } from '../src/redact.js'

/** 与 src/config/validate.ts 的 MANAGED_HEADERS 保持一致 */
const MANAGED_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'api-key',
  'host',
  'content-length',
  'content-type',
])

export interface HeaderIssue {
  level: 'error' | 'warn'
  /** 原始头名（保留用户写法，提示更直观） */
  key: string
  message: string
}

export function isManagedHeader(key: string): boolean {
  return MANAGED_HEADERS.has(key.trim().toLowerCase())
}

/** 受管头：保存会被服务端拒绝，前端直接当错误 */
export function managedHeaderKeys(headers: Record<string, string> | undefined): string[] {
  return Object.keys(headers ?? {}).filter(isManagedHeader)
}

/** 完整检查：受管头是 error，看起来像密钥的值是 warn */
export function headerIssues(headers: Record<string, string> | undefined): HeaderIssue[] {
  const out: HeaderIssue[] = []
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (isManagedHeader(key)) {
      out.push({ level: 'error', key, message: `${key} 由 API Key 自动生成，不要在这里填写` })
      continue
    }
    if (looksLikeSecret(value)) {
      out.push({ level: 'warn', key, message: `${key} 看起来像密钥；导出时会被剔除，建议改放到 API Key 字段` })
    }
  }
  return out
}
