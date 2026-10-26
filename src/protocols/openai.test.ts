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
})

describe('openai.parseListModels', () => {
  it('认 data / models / 字符串数组', () => {
    expect(openai.parseListModels({ data: [{ id: 'a' }, { id: 'b' }] })).toEqual(['a', 'b'])
    expect(openai.parseListModels({ models: [{ id: 'c' }] })).toEqual(['c'])
    expect(openai.parseListModels(['d'])).toEqual(['d'])
  })
})
