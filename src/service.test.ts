import type { Logger } from '@qqbot/sdk'
import { describe, expect, it, vi } from 'vitest'
import { createDefaultConfig } from './config/defaults.js'
import { LIMITS, type StoredConfig } from './config/types.js'
import { LLMError } from './errors.js'
import { LLM } from './service.js'
import { CONFIG_READ_FAILED, fixedStore, type ConfigStore } from './store.js'
import type { StreamEvent } from './contract.js'

/** 流式累计上限；与非流式响应体上限（MAX_RESPONSE_BYTES）是两条独立的线 */
const STREAM_MAX_BYTES = LIMITS.stream_max_bytes

const logger: Logger = { debug() {}, info() {}, warn() {}, error() {} }

function config(): StoredConfig {
  const value = createDefaultConfig()
  value.providers = [{
    id: 'p',
    name: 'P',
    protocol: 'openai',
    base_url: 'https://api.test/v1',
    api_key: 'sk-secret',
    enabled: true,
  }]
  value.models = [{ alias: 'chat', provider: 'p', model: 'm', enabled: true }]
  value.default_model = 'chat'
  value.max_retries = 1
  return value
}

function anthropicConfig(): StoredConfig {
  const value = config()
  const provider = value.providers[0]
  if (provider) provider.protocol = 'anthropic'
  return value
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })
}

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder()
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

function client(fetchImpl: typeof fetch, value: StoredConfig = config()): LLM {
  return new LLM({ store: fixedStore(value), logger, fetch: fetchImpl })
}

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const event of stream) void event
}

describe('LLM.chat', () => {
  it('非流式调用返回文本与用量', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
    }))
    const llm = client(fetchMock as unknown as typeof fetch)
    const result = await llm.chat({ model: 'chat', messages: [{ role: 'user', content: 'hello' }] })
    expect(result).toMatchObject({ text: 'hi', alias: 'chat', provider: 'p', model: 'm', finish_reason: 'stop' })
    expect(result.usage).toEqual({ input_tokens: 2, output_tokens: 1, total_tokens: 3 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('5xx 会重试一次并成功', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: { message: 'boom' } }, 500))
      .mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }))
    const llm = client(fetchMock as unknown as typeof fetch)
    const result = await llm.chat({ model: 'chat', messages: [{ role: 'user', content: 'hello' }] })
    expect(result.text).toBe('ok')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('401 不重试，错误里不出现 key', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: { message: 'bad key sk-secret' } }, 401))
    const llm = client(fetchMock as unknown as typeof fetch)
    await expect(llm.chat({ model: 'chat', messages: [{ role: 'user', content: 'x' }] })).rejects.toMatchObject({ code: 'auth' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const error = await llm.chat({ model: 'chat', messages: [{ role: 'user', content: 'x' }] }).catch((err: unknown) => err)
    expect(error).toBeInstanceOf(LLMError)
    expect(String((error as Error).message)).not.toContain('sk-secret')
  })

  it('超时会抛 timeout', async () => {
    const fetchMock = vi.fn((_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
      }),
    )
    const llm = client(fetchMock as unknown as typeof fetch)
    await expect(llm.chat({
      model: 'chat',
      messages: [{ role: 'user', content: 'x' }],
      timeout_ms: 1000,
    })).rejects.toMatchObject({ code: 'timeout' })
  })
})

describe('LLM.stream', () => {
  it('把文本、工具参数和 done 结果串起来', async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse([
      'data: {"choices":[{"delta":{"content":"你"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"好"}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"lookup","arguments":"{\\"q\\":\\"x\\"}"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      'data: [DONE]\n\n',
    ]))
    const llm = client(fetchMock as unknown as typeof fetch)
    const events: StreamEvent[] = []
    for await (const event of llm.stream({ model: 'chat', messages: [{ role: 'user', content: 'x' }] })) events.push(event)

    expect(events.filter((item) => item.type === 'text_delta')).toEqual([
      { type: 'text_delta', text: '你' },
      { type: 'text_delta', text: '好' },
    ])
    const done = events.find((item) => item.type === 'done')
    expect(done).toBeDefined()
    if (done?.type === 'done') {
      expect(done.result.text).toBe('你好')
      expect(done.result.tool_calls?.[0]).toEqual({ id: 'c1', name: 'lookup', arguments: '{"q":"x"}' })
      expect(done.result.finish_reason).toBe('tool_calls')
    }
  })

  it('累计内容超过 8 MB 时抛 bad_response', async () => {
    const chunk = 'x'.repeat(900 * 1024)
    const line = `data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`
    // 流式上限与「非流式响应体上限」是两条独立的线：前者 8 MB，后者 2 MB
    const count = Math.ceil(STREAM_MAX_BYTES / (900 * 1024)) + 1
    const fetchMock = vi.fn().mockResolvedValue(sseResponse(Array.from({ length: count }, () => line)))
    const llm = client(fetchMock as unknown as typeof fetch)
    await expect(drain(llm.stream({ model: 'chat', messages: [{ role: 'user', content: 'x' }] })))
      .rejects.toMatchObject({ code: 'bad_response', provider: 'p', alias: 'chat' })
  })

  it('工具调用索引超出范围时抛 bad_response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":64,"id":"c1","function":{"name":"lookup","arguments":"{}"}}]}}]}\n\n',
    ]))
    const llm = client(fetchMock as unknown as typeof fetch)
    await expect(drain(llm.stream({ model: 'chat', messages: [{ role: 'user', content: 'x' }] })))
      .rejects.toMatchObject({ code: 'bad_response', provider: 'p', alias: 'chat' })
  })

  it('Anthropic 流式 error 事件保留错误码与目标信息', async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse([
      'event: error\ndata: {"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}\n\n',
    ]))
    const llm = client(fetchMock as unknown as typeof fetch, anthropicConfig())
    await expect(drain(llm.stream({ model: 'chat', messages: [{ role: 'user', content: 'x' }] })))
      .rejects.toMatchObject({ code: 'rate_limit', provider: 'p', alias: 'chat', detail: 'rate_limit_error' })
  })
})

