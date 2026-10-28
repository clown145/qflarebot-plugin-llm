import { describe, expect, it } from 'vitest'
import { openai } from './openai.js'
import type { Target } from './types.js'
import type { ParsedStreamEvent } from './types.js'

const target: Target = {
  provider: {
    id: 'p',
    name: 'P',
    protocol: 'openai',
    base_url: 'https://api.test/v1',
    api_key: 'sk-test',
    enabled: true,
  },
  model: { alias: 'chat', provider: 'p', model: 'm', enabled: true },
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
  for await (const event of openai.parseStream(bodyOf(chunks))) out.push(event)
  return out
}

describe('openai.buildChat', () => {
  it('拼 URL、鉴权与基础字段', () => {
    const built = openai.buildChat(target, { messages: [{ role: 'user', content: 'hi' }] }, false)
    const init = built.init
    expect(built.url).toBe('https://api.test/v1/chat/completions')
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer sk-test')
    const body = JSON.parse(init.body as string)
    expect(body.model).toBe('m')
    expect(body.stream).toBe(false)
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }])
  })

  it('工具、JSON 与 extra_body 的合并顺序', () => {
    const built = openai.buildChat(target, {
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 'lookup', description: '查', parameters: { type: 'object', properties: {} } }],
      tool_choice: { name: 'lookup' },
      json: true,
      extra_body: { model: 'evil', temperature: 0.2 },
    }, true)
    const body = JSON.parse(built.init.body as string)
    expect(body.model).toBe('m')
    expect(body.stream).toBe(true)
    expect(body.temperature).toBe(0.2)
    expect(body.response_format).toEqual({ type: 'json_object' })
    expect(body.tool_choice).toEqual({ type: 'function', function: { name: 'lookup' } })
    expect(body.tools[0].function.name).toBe('lookup')
  })
})

describe('openai.parseResponse', () => {
  it('解析文本、工具调用、用量与 finish_reason', () => {
    const parsed = openai.parseResponse({
      choices: [{
        message: {
          role: 'assistant',
          content: 'hello',
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } }],
        },
        finish_reason: 'tool_calls',
      }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    })
    expect(parsed.text).toBe('hello')
    expect(parsed.toolCalls?.[0]).toEqual({ id: 'c1', name: 'lookup', arguments: '{"q":"x"}' })
    expect(parsed.finishReason).toBe('tool_calls')
    expect(parsed.usage).toEqual({ input_tokens: 3, output_tokens: 2, total_tokens: 5 })
  })

  it('content 是分段数组时拼文本', () => {
    const parsed = openai.parseResponse({ choices: [{ message: { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] } }] })
    expect(parsed.text).toBe('ab')
  })
})

describe('openai.parseStream', () => {
  it('解析文本、工具参数、用量与结束', async () => {
    const out = await events([
      'data: {"choices":[{"delta":{"content":"你"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"好"}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"lookup","arguments":"{\\"q\\":"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"x\\"}"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3}}\n\n',
      'data: [DONE]\n\n',
    ])
    expect(out.filter((item) => item.type === 'text_delta')).toEqual([
      { type: 'text_delta', text: '你' },
      { type: 'text_delta', text: '好' },
    ])
    const tool = out.filter((item) => item.type === 'tool_call_delta')
    expect(tool[0]).toMatchObject({ index: 0, id: 'c1', name: 'lookup' })
    expect(tool[0]).toHaveProperty('argumentsDelta')
    expect(out.some((item) => item.type === 'finish' && item.reason === 'tool_calls')).toBe(true)
    expect(out.some((item) => item.type === 'usage')).toBe(true)
  })

  it('坏 JSON 会抛错', async () => {
    await expect(events(['data: {oops}\n\n'])).rejects.toThrow(/合法 JSON/)
  })

  it('[DONE] 带尾随空白（部分代理会加）也能正常结束，不落进 JSON 解析', async () => {
    const out = await events([
      'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
      'data: [DONE] \n\n',
    ])
    expect(out).toEqual([{ type: 'text_delta', text: 'ok' }])
  })
})

describe('openai.parseListModels', () => {
  it('认 data / models / 字符串数组', () => {
    expect(openai.parseListModels({ data: [{ id: 'a' }, { id: 'b' }] })).toEqual(['a', 'b'])
    expect(openai.parseListModels({ models: [{ id: 'c' }] })).toEqual(['c'])
    expect(openai.parseListModels(['d'])).toEqual(['d'])
  })
})

