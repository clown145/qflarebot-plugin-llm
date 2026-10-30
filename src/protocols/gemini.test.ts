import { describe, expect, it } from 'vitest'
import { gemini } from './gemini.js'
import type { ParsedStreamEvent, Target } from './types.js'

const target: Target = {
  provider: {
    id: 'g',
    name: 'G',
    protocol: 'gemini',
    base_url: 'https://generativelanguage.googleapis.com/v1beta',
    api_key: 'g-key',
    enabled: true,
  },
  model: { alias: 'chat', provider: 'g', model: 'gemini-2.5-flash', enabled: true },
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
  for await (const event of gemini.parseStream(bodyOf(chunks))) out.push(event)
  return out
}

describe('gemini.buildChat', () => {
  it('system 抽到 systemInstruction，鉴权走 x-goog-api-key，端点拼 :generateContent', () => {
    const built = gemini.buildChat(target, {
      messages: [
        { role: 'system', content: '规则' },
        { role: 'user', content: '你好' },
      ],
    }, false)
    const body = JSON.parse(built.init.body as string)
    expect((built.init.headers as Record<string, string>)['x-goog-api-key']).toBe('g-key')
    // 官方形态是 {base}/models/{model}:generateContent，模型名必须在路径里。
    // 这条断言以前写成了「把期望值绕一圈断言回错误实现的结果」，于是
    // `/v1beta:generateContent`（缺 /models/{model}，必然 404）一直被当成正确值。
    expect(built.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
    )
    expect(body.systemInstruction).toEqual({ parts: [{ text: '规则' }] })
    expect(body.contents).toEqual([{ role: 'user', parts: [{ text: '你好' }] }])
    expect(body.generationConfig.maxOutputTokens).toBe(8192)
  })

  it('流式端点走 :streamGenerateContent?alt=sse', () => {
    const built = gemini.buildChat(target, { messages: [{ role: 'user', content: 'x' }] }, true)
    expect(built.url).toContain('streamGenerateContent')
  })

  it('图片片段转 inline_data，data: URI 拆回 base64，https url 走 file_data', () => {
    const built = gemini.buildChat(target, {
      messages: [{ role: 'user', content: [
        { type: 'text', text: '看图' },
        { type: 'image', data: 'AAAA', media_type: 'image/png' },
        { type: 'image', url: 'data:image/jpeg;base64,BBBB' },
        { type: 'image', url: 'https://x.test/cat.png' },
      ] }],
    }, false)
    const body = JSON.parse(built.init.body as string)
    expect(body.contents[0].parts).toEqual([
      { text: '看图' },
      { inline_data: { mime_type: 'image/png', data: 'AAAA' } },
      { inline_data: { mime_type: 'image/jpeg', data: 'BBBB' } },
      { file_data: { file_uri: 'https://x.test/cat.png' } },
    ])
  })

  it('音频片段转 inline_data（audio/*）', () => {
    const built = gemini.buildChat(target, {
      messages: [{ role: 'user', content: [{ type: 'audio', data: 'AAAA', format: 'mp3' }] }],
    }, false)
    const body = JSON.parse(built.init.body as string)
    expect(body.contents[0].parts).toEqual([
      { inline_data: { mime_type: 'audio/mp3', data: 'AAAA' } },
    ])
  })

  it('工具映射 function_declarations，参数 schema 转 Gemini 子集', () => {
    const built = gemini.buildChat(target, {
      messages: [{ role: 'user', content: 'x' }],
      tools: [{
        name: 'get_weather',
        description: '查天气',
        parameters: {
          type: 'object',
          properties: {
            city: { type: 'string', description: '城市', default: '北京' },
            tags: { type: 'array' },
          },
          required: ['city'],
        },
      }],
    }, false)
    const body = JSON.parse(built.init.body as string)
    expect(body.tools).toEqual([{
      function_declarations: [{
        name: 'get_weather',
        description: '查天气',
        parameters: {
          type: 'object',
          required: ['city'],
          properties: {
            city: { type: 'string', description: '城市' }, // default 被剔除
            tags: { type: 'array', items: { type: 'string' } }, // array 必带 items 兜底
          },
        },
      }],
    }])
    expect(body.tool_config).toBeUndefined() // auto 不发 tool_config
  })

  it('tool_choice required → ANY；指定工具 → ANY + allowed_function_names；none → 连 tools 都不发', () => {
    const tools = [{ name: 't', parameters: { type: 'object' } }]
    const required = gemini.buildChat(target, { messages: [{ role: 'user', content: 'x' }], tools, tool_choice: 'required' }, false)
    expect(JSON.parse(required.init.body as string).tool_config).toEqual({ function_calling_config: { mode: 'ANY' } })

    const named = gemini.buildChat(target, { messages: [{ role: 'user', content: 'x' }], tools, tool_choice: { name: 't' } }, false)
    expect(JSON.parse(named.init.body as string).tool_config).toEqual({ function_calling_config: { mode: 'ANY', allowed_function_names: ['t'] } })

    const none = gemini.buildChat(target, { messages: [{ role: 'user', content: 'x' }], tools, tool_choice: 'none' }, false)
    expect(JSON.parse(none.init.body as string).tools).toBeUndefined()
  })

  it('assistant 工具调用转 model 的 function_call；tool 消息转 user 的 functionResponse', () => {
    const built = gemini.buildChat(target, {
      messages: [
        { role: 'user', content: '天气' },
        { role: 'assistant', content: '', tool_calls: [{ id: 'c1', name: 'get_weather', arguments: '{"city":"北京"}' }] },
        { role: 'tool', tool_call_id: 'c1', content: '{"temp":20}' },
      ],
    }, false)
    const body = JSON.parse(built.init.body as string)
    expect(body.contents).toEqual([
      { role: 'user', parts: [{ text: '天气' }] },
      { role: 'model', parts: [{ function_call: { name: 'get_weather', args: { city: '北京' }, id: 'c1' } }] },
      { role: 'user', parts: [{ functionResponse: { name: 'c1', response: { temp: 20 }, id: 'c1' } }] },
    ])
  })

  it('tool 结果是纯文本时包成 {result: …}', () => {
    const built = gemini.buildChat(target, {
      messages: [
        { role: 'user', content: 'x' },
        { role: 'assistant', tool_calls: [{ id: 'c1', name: 't', arguments: '{}' }] },
        { role: 'tool', tool_call_id: 'c1', content: '不是 JSON 的结果' },
      ],
    }, false)
    const body = JSON.parse(built.init.body as string)
    expect(body.contents.at(-1)).toEqual({
      role: 'user',
      parts: [{ functionResponse: { name: 'c1', response: { result: '不是 JSON 的结果' }, id: 'c1' } }],
    })
  })

  it('json:true → response_mime_type；stop 转 stopSequences', () => {
    const built = gemini.buildChat(target, {
      messages: [{ role: 'user', content: 'x' }],
      json: true,
      stop: ['END'],
      temperature: 0.5,
      top_p: 0.9,
      max_tokens: 1024,
    }, false)
    const body = JSON.parse(built.init.body as string)
    expect(body.generationConfig).toMatchObject({
      response_mime_type: 'application/json',
      stopSequences: ['END'],
      temperature: 0.5,
      topP: 0.9,
      maxOutputTokens: 1024,
    })
  })

  it('contents 以 model 开头时剥掉（Gemini 要求 user 开头）', () => {
    const built = gemini.buildChat(target, {
      messages: [
        { role: 'assistant', content: '开头的话' },
        { role: 'user', content: '你好' },
      ],
    }, false)
    const body = JSON.parse(built.init.body as string)
    expect(body.contents).toEqual([{ role: 'user', parts: [{ text: '你好' }] }])
  })
})

