import { describe, expect, it } from 'vitest'
import { createDefaultConfig } from './config/defaults.js'
import { normalizeConfig } from './config/normalize.js'
import { resolveTarget } from './config/resolve.js'
import { mergeSecrets, toPublicConfig } from './config/secrets.js'
import type { StoredConfig } from './config/types.js'
import { validateConfig, isPrivateHost, checkBaseUrl, isMetadataHost } from './config/validate.js'

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
    expect(config.request_timeout_ms).toBe(15000)
  })

  it('坏值退回默认结构，不抛错', () => {
    const config = normalizeConfig('bad')
    expect(config.providers).toEqual([])
    expect(config.version).toBe(1)
  })

  it('模型元数据字段保留，能力去重并补 text', () => {
    const config = normalizeConfig({
      providers: [{ id: 'p', protocol: 'openai', base_url: 'https://api.test/v1' }],
      models: [{
        alias: 'a',
        provider: 'p',
        model: 'm',
        context_window: 128000,
        max_output_tokens: 8192,
        capabilities: ['image', 'tools', 'image'],
      }],
    })
    expect(config.models[0]).toMatchObject({
      context_window: 128000,
      max_output_tokens: 8192,
      capabilities: ['text', 'image', 'tools'],
    })
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

  it('提交 id 带空白时清除/替换意图不被静默丢弃（id 按 trim 后匹配）', () => {
    const current = sample()
    const view = toPublicConfig(current)
    // 直接调 API 的调用方可能传未 trim 的 id；normalize 后 provider.id 是 'deepseek'
    const cleared = mergeSecrets(
      { ...view, providers: [{ ...view.providers[0]!, id: ' deepseek ', api_key: null }] },
      current,
    )
    expect(cleared.providers[0]?.api_key).toBeUndefined()

    const replaced = mergeSecrets(
      { ...view, providers: [{ ...view.providers[0]!, id: ' deepseek ', api_key: 'sk-new' }] },
      current,
    )
    expect(replaced.providers[0]?.api_key).toBe('sk-new')
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

  it('模型上下文、输出上限和能力都会校验', () => {
    const config = sample()
    config.models[0] = {
      ...config.models[0]!,
      context_window: 0,
      max_output_tokens: 0,
      capabilities: ['vision' as never],
    }
    const errors = validateConfig(config).filter((item) => item.level === 'error')
    expect(errors.some((item) => item.path.endsWith('context_window'))).toBe(true)
    expect(errors.some((item) => item.path.endsWith('max_output_tokens'))).toBe(true)
    expect(errors.some((item) => item.path.endsWith('capabilities'))).toBe(true)
  })
})

describe('isPrivateHost / checkBaseUrl', () => {
  it('拦截 IPv6 家族（映射回环/元数据、ULA、链路本地、未指定）与边角形态', () => {
    const blocked = [
      '[::ffff:7f00:1]', '[::ffff:a9fe:a9fe]', '[::ffff:a00:5]', '[::ffff:c0a8:101]',
      '[fd00::1]', '[fe80::1]', '[::]', '[::1]', 'localhost', 'LOCALHOST', 'localhost.',
      '127.0.0.1', '10.0.0.5', '192.168.1.1', '169.254.169.254', '172.16.0.1', '172.31.255.255',
      '0.0.0.0', '0.0.0.1', '[0:0:0:0:0:0:0:1]', '[::ffff:127.0.0.1]', '[fe80::1%25eth0]', '[fd12:3456::]',
    ]
    for (const host of blocked) expect(isPrivateHost(host), host).toBe(true)
  })

  it('放行公网 IPv6/IPv4/域名（含尾点域名与映射公网 IPv4）', () => {
    const allowed = [
      '[2606:4700::6810:85e5]', '[2001:db8::1]', '[::ffff:8.8.8.8]', 'api.openai.com',
      '8.8.8.8', '1.1.1.1', '172.32.0.1', '[64:ff9b::8.8.8.8]', 'example.com.', '[2a01::1]',
    ]
    for (const host of allowed) expect(isPrivateHost(host), host).toBe(false)
  })

  it('checkBaseUrl 对 IPv6 绕过向量报 error', () => {
    const issues: { level: string; path: string; message: string }[] = []
    for (const url of ['https://[::ffff:127.0.0.1]/v1', 'https://[::ffff:169.254.169.254]/v1', 'https://[fd00::1]/v1', 'https://localhost./v1', 'https://0.0.0.1/v1']) {
      checkBaseUrl(url, 'providers.0.base_url', issues as never)
    }
    expect(issues.filter((item) => item.level === 'error')).toHaveLength(5)
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

  it('模型信息带上上下文、输出上限和能力', () => {
    const config = sample()
    config.models[0] = {
      ...config.models[0]!,
      context_window: 200000,
      max_output_tokens: 8192,
      capabilities: ['text', 'image', 'reasoning'],
    }
    expect(resolveTarget(config, 'chat').info).toMatchObject({
      context_window: 200000,
      max_output_tokens: 8192,
      capabilities: ['text', 'image', 'reasoning'],
    })
  })
})

describe('allow_http：上游只能用 IP 时的口子', () => {
  const check = (url: string, allowHttp?: boolean) => {
    const issues: { level: string; path: string; message: string }[] = []
    checkBaseUrl(url, 'providers.0.base_url', issues as never, allowHttp === undefined ? {} : { allowHttp })
    return issues
  }

  it('默认拒绝 http', () => {
    const issues = check('http://1.2.3.4:8000/v1')
    expect(issues.some((i) => i.level === 'error' && i.message.includes('https'))).toBe(true)
  })

  it('打开后允许 http 的公网 IP（这正是本功能的用途）', () => {
    expect(check('http://1.2.3.4:8000/v1', true)).toEqual([])
  })

  it('打开后也允许 http 的内网地址（自建推理服务的正当场景）', () => {
    expect(check('http://192.168.1.10:8000/v1', true)).toEqual([])
    expect(check('http://localhost:8000/v1', true)).toEqual([])
  })

  it('不打开时仍然拒绝内网地址', () => {
    const issues = check('https://192.168.1.10/v1')
    expect(issues.some((i) => i.level === 'error')).toBe(true)
  })

  it('即使打开 allow_http，云元数据地址永远拒绝（SSRF 底线）', () => {
    for (const url of [
      'http://169.254.169.254/latest/meta-data/',
      'http://169.254.169.254/v1',
      'http://[::ffff:169.254.169.254]/v1',
      'http://[fd00:ec2::254]/v1',
      'https://169.254.169.254/v1',
    ]) {
      const issues = check(url, true)
      expect(issues.some((i) => i.level === 'error' && i.message.includes('元数据')), url).toBe(true)
    }
  })

  it('非 http/https 协议即使打开开关也拒绝（不能是 ftp: file: 之类）', () => {
    expect(check('ftp://example.com/v1', true).some((i) => i.level === 'error')).toBe(true)
    expect(check('file:///etc/passwd', true).some((i) => i.level === 'error')).toBe(true)
  })

  it('isMetadataHost 只认元数据/链路本地段，不误伤普通内网', () => {
    expect(isMetadataHost('169.254.169.254')).toBe(true)
    expect(isMetadataHost('169.254.1.1')).toBe(true)
    expect(isMetadataHost('192.168.1.1')).toBe(false)
    expect(isMetadataHost('10.0.0.5')).toBe(false)
    expect(isMetadataHost('[fd00:ec2::254]')).toBe(true)
    expect(isMetadataHost('[fd00::1]')).toBe(false)
  })
})
