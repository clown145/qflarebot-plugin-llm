import { describe, expect, it } from 'vitest'
import { normalizeDraft, reconcileKeyState, toExport, type AppConfigDraft } from './types.js'

function draft(): AppConfigDraft {
  return {
    providers: [{
      id: 'p',
      name: 'P',
      protocol: 'openai',
      base_url: 'https://api.test/v1',
      enabled: true,
      api_key_set: true,
    }],
    models: [{ alias: 'chat', provider: 'p', model: 'm', enabled: true }],
    default_model: 'chat',
    request_timeout_ms: 25000,
    max_retries: 1,
  }
}

function imported(providers: unknown[]): AppConfigDraft {
  return normalizeDraft({
    providers,
    models: [],
    default_model: '',
    request_timeout_ms: 25000,
    max_retries: 1,
  })
}

describe('toExport', () => {
  it('不导出 Key、Key 状态和敏感请求头', () => {
    const config = draft()
    config.providers[0]!.api_key = 'sk-secret'
    config.providers[0]!.api_key_set = true
    config.providers[0]!.headers = {
      'X-Title': 'QFlareBot',
      Authorization: 'Bearer sk-secret',
      'api-key': 'sk-secret',
    }

    const exported = toExport(config, 3, '2026-01-01T00:00:00.000Z')
    expect(exported.providers[0]).not.toHaveProperty('api_key')
    expect(exported.providers[0]).not.toHaveProperty('api_key_set')
    expect(exported.providers[0]?.headers).toEqual({ 'X-Title': 'QFlareBot' })
    expect(JSON.stringify(exported)).not.toContain('sk-secret')
  })

  it('全部请求头都敏感时省略 headers', () => {
    const config = draft()
    config.providers[0]!.headers = { Authorization: 'Bearer x', Cookie: 'sid=1' }
    const exported = toExport(config, 1, '2026-01-01T00:00:00.000Z')
    expect(exported.providers[0]).not.toHaveProperty('headers')
  })
})

describe('导出请求头白名单', () => {
  it('只保留展示类头，其余全部剔除并记录名字', () => {
    const config = draft()
    config.providers[0]!.headers = {
      'X-Title': 'QFlareBot',
      'HTTP-Referer': 'https://example.com',
      'X-Referer': 'https://example.com',
      'User-Agent': 'QFlareBot/1.0',
      'Accept-Language': 'zh-CN',
      'OpenAI-Beta': 'assistants=v2',
    }
    const exported = toExport(config, 1, '2026-01-01T00:00:00.000Z')
    expect(exported.providers[0]?.headers).toEqual({
      'X-Title': 'QFlareBot',
      'HTTP-Referer': 'https://example.com',
      'X-Referer': 'https://example.com',
      'User-Agent': 'QFlareBot/1.0',
      'Accept-Language': 'zh-CN',
      'OpenAI-Beta': 'assistants=v2',
    })
    expect(exported.providers[0]).not.toHaveProperty('headers_omitted')
  })

  it('denylist 漏掉的第三方鉴权头不会泄漏，但记进 headers_omitted', () => {
    const config = draft()
    config.providers[0]!.headers = {
      'X-Title': 'QFlareBot',
      'x-hf-token': 'hf_SECRET1234567890',
      'X-Custom-Auth': 'custom-secret-value',
      'X-Auth-Token': 'tok',
      'X-Goog-Api-Key': 'AIzaSySECRET',
    }
    const exported = toExport(config, 1, '2026-01-01T00:00:00.000Z')
    const text = JSON.stringify(exported)
    expect(text).not.toContain('hf_SECRET')
    expect(text).not.toContain('custom-secret-value')
    expect(text).not.toContain('AIzaSySECRET')
    expect(exported.providers[0]?.headers).toEqual({ 'X-Title': 'QFlareBot' })
    // 只记名字不记值
    expect(exported.providers[0]?.headers_omitted).toEqual(['x-hf-token', 'X-Custom-Auth', 'X-Auth-Token', 'X-Goog-Api-Key'])
    expect(text).not.toContain('hf_SECRET')
  })

  it('白名单大小写不敏感', () => {
    const config = draft()
    config.providers[0]!.headers = { 'x-title': 'a', 'HTTP-REFERER': 'b', 'user-agent': 'c' }
    const exported = toExport(config, 1, '2026-01-01T00:00:00.000Z')
    expect(exported.providers[0]?.headers).toEqual({ 'x-title': 'a', 'HTTP-REFERER': 'b', 'user-agent': 'c' })
  })

  it('没有 headers 时不写 headers / headers_omitted', () => {
    const exported = toExport(draft(), 1, '2026-01-01T00:00:00.000Z')
    expect(exported.providers[0]).not.toHaveProperty('headers')
    expect(exported.providers[0]).not.toHaveProperty('headers_omitted')
  })
})

