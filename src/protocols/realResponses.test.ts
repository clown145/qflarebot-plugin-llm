/**
 * 用**真实上游响应**做回归样本。
 *
 * 之前测试里的响应样本是手写构造的，等于拿「自己以为的格式」验证自己——
 * Gemini 的 `functionCall`（camelCase）问题就是这样漏掉的：测试全用 snake_case，
 * 真实端点从不返回那个形状，于是工具调用被静默丢弃而测试全绿。
 *
 * 这个文件里的 JSON 全部来自对真实端点的请求（经兼容网关，
 * 三个协议各自的原生形状）。改动解析逻辑时它们会先亮红灯。
 */
import { describe, expect, it } from 'vitest'
import { anthropic } from './anthropic.js'
import { gemini } from './gemini.js'
import { openai } from './openai.js'

function sseBody(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
}

async function collect(stream: AsyncIterable<{ type: string }>) {
  const out: Array<{ type: string } & Record<string, unknown>> = []
  for await (const event of stream) out.push(event as never)
  return out
}

describe('OpenAI 协议：真实响应', () => {
  it('工具调用（content 为 null，finish_reason 为 tool_calls）', () => {
    const parsed = openai.parseResponse({
      id: '76_kaqF8797T', object: 'chat.completion', created: 0, model: 'gemini-3.8-flash-n',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          reasoning_content: null,
          tool_calls: [{
            id: 'call_662822',
            type: 'function',
            function: { name: 'get_weather', arguments: '{\n  "city": "北京"\n}' },
          }],
        },
        finish_reason: 'tool_calls',
        native_finish_reason: 'tool_calls',
      }],
      usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
    })
    expect(parsed.toolCalls).toEqual([
      { id: 'call_662822', name: 'get_weather', arguments: '{\n  "city": "北京"\n}' },
    ])
    expect(parsed.finishReason).toBe('tool_calls')
    expect(parsed.text).toBe('')
  })

  it('流式：tool_calls delta + usage（含 reasoning_tokens）+ finish', async () => {
    const out = await collect(openai.parseStream(sseBody([
      'data: {"id":"x","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":null,"tool_calls":[{"id":"call_1198225","index":0,"type":"function","function":{"name":"get_weather","arguments":"{\\"city\\": \\"北京\\"}"}}]},"finish_reason":null}]}\n\n',
      'data: {"id":"x","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":"tool_calls"}],"usage":{"completion_tokens":41,"total_tokens":77,"prompt_tokens":36,"completion_tokens_details":{"reasoning_tokens":25}}}\n\n',
      'data: [DONE]\n\n',
    ])))
    const delta = out.find((e) => e.type === 'tool_call_delta')
    expect(delta).toMatchObject({ name: 'get_weather', argumentsDelta: '{"city": "北京"}' })
    const usage = out.find((e) => e.type === 'usage')
    // completion_tokens 本来就含 reasoning_tokens，不再额外合并
    expect(usage).toMatchObject({ usage: { input_tokens: 36, output_tokens: 41, total_tokens: 77 } })
    expect(out.find((e) => e.type === 'finish')).toMatchObject({ reason: 'tool_calls' })
  })
})

describe('Anthropic 协议：真实响应', () => {
  it('空 thinking block + tool_use', () => {
    const parsed = anthropic.parseResponse({
      id: 'x', type: 'message', role: 'assistant', model: 'gemini-3.8-flash-n',
      stop_reason: 'tool_use',
      content: [
        { type: 'thinking', thinking: '', signature: 'cpa-gemini-carrier-v1:sig' },
        { type: 'tool_use', id: 'cpa_gemini_76306c1f', name: 'get_weather', input: { city: '北京' } },
      ],
      usage: { input_tokens: 20, output_tokens: 10 },
    })
    expect(parsed.toolCalls).toEqual([
      { id: 'cpa_gemini_76306c1f', name: 'get_weather', arguments: '{"city":"北京"}' },
    ])
    expect(parsed.finishReason).toBe('tool_calls')
  })

  it('流式：message_start 的 usage 是中间值，message_delta 才是最终值', async () => {
    const out = await collect(anthropic.parseStream(sseBody([
      'event: message_start\ndata: {"type":"message_start","message":{"id":"x","role":"assistant","content":[],"usage":{"input_tokens":36,"output_tokens":16}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"cpa_1","name":"get_weather","input":{}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"city\\":\\"北京\\"}"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"input_tokens":30,"output_tokens":41}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ])))
    expect(out.find((e) => e.type === 'finish')).toMatchObject({ reason: 'tool_calls' })
    // 两帧 usage 都要透出，由 mergeUsage 负责取最终值（后到的覆盖先到的）
    expect(out.filter((e) => e.type === 'usage')).toHaveLength(2)
  })
})

describe('Gemini 协议：真实响应', () => {
  it('工具调用 + 思考 token 并入 output', () => {
    const parsed = gemini.parseResponse({
      candidates: [{
        content: {
          role: 'model',
          parts: [{ thoughtSignature: 'sig', functionCall: { name: 'get_weather', args: { city: '北京' }, id: 'call_1211059' } }],
        },
        finishReason: 'STOP',
        finishMessage: 'Model generated function call(s).',
      }],
      usageMetadata: { promptTokenCount: 36, candidatesTokenCount: 16, totalTokenCount: 101, thoughtsTokenCount: 49 },
    })
    expect(parsed.toolCalls).toEqual([
      { id: 'call_1211059', name: 'get_weather', arguments: '{"city":"北京"}' },
    ])
    // candidatesTokenCount 不含思考 token，total 含 —— 并入后 input + output === total
    expect(parsed.usage).toEqual({ input_tokens: 36, output_tokens: 65, total_tokens: 101 })
    expect(parsed.finishReason).toBe('tool_calls')
  })
})
