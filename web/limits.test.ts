import { describe, expect, it } from 'vitest'
import { DEFAULT_TIMEOUT_MS } from '../src/config/defaults.js'
import { LIMITS } from '../src/config/types.js'
import { timeoutHint, timeoutLimits } from './limits.js'
import type { MetaResponse } from '../src/apiTypes.js'

function meta(limits: Record<string, number>): MetaResponse {
  return {
    ok: true,
    plugin: { name: 'qflarebot-plugin-llm', version: '0.1.0' },
    service: { name: 'llm', contractVersion: 1 },
    protocols: [],
    limits: limits as MetaResponse['limits'],
  }
}

describe('timeoutLimits', () => {
  it('读 meta.limits 的值', () => {
    const limits = timeoutLimits(meta({ timeout_min: 2000, timeout_max: 28000, call_timeout_max: 20000 }))
    expect(limits.min).toBe(2000)
    expect(limits.max).toBe(28000)
    expect(limits.callMax).toBe(20000)
  })

  it('老后端没有 call_timeout_max 时退回常量', () => {
    const limits = timeoutLimits(meta({ timeout_min: 1000, timeout_max: 28000 }))
    expect(limits.callMax).toBe(LIMITS.call_timeout_max)
    expect(limits.callMax).toBe(20000)
  })

  it('meta 还没加载时全部退回常量', () => {
    const limits = timeoutLimits(null)
    expect(limits.min).toBe(LIMITS.timeout_min)
    expect(limits.max).toBe(LIMITS.timeout_max)
    expect(limits.callMax).toBe(LIMITS.call_timeout_max)
    expect(limits.defaultMs).toBe(DEFAULT_TIMEOUT_MS)
  })

  it('默认值是 15000，不是老文案里的 25000', () => {
    expect(timeoutLimits(null).defaultMs).toBe(15000)
  })

  it('非法值退回常量', () => {
    const limits = timeoutLimits(meta({ timeout_min: Number.NaN, timeout_max: -1, call_timeout_max: 0 }))
    expect(limits.min).toBe(LIMITS.timeout_min)
    expect(limits.max).toBe(LIMITS.timeout_max)
    expect(limits.callMax).toBe(LIMITS.call_timeout_max)
  })
})

describe('timeoutHint', () => {
  it('说明配置上限与实际生效上限的差异', () => {
    const hint = timeoutHint(timeoutLimits(meta({ timeout_min: 1000, timeout_max: 28000, call_timeout_max: 20000 })))
    expect(hint).toContain('1000–28000')
    expect(hint).toContain('20000')
    expect(hint).toContain('30 秒')
  })

  it('不含写死的 25000 默认值', () => {
    expect(timeoutHint()).not.toContain('25000')
  })
})