describe('gemini.parseResponse', () => {
  it('文本、思考（thought part）、工具调用、usage、finish_reason 全解析', () => {
    const parsed = gemini.parseResponse({
      candidates: [{
        content: { parts: [
          { text: '思考中', thought: true },
          { text: '答案' },
          { function_call: { name: 'lookup', args: { q: 'x' }, id: 'call_1' } },
        ] },
        finish_reason: 'STOP',
      }],
      usage_metadata: { prompt_token_count: 10, candidates_token_count: 5, total_token_count: 15 },
    })
    expect(parsed.text).toBe('答案')
    expect(parsed.reasoning).toBe('思考中')
    expect(parsed.toolCalls).toEqual([{ id: 'call_1', name: 'lookup', arguments: '{"q":"x"}' }])
    expect(parsed.usage).toEqual({ input_tokens: 10, output_tokens: 5, total_tokens: 15 })
    expect(parsed.finishReason).toBe('stop')
  })

  it('finish_reason 映射：MAX_TOKENS→length', () => {
    const asLength = gemini.parseResponse({ candidates: [{ content: { parts: [{ text: 'x' }, { text: '' }] }, finish_reason: 'MAX_TOKENS' }] })
    expect(asLength.finishReason).toBe('length')
  })

  it('finish_reason SAFETY → content_filter', () => {
    const asFilter = gemini.parseResponse({ candidates: [{ content: { parts: [{ text: 'x' }, { text: '' }] }, finish_reason: 'SAFETY' }] })
    expect(asFilter.finishReason).toBe('content_filter')
  })

  it('流内 error（HTTP 200）抛 LLMError 而不是静默丢弃', () => {
    expect(() => gemini.parseResponse({ error: { message: 'quota exceeded', code: 429 } })).toThrow(/quota/)
  })
})

