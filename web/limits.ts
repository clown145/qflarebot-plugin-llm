/**
 * 超时相关上限的单一来源。
 *
 * 后端 `/api/meta` 会下发 limits（timeout_min / timeout_max / call_timeout_max / …），
 * 页面一律从这里读，避免把 28000 / 25000 写死在文案和输入框属性里。
 * 老版本后端没有 `call_timeout_max` 时退回 src 里的常量。
 */

import { DEFAULT_TIMEOUT_MS } from '../src/config/defaults.js'
import { LIMITS } from '../src/config/types.js'
import { state } from './state.js'

export interface TimeoutLimits {
  /** 配置允许的最小超时 */
  min: number
  /** 配置允许填写的最大超时 */
  max: number
  /** 实际发请求时的上限；配置填更大也会被压到这个值 */
  callMax: number
  /** 默认超时（新建配置 / 留空时使用） */
  defaultMs: number
}

interface RawLimits {
  timeout_min?: unknown
  timeout_max?: unknown
  call_timeout_max?: unknown
}

function positive(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

/** 读当前 meta 下的超时上限；读不到（还没加载 / 老后端）时退回常量。 */
export function timeoutLimits(meta: typeof state.meta = state.meta): TimeoutLimits {
  // src/apiTypes.ts 的 limits 可能还没有 call_timeout_max（Lead 并行在加），按可选字段读
  const raw = (meta as { limits?: RawLimits } | null)?.limits
  const min = positive(raw?.timeout_min, LIMITS.timeout_min)
  const max = positive(raw?.timeout_max, LIMITS.timeout_max)
  return {
    min,
    max,
    callMax: positive(raw?.call_timeout_max, LIMITS.call_timeout_max),
    defaultMs: DEFAULT_TIMEOUT_MS,
  }
}

/** 输入框 / 文案用的说明：配置上限与实际生效上限的差异，以及一次事件的总预算。 */
export function timeoutHint(limits: TimeoutLimits = timeoutLimits()): string {
  return `${limits.min}–${limits.max}；超过 ${limits.callMax} 会被压到 ${limits.callMax}（一次事件所有插件合计 30 秒）`
}