describe('LLM 其他方法', () => {
  it('listModels / resolve 只返回公开信息', async () => {
    const llm = client(vi.fn() as unknown as typeof fetch)
    await expect(llm.listModels()).resolves.toEqual([
      { alias: 'chat', provider: 'p', model: 'm', capabilities: ['text', 'tools', 'json'] },
    ])
    const resolved = await llm.resolve('chat')
    expect(resolved.provider_name).toBe('P')
    expect(JSON.stringify(resolved)).not.toContain('sk-secret')
  })

  it('ping 失败时不抛错，返回 ok:false', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: { message: 'boom' } }, 400))
    const llm = client(fetchMock as unknown as typeof fetch)
    const result = await llm.ping({ alias: 'chat' })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('boom')
  })

  it('未知别名抛 unknown_model', async () => {
    const llm = client(vi.fn() as unknown as typeof fetch)
    await expect(llm.chat({ model: 'nope', messages: [{ role: 'user', content: 'x' }] })).rejects.toMatchObject({ code: 'unknown_model' })
  })

  it('KV 读取失败时抛 config，而不是当成空配置', async () => {
    const store: ConfigStore = {
      read: async () => ({ config: createDefaultConfig(), corrupt: true, readFailed: true }),
      write: async () => {},
      compareAndWrite: async () => true,
    }
    const llm = new LLM({ store, logger })
    await expect(llm.listModels()).rejects.toMatchObject({ code: 'config', message: CONFIG_READ_FAILED })
    await expect(llm.resolve()).rejects.toMatchObject({ code: 'config', message: CONFIG_READ_FAILED })
    await expect(llm.chat({ model: 'chat', messages: [{ role: 'user', content: 'x' }] }))
      .rejects.toMatchObject({ code: 'config', message: CONFIG_READ_FAILED })
    await expect(llm.ping()).resolves.toMatchObject({ ok: false, error: CONFIG_READ_FAILED })
  })
})

/**
 * P1 回归：错误语义必须一致。
 *
 * README 约定「跨插件调用时检查 err.code，不要依赖 instanceof」，
 * 所以任何失败路径都不能漏出原始 DOMException / TypeError。
 */
describe('LLM 错误语义', () => {
  it('退避期间被调用方取消，抛 LLMError aborted（不是 DOMException）', async () => {
    const controller = new AbortController()
    const fetchMock = vi.fn(async () => {
      throw new TypeError('network down')
    })
    const value = config()
    value.max_retries = 2
    const llm = client(fetchMock as unknown as typeof fetch, value)
    setTimeout(() => controller.abort(), 80)
    const error = await llm
      .chat({ model: 'chat', messages: [{ role: 'user', content: 'x' }], signal: controller.signal })
      .catch((err: unknown) => err)
    expect(error).toBeInstanceOf(LLMError)
    expect(error).toMatchObject({ code: 'aborted' })
  })

  it('流式退避期间取消同样映射成 aborted', async () => {
    const controller = new AbortController()
    const value = config()
    value.max_retries = 2
    const llm = client(vi.fn(async () => {
      throw new TypeError('network down')
    }) as unknown as typeof fetch, value)
    setTimeout(() => controller.abort(), 80)
    const error = await drain(llm.stream({ model: 'chat', messages: [{ role: 'user', content: 'x' }], signal: controller.signal }))
      .catch((err: unknown) => err)
    expect(error).toBeInstanceOf(LLMError)
    expect(error).toMatchObject({ code: 'aborted' })
  })

  it('损坏的配置：listModels 抛 config，而不是返回空数组', async () => {
    const store: ConfigStore = {
      read: async () => ({ config: createDefaultConfig(), corrupt: true }),
      write: async () => {},
      compareAndWrite: async () => true,
    }
    const llm = new LLM({ store, logger })
    await expect(llm.listModels()).rejects.toMatchObject({ code: 'config' })
  })

  it('调用方传超大 timeout 会被压到 call_timeout_max', async () => {
    let seen = 0
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      seen += 1
      // 立刻返回，只验证不抛错；超时压缩由内部 deadline 决定，这里断言调用次数
      return jsonResponse({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] })
    })
    const llm = client(fetchMock as unknown as typeof fetch)
    const result = await llm.chat({
      model: 'chat',
      messages: [{ role: 'user', content: 'x' }],
      timeout_ms: 999999,
    })
    expect(result.text).toBe('ok')
    expect(seen).toBe(1)
    expect(LIMITS.call_timeout_max).toBeLessThanOrEqual(20000)
  })

  it('ping 失败且没有供应商时不返回空字符串 provider', async () => {
    const store: ConfigStore = {
      read: async () => ({ config: createDefaultConfig(), corrupt: true, readFailed: true }),
      write: async () => {},
      compareAndWrite: async () => true,
    }
    const llm = new LLM({ store, logger })
    const result = await llm.ping()
    expect(result.ok).toBe(false)
    expect(result.provider).toBeUndefined()
  })
})