describe('gemini.parseStream', () => {
  it('text/thought/function_call/usage/finish 事件齐全', async () => {
    const out = await events([
      'data: {"candidates":[{"content":{"parts":[{"text":"嗯","thought":true},{"text":"你好"}]}}]}\n\n',
      'data: {"candidates":[{"content":{"parts":[{"function_call":{"name":"lookup","args":{"q":"x"}}}]},"finish_reason":"STOP"}],"usage_metadata":{"prompt_token_count":2,"candidates_token_count":3}}\n\n',
    ])
    expect(out).toContainEqual({ type: 'reasoning_delta', text: '嗯' })
    expect(out).toContainEqual({ type: 'text_delta', text: '你好' })
    const tool = out.find((item) => item.type === 'tool_call_delta')
    expect(tool).toMatchObject({ index: 0, name: 'lookup', argumentsDelta: '{"q":"x"}' })
    expect(out.some((item) => item.type === 'finish' && item.reason === 'stop')).toBe(true)
    expect(out.some((item) => item.type === 'usage')).toBe(true)
  })

  it('流内 error 事件抛带脱敏的 LLMError', async () => {
    const error = await (async () => {
      for await (const _event of gemini.parseStream(bodyOf([
        'data: {"error":{"message":"API key g-key-SECRET1 invalid","code":401}}\n\n',
      ]), { apiKey: 'g-key-SECRET1' })) void _event
    })().catch((err: unknown) => err)
    expect(String((error as Error).message)).not.toContain('g-key-SECRET1')
    expect(error).toMatchObject({ code: 'auth' })
  })
})

describe('gemini.parseListModels / buildListModels', () => {
  it('读 models[].name 并剥 models/ 前缀', () => {
    expect(gemini.parseListModels({ models: [{ name: 'models/gemini-2.5-flash' }, { name: 'models/gemini-2.5-pro' }] }))
      .toEqual(['gemini-2.5-flash', 'gemini-2.5-pro'])
  })

  it('模型列表 URL 从 v1beta 推出，带端点时退回上一级', () => {
    const built = gemini.buildListModels(target.provider)
    expect(built.url).toBe('https://generativelanguage.googleapis.com/v1beta/models')
    expect((built.init.headers as Record<string, string>)['x-goog-api-key']).toBe('g-key')
  })
})

