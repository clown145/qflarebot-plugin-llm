import { describe, expect, it } from 'vitest'
import type { ProviderDraft } from './types.js'
import { aliasBase, isProviderDraftDirty, providerFingerprint, uniqueProviderId } from './providerDraft.js'

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

describe('uniqueProviderId', () => {
  it('清洗非法字符并避免重名', () => {
    expect(uniqueProviderId('My Provider!', [])).toBe('my-provider')
    expect(uniqueProviderId('my provider', ['my-provider'])).toBe('my-provider-2')
    expect(uniqueProviderId('my provider', ['my-provider', 'my-provider-2'])).toBe('my-provider-3')
  })

  it('空模板回退到 provider', () => {
    expect(uniqueProviderId('中文', [])).toBe('provider')
    expect(uniqueProviderId('!!!', ['provider'])).toBe('provider-2')
  })
})

describe('aliasBase', () => {
  it('把上游模型名转成合法别名起点', () => {
    expect(aliasBase('deepseek-chat')).toBe('deepseek-chat')
    expect(aliasBase('openai/gpt-4o')).toBe('openai-gpt-4o')
    expect(aliasBase('__model__')).toBe('model')
    expect(aliasBase('9-router/auto')).toBe('9-router-auto')
  })

  it('限制长度并去掉尾部符号', () => {
    const value = aliasBase('a'.repeat(50))
    expect(value).toHaveLength(36)
    expect(aliasBase('vendor/model...')).toBe('vendor-model')
  })
})

describe('providerFingerprint', () => {
  it('忽略 api_key_set，只比较可编辑字段', () => {
    expect(providerFingerprint(provider({ api_key_set: true }))).toBe(providerFingerprint(provider({ api_key_set: false })))
  })

  it('空 Key 视为未填写，请求头顺序不影响结果', () => {
    const left = provider({ api_key: '   ', headers: { 'X-A': '1', 'X-B': '2' } })
    const right = provider({ headers: { 'X-B': '2', 'X-A': '1' } })
    expect(providerFingerprint(left)).toBe(providerFingerprint(right))
  })

  it('名称、地址、Key 和清除标记都会触发变化', () => {
    const base = provider({ api_key_set: true })
    expect(isProviderDraftDirty(provider({ name: '新名字' }), base, false)).toBe(true)
    expect(isProviderDraftDirty(provider({ base_url: 'https://other.example/v1' }), base, false)).toBe(true)
    expect(isProviderDraftDirty(provider({ api_key: 'sk-new' }), base, false)).toBe(true)
    expect(isProviderDraftDirty(provider({ clear_key: true }), base, false)).toBe(true)
    expect(isProviderDraftDirty(base, base, false)).toBe(false)
  })

  it('新建供应商始终视为未保存', () => {
    const draft = provider()
    expect(isProviderDraftDirty(draft, null, true)).toBe(true)
    expect(isProviderDraftDirty(draft, draft, false)).toBe(false)
  })
})