describe('导入后的 Key 状态', () => {
  it('忽略文件里的 api_key_set', () => {
    const config = imported([{
      id: 'new',
      name: 'New',
      protocol: 'openai',
      base_url: 'https://api.test/v1',
      enabled: true,
      api_key_set: true,
    }])
    expect(config.providers[0]?.api_key_set).toBe(false)
  })

  it('按本机已有供应商标识对齐，新供应商不误报为已设置', () => {
    const local = draft()
    local.providers = [
      { id: 'keep', name: 'Keep', protocol: 'openai', base_url: 'https://a.test/v1', enabled: true, api_key_set: true },
      { id: 'empty', name: 'Empty', protocol: 'openai', base_url: 'https://b.test/v1', enabled: true, api_key_set: false },
    ]
    const config = imported([
      { id: 'keep', name: 'Keep', protocol: 'openai', base_url: 'https://a.test/v1', enabled: true, api_key_set: true },
      { id: 'empty', name: 'Empty', protocol: 'openai', base_url: 'https://b.test/v1', enabled: true, api_key_set: true },
      { id: 'new', name: 'New', protocol: 'openai', base_url: 'https://c.test/v1', enabled: true, api_key_set: true },
    ])

    const { draft: reconciled, dropped } = reconcileKeyState(config, local)
    expect(reconciled.providers.map((provider) => provider.api_key_set)).toEqual([true, false, false])
    expect(dropped).toEqual([])
  })

  it('不支持的协议直接报错，不再静默当成 openai', () => {
    expect(() => imported([{
      id: 'cohere',
      name: 'Cohere',
      protocol: 'cohere',
      base_url: 'https://api.test/v1',
      enabled: true,
    }])).toThrow(/协议不支持/)
  })

  it('文件里手写的 api_key 仍会被识别', () => {
    const config = imported([{
      id: 'typed',
      name: 'Typed',
      protocol: 'openai',
      base_url: 'https://api.test/v1',
      enabled: true,
      api_key: 'sk-typed',
    }])
    const { draft: reconciled } = reconcileKeyState(config, null)
    expect(reconciled.providers[0]?.api_key_set).toBe(true)
  })
})

describe('reconcileKeyState 三元组对齐', () => {
  const local: AppConfigDraft = {
    providers: [
      { id: 'same', name: 'Same', protocol: 'openai', base_url: 'https://api.test/v1', enabled: true, api_key_set: true },
      { id: 'moved', name: 'Moved', protocol: 'openai', base_url: 'https://api.test/v1', enabled: true, api_key_set: true },
      { id: 'switched', name: 'Switched', protocol: 'openai', base_url: 'https://api.test/v1', enabled: true, api_key_set: true },
      { id: 'slash', name: 'Slash', protocol: 'openai', base_url: 'https://api.test/v1/', enabled: true, api_key_set: true },
      { id: 'unkeyed', name: 'Unkeyed', protocol: 'openai', base_url: 'https://api.test/v1', enabled: true, api_key_set: false },
    ],
    models: [],
    default_model: '',
    request_timeout_ms: 25000,
    max_retries: 1,
  }

  function importedProvider(overrides: Record<string, unknown>): AppConfigDraft {
    return imported([{
      name: 'x',
      protocol: 'openai',
      base_url: 'https://api.test/v1',
      enabled: true,
      ...overrides,
    }])
  }

  it('id + 协议 + 地址都一致才继承本机 Key 状态', () => {
    const { draft: reconciled, dropped } = reconcileKeyState(importedProvider({ id: 'same' }), local)
    expect(reconciled.providers[0]?.api_key_set).toBe(true)
    expect(reconciled.providers[0]?.clear_key).toBe(false)
    expect(dropped).toEqual([])
  })

  it('地址变了不继承，并标记 clear_key 让服务端丢掉旧 Key', () => {
    const { draft: reconciled, dropped } = reconcileKeyState(
      importedProvider({ id: 'moved', base_url: 'https://evil.test/v1' }),
      local,
    )
    expect(reconciled.providers[0]?.api_key_set).toBe(false)
    expect(reconciled.providers[0]?.clear_key).toBe(true)
    expect(dropped).toEqual(['moved'])
  })

  it('协议变了不继承', () => {
    const { draft: reconciled, dropped } = reconcileKeyState(
      importedProvider({ id: 'switched', protocol: 'anthropic' }),
      local,
    )
    expect(reconciled.providers[0]?.api_key_set).toBe(false)
    expect(reconciled.providers[0]?.clear_key).toBe(true)
    expect(dropped).toEqual(['switched'])
  })

  it('只有末尾斜杠不同算同一个地址', () => {
    const { draft: reconciled, dropped } = reconcileKeyState(importedProvider({ id: 'slash' }), local)
    expect(reconciled.providers[0]?.api_key_set).toBe(true)
    expect(dropped).toEqual([])
  })

  it('本机没有 Key 的供应商不算被丢弃', () => {
    const { draft: reconciled, dropped } = reconcileKeyState(
      importedProvider({ id: 'unkeyed', base_url: 'https://other.test/v1' }),
      local,
    )
    expect(reconciled.providers[0]?.api_key_set).toBe(false)
    expect(reconciled.providers[0]?.clear_key).toBe(false)
    expect(dropped).toEqual([])
  })

  it('文件里手写的 Key 优先，且不标记丢弃', () => {
    const { draft: reconciled, dropped } = reconcileKeyState(
      importedProvider({ id: 'moved', base_url: 'https://evil.test/v1', api_key: 'sk-typed' }),
      local,
    )
    expect(reconciled.providers[0]?.api_key_set).toBe(true)
    expect(reconciled.providers[0]?.clear_key).toBe(false)
    expect(dropped).toEqual([])
  })

  it('一次导入多个供应商时只报真正被丢弃的', () => {
    const config = imported([
      { id: 'same', name: 'Same', protocol: 'openai', base_url: 'https://api.test/v1', enabled: true },
      { id: 'moved', name: 'Moved', protocol: 'openai', base_url: 'https://evil.test/v1', enabled: true },
      { id: 'brand-new', name: 'New', protocol: 'openai', base_url: 'https://new.test/v1', enabled: true },
    ])
    const { draft: reconciled, dropped } = reconcileKeyState(config, local)
    expect(reconciled.providers.map((provider) => provider.api_key_set)).toEqual([true, false, false])
    expect(dropped).toEqual(['moved'])
  })
})

