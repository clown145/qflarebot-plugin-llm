import { describe, expect, it } from 'vitest'
import { rebaseProviderDraft, rebaseSettingsDraft, sameValue } from './rebase.js'
import type { ProviderDraft } from './types.js'

function provider(overrides: Partial<ProviderDraft> = {}): ProviderDraft {
  return {
    id: 'p',
    name: '供应商',
    protocol: 'openai',
    base_url: 'https://api.example.com/v1',
    enabled: true,
    api_key_set: true,
    ...overrides,
  }
}

describe('sameValue', () => {
  it('忽略对象键顺序', () => {
    expect(sameValue({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true)
    expect(sameValue({ a: 1 }, { a: 2 })).toBe(false)
  })

  it('区分 undefined 与缺失以外的值', () => {
    expect(sameValue(undefined, undefined)).toBe(true)
    expect(sameValue(undefined, null)).toBe(false)
    expect(sameValue([1, 2], [1, 2])).toBe(true)
    expect(sameValue([1, 2], [2, 1])).toBe(false)
  })
})

describe('rebaseProviderDraft', () => {
  it('用户没改过的字段跟随最新已保存值', () => {
    const draft = provider({ enabled: true, timeout_ms: 25000 })
    const previous = provider({ enabled: true, timeout_ms: 25000 })
    const next = provider({ enabled: false, timeout_ms: 15000 })
    const rebased = rebaseProviderDraft(draft, previous, next)
    expect(rebased.enabled).toBe(false)
    expect(rebased.timeout_ms).toBe(15000)
  })

  it('用户改过的字段不被覆盖', () => {
    const draft = provider({ name: '我改的名字', enabled: true })
    const previous = provider({ name: '供应商', enabled: true })
    const next = provider({ name: '别处改的名字', enabled: false })
    const rebased = rebaseProviderDraft(draft, previous, next)
    expect(rebased.name).toBe('我改的名字')
    // 没改过的 enabled 仍然跟随
    expect(rebased.enabled).toBe(false)
  })

  it('用户改了地址就不被别处的地址覆盖', () => {
    const draft = provider({ base_url: 'https://mine.test/v1' })
    const previous = provider({ base_url: 'https://api.example.com/v1' })
    const next = provider({ base_url: 'https://theirs.test/v1' })
    expect(rebaseProviderDraft(draft, previous, next).base_url).toBe('https://mine.test/v1')
  })

  it('新出现的字段会补进草稿，消失的字段会从草稿删掉', () => {
    const draft = provider()
    const previous = provider()
    const next = provider({ timeout_ms: 20000, headers: { 'X-Title': 't' } })
    const withFields = rebaseProviderDraft(draft, previous, next)
    expect(withFields.timeout_ms).toBe(20000)
    expect(withFields.headers).toEqual({ 'X-Title': 't' })

    const dropped = rebaseProviderDraft(withFields, provider({ timeout_ms: 20000, headers: { 'X-Title': 't' } }), provider())
    expect(dropped.timeout_ms).toBeUndefined()
    expect(dropped.headers).toBeUndefined()
  })

  it('请求头顺序不同不算用户改过', () => {
    const draft = provider({ headers: { 'X-A': '1', 'X-B': '2' } })
    const previous = provider({ headers: { 'X-B': '2', 'X-A': '1' } })
    const next = provider({ headers: { 'X-A': '9' } })
    expect(rebaseProviderDraft(draft, previous, next).headers).toEqual({ 'X-A': '9' })
  })

  it('没有输入新 Key、没点清除时 api_key_set 跟随服务端', () => {
    const draft = provider({ api_key_set: true })
    const previous = provider({ api_key_set: true })
    const next = provider({ api_key_set: false })
    expect(rebaseProviderDraft(draft, previous, next).api_key_set).toBe(false)
  })

  it('用户正在输入新 Key 时不覆盖 api_key_set', () => {
    const draft = provider({ api_key: 'sk-new', api_key_set: false })
    const previous = provider({ api_key_set: true })
    const next = provider({ api_key_set: true })
    const rebased = rebaseProviderDraft(draft, previous, next)
    expect(rebased.api_key).toBe('sk-new')
    expect(rebased.api_key_set).toBe(false)
  })

  it('用户点了清除 Key 时保留 clear_key 与 api_key_set=false', () => {
    const draft = provider({ clear_key: true, api_key_set: true })
    const previous = provider({ api_key_set: true })
    const next = provider({ api_key_set: true })
    const rebased = rebaseProviderDraft(draft, previous, next)
    expect(rebased.clear_key).toBe(true)
    expect(rebased.api_key_set).toBe(true)
  })

  it('没有基线时原样返回（不把未知当成用户改过）', () => {
    const draft = provider({ name: '草稿', enabled: false })
    const next = provider({ name: '服务端', enabled: true })
    const rebased = rebaseProviderDraft(draft, null, next)
    expect(rebased).toEqual(draft)
    expect(rebased).not.toBe(draft)
  })

  it('不修改入参', () => {
    const draft = provider({ name: '草稿' })
    const snapshot = { ...draft }
    const previous = provider()
    rebaseProviderDraft(draft, previous, provider({ name: '服务端', enabled: false }))
    expect(draft).toEqual(snapshot)
  })
})

describe('rebaseSettingsDraft', () => {
  const draft = { default_model: 'chat', request_timeout_ms: 25000, max_retries: 1 }

  it('没改过的字段跟随新值', () => {
    const rebased = rebaseSettingsDraft(
      { ...draft },
      { ...draft },
      { default_model: 'other', request_timeout_ms: 15000, max_retries: 2 },
    )
    expect(rebased).toEqual({ default_model: 'other', request_timeout_ms: 15000, max_retries: 2 })
  })

  it('改过的字段保留', () => {
    const rebased = rebaseSettingsDraft(
      { ...draft, request_timeout_ms: 12000 },
      { ...draft },
      { default_model: 'other', request_timeout_ms: 15000, max_retries: 1 },
    )
    expect(rebased.request_timeout_ms).toBe(12000)
    expect(rebased.default_model).toBe('other')
  })

  it('没有基线时原样返回', () => {
    expect(rebaseSettingsDraft(draft, null, { default_model: 'x', request_timeout_ms: 1, max_retries: 0 })).toEqual(draft)
  })
})
