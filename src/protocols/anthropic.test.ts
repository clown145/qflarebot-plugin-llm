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

/**
 * P1-2 回归：Anthropic 开启 extended thinking 时，`temperature` / `top_p` 都有硬约束。
 *
 * 上游的规则是：`temperature` 只能为 1；`top_p` 只能在 0.95–1。
 * 而 `service.prepare()` 会从模型配置**自动**填 temperature，`ping()` 过去还硬编码 0，
 * 所以「配了思考等级的 Anthropic 模型，一点测试就 400」是必然的。这里守两条行为：
 * 不合法的值**丢弃**（= 让上游用默认的 1），合法的值原样保留。
 */
describe('anthropic thinking + temperature/top_p 硬约束（P1-2）', () => {
  const thinkingTarget: Target = { ...target, model: { ...target.model, reasoning_effort: 'medium' } }
  const bodyOf = (built: { init: RequestInit }) => JSON.parse(built.init.body as string) as Record<string, unknown>

  it('开启思考时丢弃 temperature: 0（ping 的硬编码值），不发该字段', () => {
    const body = bodyOf(anthropic.buildChat(thinkingTarget, {
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 16,
      temperature: 0,
    }, false))
    expect(body['thinking']).toMatchObject({ type: 'enabled' })
    expect('temperature' in body).toBe(false)
  })

  it('开启思考时丢弃 0.7 这类非法 temperature', () => {
    const body = bodyOf(anthropic.buildChat(thinkingTarget, {
      messages: [{ role: 'user', content: 'x' }],
      temperature: 0.7,
    }, false))
    expect('temperature' in body).toBe(false)
  })

  it('开启思考时保留 temperature: 1（上游唯一接受的取值）', () => {
    const body = bodyOf(anthropic.buildChat(thinkingTarget, {
      messages: [{ role: 'user', content: 'x' }],
      temperature: 1,
    }, false))
    expect(body['temperature']).toBe(1)
  })

  it('开启思考时丢弃 top_p: 0.9，保留合法的 0.95–1', () => {
    const dropped = bodyOf(anthropic.buildChat(thinkingTarget, {
      messages: [{ role: 'user', content: 'x' }],
      top_p: 0.9,
    }, false))
    expect('top_p' in dropped).toBe(false)

    const kept = bodyOf(anthropic.buildChat(thinkingTarget, {
      messages: [{ role: 'user', content: 'x' }],
      top_p: 0.95,
    }, false))
    expect(kept['top_p']).toBe(0.95)
  })

  it('没开思考时 temperature/top_p 原样透传（不能被这条修复误伤）', () => {
    const body = bodyOf(anthropic.buildChat(target, {
      messages: [{ role: 'user', content: 'x' }],
      temperature: 0,
      top_p: 0.5,
    }, false))
    expect('thinking' in body).toBe(false)
    expect(body['temperature']).toBe(0)
    expect(body['top_p']).toBe(0.5)
  })
})

/**
 * P1-4 回归：开启思考时 Anthropic 只支持 `tool_choice: auto`（`any` / `tool` 都会 400）。
 *
 * 旧实现无条件下发 `{type:'any'}` 或 `{type:'tool', name}`，于是「思考 + 强制工具调用」
 * 的组合必炸。现在降级为 auto 并通过 hooks 告警，让用户知道行为变了。
 */
describe('anthropic thinking + 强制 tool_choice 降级（P1-4）', () => {
  const thinkingTarget: Target = { ...target, model: { ...target.model, reasoning_effort: 'low' } }
  const tools = [{ name: 'lookup', parameters: { type: 'object', properties: {} } }]

  it('required 在开启思考时降级为 auto，并触发 warn', () => {
    const warns: string[] = []
    const built = anthropic.buildChat(thinkingTarget, {
      messages: [{ role: 'user', content: 'x' }],
      tools,
      tool_choice: 'required',
    }, false, { warn: (message) => warns.push(message) })
    const body = JSON.parse(built.init.body as string)
    expect(body['thinking']).toMatchObject({ type: 'enabled' })
    expect(body['tool_choice']).toEqual({ type: 'auto' })
    expect(warns).toHaveLength(1)
    expect(warns[0]).toContain('降级')
  })

  it('指定工具名在开启思考时同样降级为 auto', () => {
    const warns: string[] = []
    const built = anthropic.buildChat(thinkingTarget, {
      messages: [{ role: 'user', content: 'x' }],
      tools,
      tool_choice: { name: 'lookup' },
    }, false, { warn: (message) => warns.push(message) })
    const body = JSON.parse(built.init.body as string)
    expect(body['tool_choice']).toEqual({ type: 'auto' })
    expect(warns).toHaveLength(1)
  })

  it('没开思考时 required / 指定工具仍然原样映射（不降级、不告警）', () => {
    const warns: string[] = []
    const required = anthropic.buildChat(target, {
      messages: [{ role: 'user', content: 'x' }],
      tools,
      tool_choice: 'required',
    }, false, { warn: (message) => warns.push(message) })
    expect(JSON.parse(required.init.body as string)['tool_choice']).toEqual({ type: 'any' })

    const named = anthropic.buildChat(target, {
      messages: [{ role: 'user', content: 'x' }],
      tools,
      tool_choice: { name: 'lookup' },
    }, false, { warn: (message) => warns.push(message) })
    expect(JSON.parse(named.init.body as string)['tool_choice']).toEqual({ type: 'tool', name: 'lookup' })
    expect(warns).toEqual([])
  })
})