/**
 * P1-8 回归：导入白名单漏字段，导致「导出 → 导入」丢失配置。
 *
 * - 漏 `allow_http`：内网/明文 HTTP 供应商导入后按默认（关）处理，保存被 400 拦下；
 * - 漏 `reasoning_effort`：思考等级静默丢失，用户以为迁过去了，实际回退成「不干预」。
 * `toExport` 一直在导出这两个字段，是导入端没接。
 */
describe('导入保留 allow_http 与 reasoning_effort（P1-8）', () => {
  it('allow_http: true 能往返（否则内网供应商保存被 400 拦下）', () => {
    const draft: AppConfigDraft = {
      providers: [{
        id: 'lan',
        name: 'LAN',
        protocol: 'openai',
        base_url: 'http://192.168.1.10:8000/v1',
        enabled: true,
        api_key_set: false,
        allow_http: true,
      }],
      models: [],
      default_model: '',
      request_timeout_ms: 25000,
      max_retries: 1,
    }
    const exported = toExport(draft, 1, '2026-01-01T00:00:00.000Z')
    expect(exported.providers[0]?.allow_http).toBe(true)

    const back = normalizeDraft(JSON.parse(JSON.stringify(exported)))
    expect(back.providers[0]?.allow_http).toBe(true)
  })

  it('allow_http 为 false/缺失时不写成 true', () => {
    const parsed = imported([{
      id: 'p',
      name: 'P',
      protocol: 'openai',
      base_url: 'https://api.test/v1',
      enabled: true,
      allow_http: false,
    }])
    expect(parsed.providers[0]?.allow_http).toBeUndefined()
  })

  it('reasoning_effort 能往返', () => {
    const draft: AppConfigDraft = {
      providers: [{ id: 'p', name: 'P', protocol: 'openai', base_url: 'https://api.test/v1', enabled: true, api_key_set: false }],
      models: [{ alias: 'chat', provider: 'p', model: 'm', enabled: true, reasoning_effort: 'high' }],
      default_model: 'chat',
      request_timeout_ms: 25000,
      max_retries: 1,
    }
    const exported = toExport(draft, 1, '2026-01-01T00:00:00.000Z')
    const back = normalizeDraft(JSON.parse(JSON.stringify(exported)))
    expect(back.models[0]?.reasoning_effort).toBe('high')
  })

  it('非法 reasoning_effort 被丢弃，不会变成一个不存在的等级', () => {
    const parsed = normalizeDraft({
      providers: [],
      models: [{ alias: 'a', provider: 'p', model: 'm', reasoning_effort: 'highest' }],
      default_model: '',
      request_timeout_ms: 25000,
      max_retries: 1,
    })
    expect(parsed.models[0]?.reasoning_effort).toBeUndefined()
  })
})
