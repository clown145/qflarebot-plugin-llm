import { describe, expect, it } from 'vitest'
import { looksLikeSecret, redact, redactAll } from './redact.js'

describe('redact', () => {
  it('精确值整段替换（截断/拼接也能命中）', () => {
    expect(redact('invalid key sk-REAL-SECRET rejected', 'sk-REAL-SECRET')).toBe('invalid key *** rejected')
  })

  it('不传 secret 时按凭据形态脱敏', () => {
    expect(redact('bad key sk-abcdefghijklmnop')).toBe('bad key ***')
    expect(redact('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc')).toBe('Authorization: Bearer ***')
    expect(redact('x-api-key: 1234567890abcdef')).toBe('x-api-key: ***')
  })

  it('保留普通文本，不误伤短词', () => {
    expect(redact('the quick brown fox')).toBe('the quick brown fox')
    // 太短的「密钥」不参与精确替换，避免把普通单词整段抹掉
    expect(redact('a secret of sk-1', 'sk-1')).toBe('a secret of sk-1')
  })

  it('同时脱敏多个密钥', () => {
    expect(redactAll('a sk-aaaaaaaaaaaa b sk-bbbbbbbbbbbb', ['sk-aaaaaaaaaaaa', 'sk-bbbbbbbbbbbb'])).toBe('a *** b ***')
  })

  it('重复调用不受正则 lastIndex 影响', () => {
    const text = 'sk-abcdefghijklmnop and sk-qrstuvwxyzabcdef'
    expect(redact(text)).toBe(redact(text))
    expect(redact(text)).toBe('*** and ***')
  })

  it('上游把 key 大写化后回显也能命中（大小写不敏感兜底）', () => {
    expect(redact('failed for SK-REAL-SECRET', 'sk-REAL-SECRET')).toBe('failed for ***')
  })

  it('URL 编码变体（- → %2D 等）也能命中', () => {
    expect(redact('failed for sk%2DREAL%2DSECRET', 'sk-REAL-SECRET')).toBe('failed for ***')
  })

  it('互为前缀的多密钥按长度降序替换，不产生残段', () => {
    expect(redactAll('key sk-REAL-SECRET-LONG and sk-REAL-SECRET', ['sk-REAL-SECRET', 'sk-REAL-SECRET-LONG']))
      .toBe('key *** and ***')
  })
})

describe('looksLikeSecret', () => {
  it('识别常见凭据形态', () => {
    expect(looksLikeSecret('sk-abcdefghijklmnop')).toBe(true)
    expect(looksLikeSecret('hf_abcdefghijklmnop')).toBe(true)
    expect(looksLikeSecret('AIzaSyABCDEFGHIJKLMNOPQRSTUVWX')).toBe(true)
  })

  it('普通请求头值不误报', () => {
    expect(looksLikeSecret('QFlareBot')).toBe(false)
    expect(looksLikeSecret('https://example.com')).toBe(false)
    expect(looksLikeSecret('short')).toBe(false)
  })
})

/**
 * P2-11 回归：凭据前缀覆盖不足。
 *
 * 旧实现只有 sk-/hf_/gh?/xox?/AIza/AKIA 与「32 位 hex.后缀」几条，其它主流供应商的
 * 前缀（Groq 的 gsk_、Cerebras 的 csk-、Perplexity 的 pplx-、xAI 的 xai-、
 * NVIDIA 的 nvapi-、Stripe 的 sk_live_、Tavily 的 tvly-、Firecrawl 的 fc-）以及
 * **裸的 32 位十六进制 key**全都不命中，上游一回显就原样进日志。
 */
describe('redact 覆盖更多凭据形态（P2-11）', () => {
  const cases: Array<[string, string]> = [
    ['Groq', 'gsk_abcdefghijklmnopqrstuvwxyz123456'],
    ['Cerebras', 'csk-abcdefghijklmnopqrstuvwxyz'],
    ['Perplexity', 'pplx-abcdefghijklmnopqrstuvwxyz'],
    ['xAI', 'xai-abcdefghijklmnopqrstuvwxyz123'],
    ['NVIDIA', 'nvapi-abcdefghijklmnopqrstuvwxyz'],
    ['Stripe live', 'sk_live_abcdefghijklmnopqrstu'],
    ['Tavily', 'tvly-abcdefghijklmnopqrstuvwxyz'],
    ['Firecrawl', 'fc-0123456789abcdef0123456789abcdef'],
    ['裸 32 位 hex（智谱等）', '0123456789abcdef0123456789abcdef'],
  ]

  for (const [name, secret] of cases) {
    it(`${name} 的 key 会被脱敏`, () => {
      const out = redact(`upstream rejected ${secret} (invalid)`)
      expect(out).not.toContain(secret)
      expect(out).toContain('***')
    })
  }

  it('上下文模式覆盖 x-goog-api-key 与自定义 auth 头', () => {
    expect(redact('x-goog-api-key: AIzaSyABCDEFGHIJKLMNOPQRSTUV')).toBe('x-goog-api-key: ***')
    expect(redact('x-hf-token: hf_abcdefghijklmnop')).toBe('x-hf-token: ***')
    expect(redact('X-Custom-Auth: custom-secret-value')).toBe('X-Custom-Auth: ***')
    expect(redact('api-key: 1234567890abcdef')).toBe('api-key: ***')
  })

  it('URL 查询串里的 key 也会脱敏（自建网关常见）', () => {
    const out = redact('GET https://gw.test/v1/models?key=abcdef1234567890 failed')
    expect(out).not.toContain('abcdef1234567890')
    expect(out).toContain('key=***')
  })

  it('不误伤普通长文本与短十六进制片段', () => {
    expect(redact('the quick brown fox jumps over the lazy dog')).toBe('the quick brown fox jumps over the lazy dog')
    // 16 位 hex（UUID 片段）不该被当成 key
    expect(redact('id 0123456789abcdef ok')).toBe('id 0123456789abcdef ok')
  })
})
