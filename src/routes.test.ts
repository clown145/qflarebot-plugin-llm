import { createMockContext } from '@qqbot/sdk/testing'
import type { PluginContext } from '@qqbot/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDefaultConfig, CONFIG_KEY } from './config/defaults.js'
import type { StoredConfig } from './config/types.js'
import plugin from './index.js'

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
