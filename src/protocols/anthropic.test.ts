import { describe, expect, it } from 'vitest'
import { anthropic } from './anthropic.js'
import type { ParsedStreamEvent, Target } from './types.js'

const target: Target = {
  provider: {
    id: 'a',
    name: 'A',
    protocol: 'anthropic',
    base_url: 'https://api.test/v1',
    api_key: 'sk-ant',
    enabled: true,
  },
  model: { alias: 'chat', provider: 'a', model: 'claude', enabled: true },
}

function bodyOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
}

async function events(chunks: string[]): Promise<ParsedStreamEvent[]> {
  const out: ParsedStreamEvent[] = []
  for await (const event of anthropic.parseStream(bodyOf(chunks))) out.push(event)
  return out
}

describe('anthropic.buildChat', () => {
  it('system 抽到顶层，连续同角色合并，max_tokens 有默认值', () => {
    const built = anthropic.buildChat(target, {
      messages: [
        { role: 'system', content: '规则一' },
        { role: 'system', content: '规则二' },
        { role: 'user', content: 'a' },
        { role: 'user', content: 'b' },
      ],
    }, false)
    const body = JSON.parse(built.init.body as string)
    expect((built.init.headers as Record<string, string>)['x-api-key']).toBe('sk-ant')
    expect((built.init.headers as Record<string, string>)['anthropic-version']).toBe('2023-06-01')
    expect(body.system).toBe('规则一\n\n规则二')
    // 未传 max_tokens 时用兜底值；旧实现的 1024 会静默截断长回答
    expect(body.max_tokens).toBe(4096)
    expect(body.messages).toHaveLength(1)
    expect(body.messages[0].content).toEqual([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])
  })

  it('max_tokens 优先取请求值，其次模型配置的输出上限', () => {
    const withRequest = anthropic.buildChat(target, {
      messages: [{ role: 'user', content: 'x' }],
      max_tokens: 512,
    }, false)
    expect(JSON.parse(withRequest.init.body as string).max_tokens).toBe(512)

    const configured = anthropic.buildChat(
      { ...target, model: { ...target.model, max_output_tokens: 8192 } },
      { messages: [{ role: 'user', content: 'x' }] },
      false,
    )
    expect(JSON.parse(configured.init.body as string).max_tokens).toBe(8192)
  })

  it("tool_choice: 'none' 时不发送 tools（Anthropic 没有 none 类型）", () => {
    const built = anthropic.buildChat(target, {
      messages: [{ role: 'user', content: 'x' }],
      tools: [{ name: 'lookup', parameters: { type: 'object', properties: {} } }],
      tool_choice: 'none',
    }, false)
    const body = JSON.parse(built.init.body as string)
    expect(body.tools).toBeUndefined()
    expect(body.tool_choice).toBeUndefined()
  })

  it('图片片段转 base64 source，音频片段抛 unsupported', () => {
    const built = anthropic.buildChat(target, {
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: '看图' },
          { type: 'image', data: 'AAAA', media_type: 'image/png' },
        ],
      }],
    }, false)
    const body = JSON.parse(built.init.body as string)
    expect(body.messages[0].content).toEqual([
      { type: 'text', text: '看图' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
    ])

    expect(() =>
      anthropic.buildChat(target, {
        messages: [{ role: 'user', content: [{ type: 'audio', data: 'AAAA', format: 'wav' }] }],
      }, false),
    ).toThrow(/unsupported|音频/)
  })

  it('file 片段转 document source', () => {
    const built = anthropic.buildChat(target, {
      messages: [{ role: 'user', content: [{ type: 'file', url: 'https://x.test/a.pdf', media_type: 'application/pdf' }] }],
    }, false)
    const body = JSON.parse(built.init.body as string)
    expect(body.messages[0].content).toEqual([
      { type: 'document', source: { type: 'url', url: 'https://x.test/a.pdf' } },
    ])
  })

  it('data: URI 的图片拆回 base64 source（url source 只接受 https，原样透传必 400）', () => {
    const built = anthropic.buildChat(target, {
      messages: [{ role: 'user', content: [{ type: 'image', url: 'data:image/png;base64,AAAA' }] }],
    }, false)
    const body = JSON.parse(built.init.body as string)
    expect(body.messages[0].content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
    ])
  })

  it('file 片段的 filename 落到 document 的 title；data URI 文件同样拆回 base64', () => {
    const built = anthropic.buildChat(target, {
      messages: [{ role: 'user', content: [{ type: 'file', url: 'data:application/pdf;base64,AAEC', filename: 'notes.pdf' }] }],
    }, false)
    const body = JSON.parse(built.init.body as string)
    expect(body.messages[0].content).toEqual([
      { type: 'document', title: 'notes.pdf', source: { type: 'base64', media_type: 'application/pdf', data: 'AAEC' } },
    ])
  })

  it('https url 原样透传为 url source，不受 data URI 拆解影响', () => {
    const built = anthropic.buildChat(target, {
      messages: [{ role: 'user', content: [{ type: 'image', url: 'https://x.test/cat.png' }] }],
    }, false)
    const body = JSON.parse(built.init.body as string)
    expect(body.messages[0].content).toEqual([
      { type: 'image', source: { type: 'url', url: 'https://x.test/cat.png' } },
    ])
  })

  it('工具定义、tool_use 与 tool_result 的映射', () => {
    const built = anthropic.buildChat(target, {
      messages: [
        { role: 'user', content: '查一下' },
        {
          role: 'assistant',
          content: '好的',
          tool_calls: [{ id: 'c1', name: 'lookup', arguments: '{"q":"x"}' }],
        },
        { role: 'tool', tool_call_id: 'c1', content: '结果' },
      ],
      tools: [{ name: 'lookup', description: '查', parameters: { type: 'object', properties: {} } }],
      tool_choice: 'required',
    }, true)
    const body = JSON.parse(built.init.body as string)
    expect(body.stream).toBe(true)
    expect(body.tools[0]).toEqual({
      name: 'lookup',
      description: '查',
      input_schema: { type: 'object', properties: {} },
    })
    expect(body.tool_choice).toEqual({ type: 'any' })
    expect(body.messages[1]).toEqual({
      role: 'assistant',
      content: [
        { type: 'text', text: '好的' },
        { type: 'tool_use', id: 'c1', name: 'lookup', input: { q: 'x' } },
      ],
    })
    expect(body.messages[2]).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'c1', content: '结果' }],
    })
  })

  it('工具参数不是 JSON 对象时报 bad_request', () => {
    expect(() =>
      anthropic.buildChat(target, {
        messages: [
          { role: 'user', content: 'x' },
          { role: 'assistant', tool_calls: [{ id: 'c', name: 't', arguments: 'not-json' }] },
        ],
      }, false),
    ).toThrow(/bad_request|JSON/)
  })
})

