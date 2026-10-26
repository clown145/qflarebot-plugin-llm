import type { Logger } from '@qqbot/sdk'
import { describe, expect, it, vi } from 'vitest'
import { createDefaultConfig } from './config/defaults.js'
import type { StoredConfig } from './config/types.js'
import { LLMError } from './errors.js'
import { LLM } from './service.js'
import { fixedStore } from './store.js'
import type { StreamEvent } from './contract.js'

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

function client(fetchImpl: typeof fetch): LLM {
  return new LLM({ store: fixedStore(config()), logger, fetch: fetchImpl })
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
})

describe('LLM 其他方法', () => {
  it('listModels / resolve 只返回公开信息', async () => {
    const llm = client(vi.fn() as unknown as typeof fetch)
    await expect(llm.listModels()).resolves.toEqual([
      { alias: 'chat', provider: 'p', model: 'm', capabilities: ['tools', 'json'] },
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
})
