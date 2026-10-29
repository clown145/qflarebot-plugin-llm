import type { Logger } from '@qqbot/sdk'
import { describe, expect, it, vi } from 'vitest'
import { createDefaultConfig } from './config/defaults.js'
import type { StoredConfig } from './config/types.js'
import { LLM } from './service.js'
import { fixedStore } from './store.js'
import {
  createToolNameMap,
  mapRequestToolNames,
  mapResultToolNames,
  sanitizeToolName,
  toolNameMapFor,
  WIRE_TOOL_NAME_PATTERN,
} from './toolNames.js'

const logger: Logger = { debug() {}, info() {}, warn() {}, error() {} }

function config(protocol: 'openai' | 'anthropic' | 'gemini' = 'openai'): StoredConfig {
  const value = createDefaultConfig()
  value.providers = [
    {
      id: 'p',
      name: 'P',
      protocol,
      base_url: 'https://api.test/v1',
      api_key: 'sk-secret',
      enabled: true,
    },
  ]
  value.models = [{ alias: 'chat', provider: 'p', model: 'm', enabled: true }]
  value.default_model = 'chat'
  value.max_retries = 0
  return value
}

function client(fetchImpl: typeof fetch, value: StoredConfig = config()): LLM {
  return new LLM({ store: fixedStore(value), logger, fetch: fetchImpl })
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })
}

/** 取出这次调用实际发给上游的请求体 */
function sentBody(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const init = (fetchMock.mock.calls[0]?.[1] ?? {}) as RequestInit
  return JSON.parse(String(init.body)) as Record<string, unknown>
}

describe('sanitizeToolName', () => {
  /**
   * 这一组是在修真实故障：DeepSeek 对 OpenAI 兼容协议的 tools[].function.name 严格校验
   * `^[a-zA-Z0-9_-]+$`，插件里的 `time.now` 直接导致 400。
   */
  it('点号换成下划线（OpenAI 兼容协议会直接 400）', () => {
    expect(sanitizeToolName('time.now', 'openai')).toBe('time_now')
    expect(sanitizeToolName('vfs.read_file', 'openai')).toBe('vfs_read_file')
  })

  it('Gemini 不接受连字符，也一并换掉', () => {
    expect(sanitizeToolName('my-tool.run', 'gemini')).toBe('my_tool_run')
  })

  it('首字符是数字时补前缀', () => {
    expect(sanitizeToolName('3d.render', 'openai')).toBe('tool_3d_render')
  })

  it('超长名字截到 64 字符以内', () => {
    const long = `${'a'.repeat(80)}.x`
    expect(sanitizeToolName(long, 'openai').length).toBeLessThanOrEqual(64)
  })

  it('产物一定满足上游的字符集要求', () => {
    for (const name of ['time.now', 'vfs.read_file', 'schedule.cancel', 'a-b.c', '3x.y', '中文.名']) {
      expect(sanitizeToolName(name, 'openai')).toMatch(WIRE_TOOL_NAME_PATTERN)
      expect(sanitizeToolName(name, 'gemini')).toMatch(/^[a-zA-Z_][a-zA-Z0-9_]*$/)
    }
  })
})

describe('createToolNameMap', () => {
  it('能双向映射，且 toWire 幂等', () => {
    const map = createToolNameMap(['time.now', 'vfs.read_file'], 'openai')
    expect(map.toWire('time.now')).toBe('time_now')
    expect(map.toInternal('time_now')).toBe('time.now')
    expect(map.toWire('time_now')).toBe('time_now')
    expect(map.renamed('time.now')).toBe(true)
    expect(map.renamed('plain_name')).toBe(false)
  })

  it('不同内部名撞到同一个 wire 名时加后缀去重', () => {
    // `a.b` 与 `a_b` 合法化后都是 `a_b`
    const map = createToolNameMap(['a.b', 'a_b'], 'openai')
    const first = map.toWire('a.b')
    const second = map.toWire('a_b')
    expect(new Set([first, second]).size).toBe(2)
    expect(map.toInternal(second)).toBe('a_b')
  })

  it('未登记的名字原样返回内部名（模型可能编出不存在的工具）', () => {
    const map = createToolNameMap(['time.now'], 'openai')
    expect(map.toInternal('made_up_name')).toBe('made_up_name')
  })
})