describe('anthropic.parseResponse', () => {
  it('文本块拼接、tool_use 归一化', () => {
    const parsed = anthropic.parseResponse({
      content: [
        { type: 'text', text: '你' },
        { type: 'text', text: '好' },
        { type: 'tool_use', id: 'c1', name: 'lookup', input: { q: 'x' } },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 2, output_tokens: 3 },
    })
    expect(parsed.text).toBe('你好')
    expect(parsed.toolCalls?.[0]).toEqual({ id: 'c1', name: 'lookup', arguments: '{"q":"x"}' })
    expect(parsed.finishReason).toBe('tool_calls')
    expect(parsed.usage).toEqual({ input_tokens: 2, output_tokens: 3, total_tokens: 5 })
  })
})

describe('anthropic.parseStream', () => {
  it('解析 message_start / content_block / message_delta / stop', async () => {
    const out = await events([
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":2,"output_tokens":0}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"c1","name":"lookup"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"q\\":"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\"x\\"}"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"好"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":3}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ])
    expect(out.filter((item) => item.type === 'tool_call_delta')).toEqual([
      { type: 'tool_call_delta', index: 0, id: 'c1', name: 'lookup' },
      { type: 'tool_call_delta', index: 0, argumentsDelta: '{"q":' },
      { type: 'tool_call_delta', index: 0, argumentsDelta: '"x"}' },
    ])
    expect(out.filter((item) => item.type === 'text_delta')).toEqual([{ type: 'text_delta', text: '好' }])
    expect(out.some((item) => item.type === 'finish' && item.reason === 'tool_calls')).toBe(true)
    expect(out.some((item) => item.type === 'usage')).toBe(true)
  })

  it('上游 error 事件会抛错', async () => {
    await expect(events(['event: error\ndata: {"type":"error","error":{"message":"boom"}}\n\n'])).rejects.toThrow(/boom/)
  })

  it('error 事件按上游类型映射错误码', async () => {
    const cases = [
      ['rate_limit_error', 'rate_limit'],
      ['authentication_error', 'auth'],
      ['permission_error', 'auth'],
      ['invalid_request_error', 'bad_request'],
      ['overloaded_error', 'upstream'],
    ] as const
    for (const [type, code] of cases) {
      const error = await events([
        `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type, message: 'x' } })}\n\n`,
      ]).catch((err: unknown) => err)
      expect(error).toMatchObject({ code, detail: type })
    }
  })
})

describe('anthropic.parseListModels', () => {
  it('读 data[].id', () => {
    expect(anthropic.parseListModels({ data: [{ id: 'a' }, { id: 'b' }] })).toEqual(['a', 'b'])
  })
})

describe('anthropic 推理内容与错误脱敏', () => {
  it('parseResponse 把 thinking block 拼进 reasoning', () => {
    const parsed = anthropic.parseResponse({
      content: [
        { type: 'thinking', thinking: '先想一下' },
        { type: 'text', text: '答案' },
      ],
      stop_reason: 'end_turn',
    })
    expect(parsed.reasoning).toBe('先想一下')
    expect(parsed.text).toBe('答案')
  })

  it('thinking_delta 产出 reasoning_delta', async () => {
    const out = await events([
      'event: content_block_delta\ndata: {"index":0,"delta":{"type":"thinking_delta","thinking":"嗯"}}\n\n',
      'event: content_block_delta\ndata: {"index":0,"delta":{"type":"text_delta","text":"好"}}\n\n',
    ])
    expect(out.filter((item) => item.type === 'reasoning_delta')).toEqual([{ type: 'reasoning_delta', text: '嗯' }])
    expect(out.filter((item) => item.type === 'text_delta')).toEqual([{ type: 'text_delta', text: '好' }])
  })

  it('流式 error 的 message 会被脱敏', async () => {
    const error = await events([
      'event: error\ndata: {"type":"error","error":{"type":"authentication_error","message":"invalid key sk-ant-SECRET123"}}\n\n',
    ]).catch((err: unknown) => err)
    expect(String((error as Error).message)).not.toContain('sk-ant-SECRET123')
  })

  it('parseStream 的第二个参数能传入 apiKey 做精确脱敏', async () => {
    const body = bodyOf([
      'event: error\ndata: {"type":"error","error":{"type":"authentication_error","message":"bad key sk-ant-SECRET123"}}\n\n',
    ])
    const error = await (async () => {
      for await (const _event of anthropic.parseStream(body, { apiKey: 'sk-ant-SECRET123' })) void _event
    })().catch((err: unknown) => err)
    expect(String((error as Error).message)).not.toContain('SECRET123')
  })
})