describe('gemini thoughtSignature（Gemini 2.5/3.x 强制要求回传）', () => {
  it('非流式：文本与 functionCall 的签名都进 thought_signatures，带完整定位信息', () => {
    const parsed = gemini.parseResponse({
      candidates: [{
        content: { parts: [
          { text: '答案', thoughtSignature: 'sig-text' },
          { function_call: { name: 'lookup', args: { q: 'x' }, id: 'c1' }, thoughtSignature: 'sig-call' },
        ] },
        finish_reason: 'STOP',
      }],
    })
    expect(parsed.thoughtSignatures).toEqual([
      { part_index: 0, part_kind: 'text', signature: 'sig-text' },
      { part_index: 1, part_kind: 'function_call', signature: 'sig-call', tool_call_index: 0, tool_call_id: 'c1', tool_name: 'lookup' },
    ])
    // ToolCall 本身不再挂签名（形状对齐 serverless-agent：签名集中在数组里）
    expect(parsed.toolCalls?.[0]).toEqual({ id: 'c1', name: 'lookup', arguments: '{"q":"x"}' })
  })

  it('多个文本 part 各自的签名都能保留（数组形状的核心收益）', () => {
    const parsed = gemini.parseResponse({
      candidates: [{
        content: { parts: [
          { text: '第一段', thoughtSignature: 'sig-a' },
          { text: '第二段', thoughtSignature: 'sig-b' },
        ] },
        finish_reason: 'STOP',
      }],
    })
    expect(parsed.text).toBe('第一段第二段')
    expect(parsed.thoughtSignatures).toEqual([
      { part_index: 0, part_kind: 'text', signature: 'sig-a' },
      { part_index: 1, part_kind: 'text', signature: 'sig-b' },
    ])
  })

  it('并行 function call：只有第一个带签名时，第二个不会凭空得到签名', () => {
    const parsed = gemini.parseResponse({
      candidates: [{
        content: { parts: [
          { function_call: { name: 'a', args: {}, id: 'c1' }, thoughtSignature: 'sig-first' },
          { function_call: { name: 'b', args: {}, id: 'c2' } },
        ] },
        finish_reason: 'STOP',
      }],
    })
    expect(parsed.toolCalls).toHaveLength(2)
    expect(parsed.thoughtSignatures).toHaveLength(1)
    expect(parsed.thoughtSignatures?.[0]).toMatchObject({ part_kind: 'function_call', tool_call_id: 'c1', signature: 'sig-first' })
  })

  it('回传：按 tool_call_id 精确贴回对应 functionCall part，文本签名按下标贴回', () => {
    const built = gemini.buildChat(target, {
      messages: [
        { role: 'user', content: '天气' },
        {
          role: 'assistant',
          content: '让我查一下',
          thought_signatures: [
            { part_index: 0, part_kind: 'text', signature: 'sig-text' },
            { part_index: 1, part_kind: 'function_call', signature: 'sig-call-1', tool_call_index: 0, tool_call_id: 'c1', tool_name: 'get_weather' },
          ],
          tool_calls: [
            { id: 'c1', name: 'get_weather', arguments: '{"city":"北京"}' },
            { id: 'c2', name: 'get_time', arguments: '{}' },
          ],
        },
        { role: 'tool', tool_call_id: 'c1', content: '{"temp":20}' },
        { role: 'tool', tool_call_id: 'c2', content: '{"now":"12:00"}' },
      ],
    }, false)
    const body = JSON.parse(built.init.body as string)
    const modelContent = body.contents.find((item: { role: string }) => item.role === 'model')
    expect(modelContent.parts).toEqual([
      { text: '让我查一下', thoughtSignature: 'sig-text' },
      { function_call: { name: 'get_weather', args: { city: '北京' }, id: 'c1' }, thoughtSignature: 'sig-call-1' },
      { function_call: { name: 'get_time', args: {}, id: 'c2' } },
    ])
  })

  it('tool_call_id 对不上时按工具名兜底', () => {
    const built = gemini.buildChat(target, {
      messages: [
        { role: 'user', content: 'x' },
        {
          role: 'assistant',
          content: '',
          thought_signatures: [
            { part_index: 0, part_kind: 'function_call', signature: 'sig-by-name', tool_call_index: 0, tool_call_id: 'stale-id', tool_name: 'real_tool' },
          ],
          tool_calls: [{ id: 'real-id', name: 'real_tool', arguments: '{}' }],
        },
      ],
    }, false)
    const body = JSON.parse(built.init.body as string)
    const modelContent = body.contents.find((item: { role: string }) => item.role === 'model')
    expect(modelContent.parts[0].thoughtSignature).toBe('sig-by-name')
  })

  it('没有签名时不注入空字段', () => {
    const built = gemini.buildChat(target, {
      messages: [
        { role: 'user', content: 'x' },
        { role: 'assistant', content: '答', tool_calls: [{ id: 'c1', name: 't', arguments: '{}' }] },
      ],
    }, false)
    const body = JSON.parse(built.init.body as string)
    const modelContent = body.contents.find((item: { role: string }) => item.role === 'model')
    expect(modelContent.parts[0]).toEqual({ text: '答' })
    expect(modelContent.parts[1]).toEqual({ function_call: { name: 't', args: {}, id: 'c1' } })
    expect('thoughtSignature' in modelContent.parts[0]).toBe(false)
    expect('thoughtSignature' in modelContent.parts[1]).toBe(false)
  })

  it('流式：签名走 thought_signature 事件，带 part 定位信息', async () => {
    const out = await events([
      'data: {"candidates":[{"content":{"parts":[{"text":"答案","thoughtSignature":"sig-text"}]}}]}\n\n',
      'data: {"candidates":[{"content":{"parts":[{"function_call":{"name":"a","args":{},"id":"c1"},"thoughtSignature":"sig-a"}]}}]}\n\n',
      'data: {"candidates":[{"content":{"parts":[{"function_call":{"name":"b","args":{},"id":"c2"}}]}}]}\n\n',
    ])
    const sigs = out.filter((item) => item.type === 'thought_signature')
    expect(sigs).toEqual([
      { type: 'thought_signature', part_index: 0, part_kind: 'text', signature: 'sig-text' },
      { type: 'thought_signature', part_index: 1, part_kind: 'function_call', signature: 'sig-a', tool_call_index: 0, tool_call_id: 'c1', tool_name: 'a' },
    ])
    // 工具增量本身不再携带签名
    const deltas = out.filter((item) => item.type === 'tool_call_delta')
    expect(deltas.map((item) => (item as { index: number }).index)).toEqual([0, 1])
    expect('thoughtSignature' in (deltas[0] as object)).toBe(false)
  })

  it('流式：多帧下发的工具调用索引连续递增，不塌缩到 0', async () => {
    const out = await events([
      'data: {"candidates":[{"content":{"parts":[{"function_call":{"name":"a","args":{},"id":"c1"}}]}}]}\n\n',
      'data: {"candidates":[{"content":{"parts":[{"function_call":{"name":"b","args":{},"id":"c2"}}]}}]}\n\n',
    ])
    const deltas = out.filter((item) => item.type === 'tool_call_delta')
    expect(deltas.map((item) => (item as { index: number }).index)).toEqual([0, 1])
  })

  it('完整往返：解析出的签名数组原样塞回下一轮请求', () => {
    const first = gemini.parseResponse({
      candidates: [{
        content: { parts: [
          { text: '先查天气', thoughtSignature: 'sig-t' },
          { function_call: { name: 'get_weather', args: { city: '北京' }, id: 'c1' }, thoughtSignature: 'sig-c' },
        ] },
        finish_reason: 'STOP',
      }],
    })
    const built = gemini.buildChat(target, {
      messages: [
        { role: 'user', content: '北京天气' },
        {
          role: 'assistant',
          content: first.text,
          thought_signatures: first.thoughtSignatures,
          tool_calls: first.toolCalls,
        },
        { role: 'tool', tool_call_id: 'c1', content: '{"temp":20}' },
      ],
    }, false)
    const body = JSON.parse(built.init.body as string)
    const modelContent = body.contents.find((item: { role: string }) => item.role === 'model')
    expect(modelContent.parts[0].thoughtSignature).toBe('sig-t')
    expect(modelContent.parts[1].thoughtSignature).toBe('sig-c')
  })
})