describe('mapRequestToolNames', () => {
  it('换掉 tools 名字并在 description 里写明原始名', () => {
    const map = createToolNameMap(['time.now'], 'openai')
    const request = mapRequestToolNames(
      {
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ name: 'time.now', description: '查时间', parameters: { type: 'object' } }],
      },
      map,
    )
    expect(request.tools?.[0]?.name).toBe('time_now')
    expect(request.tools?.[0]?.description).toContain('Internal tool name: time.now.')
    expect(request.tools?.[0]?.description).toContain('查时间')
  })

  it('没有 description 时也补一句，不留空描述', () => {
    const map = createToolNameMap(['time.now'], 'openai')
    const request = mapRequestToolNames({ messages: [], tools: [{ name: 'time.now', parameters: {} }] }, map)
    expect(request.tools?.[0]?.description).toBe('Internal tool name: time.now.')
  })

  it('tool_choice 里指定的名字也要换', () => {
    const map = createToolNameMap(['time.now'], 'openai')
    const request = mapRequestToolNames(
      { messages: [], tools: [{ name: 'time.now', parameters: {} }], tool_choice: { name: 'time.now' } },
      map,
    )
    expect(request.tool_choice).toEqual({ name: 'time_now' })
  })

  it('本来合法的名字不动，也不加说明', () => {
    const map = createToolNameMap(['already_ok'], 'openai')
    const request = mapRequestToolNames({ messages: [], tools: [{ name: 'already_ok', parameters: {}, description: 'd' }] }, map)
    expect(request.tools?.[0]).toEqual({ name: 'already_ok', parameters: {}, description: 'd' })
  })

  it('不修改调用方传进来的对象', () => {
    const map = createToolNameMap(['time.now'], 'openai')
    const tools = [{ name: 'time.now', parameters: {} }]
    mapRequestToolNames({ messages: [], tools }, map)
    expect(tools[0]?.name).toBe('time.now')
  })
})

describe('mapResultToolNames', () => {
  it('把回包的 wire 名换回内部名', () => {
    const map = createToolNameMap(['time.now'], 'openai')
    const mapped = mapResultToolNames([{ id: 'c1', name: 'time_now', arguments: '{}' }], undefined, map)
    expect(mapped.toolCalls).toEqual([{ id: 'c1', name: 'time.now', arguments: '{}' }])
  })

  /**
   * Gemini 签名里的 tool_name 是**上游名字**，下一轮按它匹配 functionCall part。
   * 只换 toolCalls 不换签名里的名字，签名就贴不回去 → 上游 400 INVALID_ARGUMENT。
   */
  it('Gemini 思考签名里的 tool_name 一并换回内部名', () => {
    const map = createToolNameMap(['time.now'], 'gemini')
    const mapped = mapResultToolNames(
      [{ id: 'c1', name: 'time_now', arguments: '{}' }],
      [{ part_index: 1, part_kind: 'function_call', signature: 'sig', tool_call_index: 0, tool_call_id: 'c1', tool_name: 'time_now' }],
      map,
    )
    expect(mapped.thoughtSignatures?.[0]?.tool_name).toBe('time.now')
  })

  it('没有工具调用时两个字段都不出现', () => {
    const map = createToolNameMap([], 'openai')
    expect(mapResultToolNames(undefined, undefined, map)).toEqual({})
  })
})