/**
 * P1-3 回归：Anthropic 多轮工具调用必须把上一轮的 thinking block **原样回传**，
 * 且必须排在 assistant `content` 的最前面。缺了上游直接：
 *
 *   Expected `thinking` or `redacted_thinking`, but found `tool_use`
 *
 * 旧实现解析时把 signature 丢掉、回传时又把整个 thinking 忽略，所以「思考 + 工具」
 * 的第二轮必然 400。这里覆盖 thinking、redacted_thinking 两条路径以及完整往返。
 */
describe('anthropic thinking block 往返（P1-3）', () => {
  it('parseResponse 保留 thinking 的正文与签名，并给出 part_index', () => {
    const parsed = anthropic.parseResponse({
      content: [
        { type: 'thinking', thinking: '先想一下', signature: 'sig-abc' },
        { type: 'tool_use', id: 'c1', name: 'lookup', input: { q: 'x' } },
      ],
      stop_reason: 'tool_use',
    })
    expect(parsed.reasoning).toBe('先想一下')
    expect(parsed.reasoningSignatures).toEqual([
      { part_index: 0, block_type: 'thinking', thinking: '先想一下', signature: 'sig-abc' },
    ])
  })

  it('parseResponse 保留 redacted_thinking 的 data', () => {
    const parsed = anthropic.parseResponse({
      content: [
        { type: 'redacted_thinking', data: 'ENCRYPTED-PAYLOAD' },
        { type: 'text', text: '答' },
      ],
      stop_reason: 'end_turn',
    })
    expect(parsed.reasoningSignatures).toEqual([
      { part_index: 0, block_type: 'redacted_thinking', data: 'ENCRYPTED-PAYLOAD' },
    ])
    // redacted 的内容不解密、也不进 reasoning
    expect(parsed.reasoning).toBeUndefined()
  })

  it('回传时 thinking block 排在 tool_use 之前（上游的硬性顺序）', () => {
    const built = anthropic.buildChat(target, {
      messages: [
        { role: 'user', content: '查天气' },
        {
          role: 'assistant',
          content: '好的',
          reasoning_signatures: [{ part_index: 0, block_type: 'thinking', thinking: '先想', signature: 'sig-1' }],
          tool_calls: [{ id: 'c1', name: 'lookup', arguments: '{"q":"x"}' }],
        },
        { role: 'tool', tool_call_id: 'c1', content: '结果' },
      ],
    }, false)
    const body = JSON.parse(built.init.body as string)
    expect(body.messages[1].content).toEqual([
      { type: 'thinking', thinking: '先想', signature: 'sig-1' },
      { type: 'text', text: '好的' },
      { type: 'tool_use', id: 'c1', name: 'lookup', input: { q: 'x' } },
    ])
  })

  it('redacted_thinking 同样能回传', () => {
    const built = anthropic.buildChat(target, {
      messages: [
        { role: 'user', content: 'x' },
        {
          role: 'assistant',
          reasoning_signatures: [{ part_index: 0, block_type: 'redacted_thinking', data: 'ENC' }],
          tool_calls: [{ id: 'c1', name: 't', arguments: '{}' }],
        },
      ],
    }, false)
    const body = JSON.parse(built.init.body as string)
    expect(body.messages[1].content[0]).toEqual({ type: 'redacted_thinking', data: 'ENC' })
  })

  it('缺签名或 data 的残缺签名被丢弃，不发出必定 400 的 block', () => {
    const built = anthropic.buildChat(target, {
      messages: [
        { role: 'user', content: 'x' },
        {
          role: 'assistant',
          content: '答',
          // 调用方没存全：thinking 有正文没签名 / redacted 没有 data
          reasoning_signatures: [
            { part_index: 0, block_type: 'thinking', thinking: '想' },
            { part_index: 1, block_type: 'redacted_thinking' },
          ],
        },
      ],
    }, false)
    const body = JSON.parse(built.init.body as string)
    expect(body.messages[1].content).toEqual([{ type: 'text', text: '答' }])
  })

  it('完整往返：解析 → 回传后请求体里仍是同一对 thinking/signature', () => {
    const first = anthropic.parseResponse({
      content: [
        { type: 'thinking', thinking: '思考内容', signature: 'sig-round' },
        { type: 'tool_use', id: 'c1', name: 'lookup', input: { q: 'x' } },
      ],
      stop_reason: 'tool_use',
    })
    const built = anthropic.buildChat(target, {
      messages: [
        { role: 'user', content: '查' },
        {
          role: 'assistant',
          content: first.text,
          reasoning_signatures: first.reasoningSignatures,
          tool_calls: first.toolCalls,
        },
        { role: 'tool', tool_call_id: 'c1', content: '结果' },
      ],
    }, false)
    const body = JSON.parse(built.init.body as string)
    expect(body.messages[1].content[0]).toEqual({
      type: 'thinking',
      thinking: '思考内容',
      signature: 'sig-round',
    })
  })

  it('流式：thinking_delta + signature_delta 在 content_block_stop 合成 reasoning_signature', async () => {
    const out = await events([
      'event: content_block_start\ndata: {"index":0,"content_block":{"type":"thinking","thinking":""}}\n\n',
      'event: content_block_delta\ndata: {"index":0,"delta":{"type":"thinking_delta","thinking":"先想"}}\n\n',
      'event: content_block_delta\ndata: {"index":0,"delta":{"type":"signature_delta","signature":"sig-stream"}}\n\n',
      'event: content_block_stop\ndata: {"index":0}\n\n',
    ])
    expect(out.filter((item) => item.type === 'reasoning_signature')).toEqual([
      { type: 'reasoning_signature', part_index: 0, block_type: 'thinking', thinking: '先想', signature: 'sig-stream' },
    ])
    // 正文增量仍然照常给调用方展示
    expect(out.filter((item) => item.type === 'reasoning_delta')).toEqual([{ type: 'reasoning_delta', text: '先想' }])
  })

  it('流式：redacted_thinking 在 content_block_start 就能透出', async () => {
    const out = await events([
      'event: content_block_start\ndata: {"index":0,"content_block":{"type":"redacted_thinking","data":"ENC"}}\n\n',
    ])
    expect(out.filter((item) => item.type === 'reasoning_signature')).toEqual([
      { type: 'reasoning_signature', part_index: 0, block_type: 'redacted_thinking', data: 'ENC' },
    ])
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

/**
 * 调用方通过 `extra_body` 自己指定 thinking 预算时的自洽性。
 *
 * `extra_body` 是「调用方更具体所以优先」，但优先不能变成「发出一个必 400 的组合」：
 * Anthropic 要求 `budget_tokens < max_tokens`。
 */
describe('extra_body 的 thinking 预算也要与 max_tokens 自洽', () => {
  const bodyOf = (built: { init: RequestInit }) => JSON.parse(built.init.body as string) as Record<string, unknown>

  it('调用方给了更大的预算时，max_tokens 被抬到大于预算', () => {
    const body = bodyOf(anthropic.buildChat(target, {
      messages: [{ role: 'user', content: 'x' }],
      extra_body: { thinking: { type: 'enabled', budget_tokens: 30000 } },
    }, false))
    expect(body['thinking']).toEqual({ type: 'enabled', budget_tokens: 30000 })
    expect(body['max_tokens'] as number).toBeGreaterThan(30000)
  })

  it('模型输出上限放不下这个预算时，放弃 thinking 并告警（不发必 400 的组合）', () => {
    const warns: string[] = []
    const body = bodyOf(anthropic.buildChat(
      { ...target, model: { ...target.model, max_output_tokens: 8192 } },
      {
        messages: [{ role: 'user', content: 'x' }],
        extra_body: { thinking: { type: 'enabled', budget_tokens: 30000 } },
      },
      false,
      { warn: (message) => warns.push(message) },
    ))
    expect('thinking' in body).toBe(false)
    expect(body['max_tokens']).toBe(8192)
    expect(warns).toHaveLength(1)
  })
})
