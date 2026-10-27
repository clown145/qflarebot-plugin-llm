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