describe('toolNameMapFor', () => {
  it('把历史里出现过的调用名也纳入映射（多轮回填要用 wire 名）', () => {
    const map = toolNameMapFor(
      {
        messages: [{ role: 'assistant', content: '', tool_calls: [{ id: 'c1', name: 'vfs.read_file', arguments: '{}' }] }],
      },
      'openai',
    )
    expect(map.toWire('vfs.read_file')).toBe('vfs_read_file')
  })
})

describe('LLM 发出去的请求里工具名一定合法', () => {
  /**
   * 端到端断言：真实故障是「插件传 `time.now` → 上游 400」。
   * 这里直接检查实际上到 fetch 的请求体，确保 tools 名字已经是合法标识符。
   */
  it('chat：tools[].name 换成合法标识符，回包再换回内部名', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        choices: [
          {
            message: {
              content: '',
              tool_calls: [{ id: 'c1', type: 'function', function: { name: 'time_now', arguments: '{}' } }],
            },
            finish_reason: 'tool_calls',
          },
        ],
      }),
    )
    const llm = client(fetchMock as unknown as typeof fetch)
    const result = await llm.chat({
      model: 'chat',
      messages: [{ role: 'user', content: '现在几点' }],
      tools: [{ name: 'time.now', description: '当前时间', parameters: { type: 'object', properties: {} } }],
    })

    // 发出去的是合法的 wire 名
    const body = sentBody(fetchMock)
    const tools = body['tools'] as Array<{ function: { name: string; description: string } }>
    expect(tools[0]?.function.name).toBe('time_now')
    expect(tools[0]?.function.name).toMatch(WIRE_TOOL_NAME_PATTERN)
    expect(tools[0]?.function.description).toContain('Internal tool name: time.now.')

    // 回给调用方的仍是内部名
    expect(result.tool_calls?.[0]?.name).toBe('time.now')
  })

  it('chat：多轮回填时历史里的 tool_calls 也用 wire 名', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }),
    )
    const llm = client(fetchMock as unknown as typeof fetch)
    await llm.chat({
      model: 'chat',
      messages: [
        { role: 'user', content: '现在几点' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'c1', name: 'time.now', arguments: '{}' }],
        },
        { role: 'tool', content: '12:00', tool_call_id: 'c1' },
      ],
      tools: [{ name: 'time.now', parameters: { type: 'object' } }],
    })

    const body = sentBody(fetchMock)
    const messages = body['messages'] as Array<{ role: string; tool_calls?: Array<{ function: { name: string } }> }>
    const assistant = messages.find((m) => m.role === 'assistant')
    expect(assistant?.tool_calls?.[0]?.function.name).toBe('time_now')
  })

  it('chat：tool_choice 指向的工具名同样被换成 wire 名', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }),
    )
    const llm = client(fetchMock as unknown as typeof fetch)
    await llm.chat({
      model: 'chat',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 'time.now', parameters: { type: 'object' } }],
      tool_choice: { name: 'time.now' },
    })
    expect(sentBody(fetchMock)['tool_choice']).toEqual({ type: 'function', function: { name: 'time_now' } })
  })

  it('stream：流式增量里的名字换回内部名', async () => {
    const encoder = new TextEncoder()
    const lines = [
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'time_now' } }] } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{}' } }] } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\n`,
    ]
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            for (const line of lines) controller.enqueue(encoder.encode(line))
            controller.close()
          },
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      ),
    )

    const llm = client(fetchMock as unknown as typeof fetch)
    const events = []
    for await (const event of llm.stream({
      model: 'chat',
      messages: [{ role: 'user', content: '现在几点' }],
      tools: [{ name: 'time.now', parameters: { type: 'object' } }],
    })) {
      events.push(event)
    }

    const deltas = events.filter((e) => e.type === 'tool_call_delta')
    expect(deltas[0]).toMatchObject({ name: 'time.now' })

    const done = events.find((e) => e.type === 'done')
    expect(done).toMatchObject({ result: { tool_calls: [{ name: 'time.now' }] } })
  })
})