describe('openai 流内错误与推理内容', () => {
  it('HTTP 200 流里的 error 事件会抛 LLMError，而不是被静默丢弃', async () => {
    // OpenRouter / 中转 / vLLM 常在 200 的 SSE 里下发配额或鉴权错误
    const error = await events([
      'data: {"error":{"message":"quota exceeded","type":"insufficient_quota"}}\n\n',
      'data: [DONE]\n\n',
    ]).catch((err: unknown) => err)
    expect(error).toMatchObject({ code: 'rate_limit' })
    expect(String((error as Error).message)).toContain('quota exceeded')
  })

  it('鉴权类流内错误映射成 auth', async () => {
    const error = await events([
      'data: {"error":{"message":"invalid api key","type":"invalid_api_key"}}\n\n',
    ]).catch((err: unknown) => err)
    expect(error).toMatchObject({ code: 'auth' })
  })

  it('流内错误的 message 会被脱敏', async () => {
    const body = bodyOf([
      'data: {"error":{"message":"bad key sk-SECRET12345678","type":"invalid_api_key"}}\n\n',
    ])
    const error = await (async () => {
      for await (const _event of openai.parseStream(body, { apiKey: 'sk-SECRET12345678' })) void _event
    })().catch((err: unknown) => err)
    expect(String((error as Error).message)).not.toContain('sk-SECRET12345678')
  })

  it('reasoning_content 解析进 parsed.reasoning', () => {
    const parsed = openai.parseResponse({
      choices: [{ message: { content: '答案', reasoning_content: '先想一下' }, finish_reason: 'stop' }],
    })
    expect(parsed.reasoning).toBe('先想一下')
    expect(parsed.text).toBe('答案')
  })

  it('delta 里的 reasoning_content 产出 reasoning_delta', async () => {
    const out = await events([
      'data: {"choices":[{"delta":{"reasoning_content":"嗯"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"好"}}]}\n\n',
    ])
    expect(out.filter((item) => item.type === 'reasoning_delta')).toEqual([{ type: 'reasoning_delta', text: '嗯' }])
  })

  it('兼容网关用 reasoning 字段时同样识别', () => {
    expect(openai.parseResponse({ choices: [{ message: { content: 'a', reasoning: 'r' } }] }).reasoning).toBe('r')
  })
})

describe('openai 工具调用 id 唯一性', () => {
  it('两条没有 id 的调用会得到不同的兜底 id', () => {
    const parsed = openai.parseResponse({
      choices: [{
        message: {
          content: '',
          tool_calls: [
            { function: { name: 'a', arguments: '{}' } },
            { function: { name: 'b', arguments: '{}' } },
          ],
        },
        finish_reason: 'tool_calls',
      }],
    })
    const ids = parsed.toolCalls?.map((call) => call.id) ?? []
    expect(ids).toHaveLength(2)
    expect(new Set(ids).size).toBe(2)
  })
})

describe('openai 多模态内容', () => {
  it('图片片段转成 image_url', () => {
    const built = openai.buildChat(target, {
      messages: [{ role: 'user', content: [{ type: 'image', url: 'https://x.test/a.png', detail: 'low' }] }],
    }, false)
    const body = JSON.parse(built.init.body as string)
    expect(body.messages[0].content).toEqual([
      { type: 'image_url', image_url: { url: 'https://x.test/a.png', detail: 'low' } },
    ])
  })

  it('data + media_type 拼成 data URI', () => {
    const built = openai.buildChat(target, {
      messages: [{ role: 'user', content: [{ type: 'image', data: 'AAAA', media_type: 'image/png' }] }],
    }, false)
    const body = JSON.parse(built.init.body as string)
    expect(body.messages[0].content[0].image_url.url).toBe('data:image/png;base64,AAAA')
  })

  it('音频片段转成 input_audio', () => {
    const built = openai.buildChat(target, {
      messages: [{ role: 'user', content: [{ type: 'audio', data: 'AAAA', format: 'wav' }] }],
    }, false)
    const body = JSON.parse(built.init.body as string)
    expect(body.messages[0].content).toEqual([{ type: 'input_audio', input_audio: { data: 'AAAA', format: 'wav' } }])
  })

  it('file 片段抛 unsupported（OpenAI 兼容协议不支持）', () => {
    expect(() =>
      openai.buildChat(target, {
        messages: [{ role: 'user', content: [{ type: 'file', url: 'https://x.test/a.pdf' }] }],
      }, false),
    ).toThrow(/unsupported|不支持/)
  })

  it('单个 text 片段直接压成字符串', () => {
    const built = openai.buildChat(target, {
      messages: [{ role: 'user', content: [{ type: 'text', text: '只有文本' }] }],
    }, false)
    const body = JSON.parse(built.init.body as string)
    expect(body.messages[0].content).toBe('只有文本')
  })
})
