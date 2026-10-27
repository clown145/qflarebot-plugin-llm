import { describe, expect, it } from 'vitest'
import { headerIssues, isManagedHeader, managedHeaderKeys } from './headers.js'

describe('isManagedHeader', () => {
  it('大小写不敏感地识别受管头', () => {
    expect(isManagedHeader('Authorization')).toBe(true)
    expect(isManagedHeader('authorization')).toBe(true)
    expect(isManagedHeader(' X-API-KEY ')).toBe(true)
    expect(isManagedHeader('proxy-authorization')).toBe(true)
    expect(isManagedHeader('host')).toBe(true)
    expect(isManagedHeader('content-length')).toBe(true)
    expect(isManagedHeader('content-type')).toBe(true)
    expect(isManagedHeader('api-key')).toBe(true)
  })

  it('展示类头不算受管', () => {
    expect(isManagedHeader('X-Title')).toBe(false)
    expect(isManagedHeader('HTTP-Referer')).toBe(false)
  })
})

describe('managedHeaderKeys', () => {
  it('返回用户写法里的受管头名', () => {
    expect(managedHeaderKeys({ 'X-Title': 'a', Authorization: 'Bearer x', 'x-api-key': 'k' })).toEqual([
      'Authorization',
      'x-api-key',
    ])
  })

  it('没有请求头时返回空数组', () => {
    expect(managedHeaderKeys(undefined)).toEqual([])
    expect(managedHeaderKeys({})).toEqual([])
  })
})

describe('headerIssues', () => {
  it('受管头是 error，提示指向 API Key 字段', () => {
    const issues = headerIssues({ Authorization: 'Bearer sk-abcdefghijklmnop' })
    expect(issues).toHaveLength(1)
    expect(issues[0]?.level).toBe('error')
    expect(issues[0]?.key).toBe('Authorization')
    expect(issues[0]?.message).toContain('由 API Key 自动生成')
  })

  it('看起来像密钥的自定义头是 warn', () => {
    const issues = headerIssues({ 'X-Custom': 'sk-abcdefghijklmnopqrst' })
    expect(issues).toHaveLength(1)
    expect(issues[0]?.level).toBe('warn')
    expect(issues[0]?.key).toBe('X-Custom')
  })

  it('安全头没有 issue', () => {
    expect(headerIssues({ 'X-Title': 'QFlareBot', 'HTTP-Referer': 'https://example.com' })).toEqual([])
  })

  it('受管头即使值不像密钥也是 error', () => {
    const issues = headerIssues({ 'x-api-key': 'short' })
    expect(issues.map((item) => item.level)).toEqual(['error'])
  })
})