describe('gemini 的 generateContent 地址拼接', () => {
  const target2 = (base_url: string, model = 'gemini-3-flash') => ({
    provider: { id: 'p', name: 'P', protocol: 'gemini' as const, base_url, enabled: true },
    model: { alias: 'chat', provider: 'p', model, enabled: true },
  })
  const urlOf = (base_url: string, model?: string, stream = false) =>
    gemini.buildChat(target2(base_url, model), { messages: [{ role: 'user', content: 'hi' }] }, stream).url

  it('常规 base_url：补 /models/{model}:generateContent（模型名必须在路径里）', () => {
    expect(urlOf('https://generativelanguage.googleapis.com/v1beta')).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash:generateContent',
    )
  })

  it('流式换成 streamGenerateContent 并带 alt=sse', () => {
    expect(urlOf('https://host/v1beta', undefined, true)).toBe(
      'https://host/v1beta/models/gemini-3-flash:streamGenerateContent?alt=sse',
    )
  })

  it('base_url 已经写到 models/{model}：只补方法后缀，不重复拼', () => {
    expect(urlOf('https://host/v1beta/models/gemini-3-flash')).toBe(
      'https://host/v1beta/models/gemini-3-flash:generateContent',
    )
  })

  it('base_url 是完整端点：原样用；流式要换成 streamGenerateContent', () => {
    const full = 'https://host/v1beta/models/gemini-3-flash:generateContent'
    expect(urlOf(full)).toBe(full)
    expect(urlOf(full, undefined, true)).toBe(
      'https://host/v1beta/models/gemini-3-flash:streamGenerateContent?alt=sse',
    )
  })

  it('模型名带 models/ 前缀时不会拼出 /models/models/xxx', () => {
    expect(urlOf('https://host/v1beta', 'models/gemini-3-flash')).toBe(
      'https://host/v1beta/models/gemini-3-flash:generateContent',
    )
  })

  it('base_url 带查询串时，路径插在查询串之前', () => {
    expect(urlOf('https://proxy.example/v1beta?key=abc')).toBe(
      'https://proxy.example/v1beta/models/gemini-3-flash:generateContent?key=abc',
    )
  })

  it('末尾多余斜杠不影响结果', () => {
    expect(urlOf('https://host/v1beta/')).toBe('https://host/v1beta/models/gemini-3-flash:generateContent')
  })
})
