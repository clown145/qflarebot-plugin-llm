import { describe, expect, it } from 'vitest'
import { createDefaultConfig } from './config/defaults.js'
import { normalizeConfig } from './config/normalize.js'
import { resolveTarget } from './config/resolve.js'
import { mergeSecrets, toPublicConfig } from './config/secrets.js'
import type { StoredConfig } from './config/types.js'
import { validateConfig } from './config/validate.js'

function sample(): StoredConfig {
  const config = createDefaultConfig()
  config.providers = [
    {
      id: 'deepseek',
      name: 'DeepSeek',
      protocol: 'openai',
      base_url: 'https://api.deepseek.com/v1',
      api_key: 'sk-test',
      enabled: true,
    },
  ]
  config.models = [{ alias: 'chat', provider: 'deepseek', model: 'deepseek-chat', enabled: true }]
  config.default_model = 'chat'
  return config
}

describe('normalizeConfig', () => {
  it('补默认值、去尾部斜杠，并丢掉页面专用的 api_key_set', () => {
    const config = normalizeConfig({
      providers: [{ id: 'x', protocol: 'anthropic', base_url: 'https://x.test/v1/', api_key_set: true }],
      models: [{ alias: 'a', provider: 'x', model: 'm' }],
      default_model: 'a',
    })
    expect(config.schema_version).toBe(1)
    expect(config.providers[0]?.base_url).toBe('https://x.test/v1')
    expect(config.providers[0]?.api_key).toBeUndefined()
    expect(config.models[0]?.enabled).toBe(true)
    expect(config.request_timeout_ms).toBe(25000)
  })

  it('坏值退回默认结构，不抛错', () => {
    const config = normalizeConfig('bad')
    expect(config.providers).toEqual([])
    expect(config.version).toBe(1)
  })
})

describe('toPublicConfig / mergeSecrets', () => {
  it('公开视图不含 key，只保留 api_key_set', () => {
    const view = toPublicConfig(sample())
    expect('api_key' in view.providers[0]!).toBe(false)
    expect(view.providers[0]?.api_key_set).toBe(true)
  })

  it('省略 api_key 保留旧值，版本 +1', () => {
    const current = sample()
    const next = mergeSecrets({ ...toPublicConfig(current), providers: [{ ...toPublicConfig(current).providers[0]!, name: '新名字' }] }, current)
    expect(next.providers[0]?.api_key).toBe('sk-test')
    expect(next.providers[0]?.name).toBe('新名字')
    expect(next.version).toBe(current.version + 1)
  })

  it('字符串替换、null 清除', () => {
    const current = sample()
    const replaced = mergeSecrets({ ...toPublicConfig(current), providers: [{ ...toPublicConfig(current).providers[0]!, api_key: 'sk-new' }] }, current)
    expect(replaced.providers[0]?.api_key).toBe('sk-new')

    const cleared = mergeSecrets({ ...toPublicConfig(current), providers: [{ ...toPublicConfig(current).providers[0]!, api_key: null }] }, current)
    expect(cleared.providers[0]?.api_key).toBeUndefined()
  })
})

describe('validateConfig', () => {
  it('正常配置没有 error', () => {
    expect(validateConfig(sample()).filter((item) => item.level === 'error')).toEqual([])
  })

  it('重复别名、供应商不存在、默认模型不存在都是 error', () => {
    const config = sample()
    config.models.push({ ...config.models[0]! })
    config.models.push({ alias: 'other', provider: 'missing', model: 'm', enabled: true })
    config.default_model = 'nope'
    const errors = validateConfig(config).filter((item) => item.level === 'error')
    expect(errors.some((item) => item.message.includes('重复'))).toBe(true)
    expect(errors.some((item) => item.message.includes('不存在'))).toBe(true)
  })

  it('非法 base_url 与超时范围报错', () => {
    const config = sample()
    config.providers[0]!.base_url = 'not-a-url'
    config.request_timeout_ms = 999
    const errors = validateConfig(config).filter((item) => item.level === 'error')
    expect(errors.some((item) => item.path.endsWith('base_url'))).toBe(true)
    expect(errors.some((item) => item.path === 'request_timeout_ms')).toBe(true)
  })
})

describe('resolveTarget', () => {
  it('按别名解析，缺省用 default_model', () => {
    const config = sample()
    expect(resolveTarget(config).model.alias).toBe('chat')
    expect(resolveTarget(config, 'chat').provider.id).toBe('deepseek')
  })

  it('未知、重复、停用都抛出可读错误', () => {
    const config = sample()
    expect(() => resolveTarget(config, 'nope')).toThrow(/不存在/)
    config.models.push({ ...config.models[0]! })
    expect(() => resolveTarget(config, 'chat')).toThrow(/重复/)
    config.models = [config.models[0]!]
    config.providers[0]!.enabled = false
    expect(() => resolveTarget(config, 'chat')).toThrow(/已停用/)
  })
})
