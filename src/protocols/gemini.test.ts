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
      // name 是**函数名**，不是调用 id（用 id 会让上游对不上结果）
      { role: 'user', parts: [{ functionResponse: { name: 'get_weather', response: { temp: 20 }, id: 'c1' } }] },
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
      parts: [{ functionResponse: { name: 't', response: { result: '不是 JSON 的结果' }, id: 'c1' } }],
    })
  })

  /**
   * P1-5 回归：`tool` 消息的 content 是**内容片段数组**时，结果不能静默变空。
   *
   * 契约（`MessageContent`）允许调用方传 `ContentPart[]`，OpenAI 路径早就能正确处理；
   * Gemini 路径只判断了 `typeof === 'string'`，数组直接落到 `response = {}`——
   * 模型拿到的工具结果是空对象，不报错，只是「答非所问」。
   */
  it('tool 消息 content 是片段数组时取 text 片段（不能静默变 {}）', () => {
    const built = gemini.buildChat(target, {
      messages: [
        { role: 'user', content: 'x' },
        { role: 'assistant', tool_calls: [{ id: 'c1', name: 't', arguments: '{}' }] },
        {
          role: 'tool',
          tool_call_id: 'c1',
          content: [{ type: 'text', text: '{"temp":26}' }],
        },
      ],
    }, false)
    const body = JSON.parse(built.init.body as string)
    expect(body.contents.at(-1).parts[0].functionResponse.response).toEqual({ temp: 26 })
  })

  it('tool 消息 content 是纯文本片段数组时包成 {result: …}', () => {
    const built = gemini.buildChat(target, {
      messages: [
        { role: 'user', content: 'x' },
        { role: 'assistant', tool_calls: [{ id: 'c1', name: 't', arguments: '{}' }] },
        { role: 'tool', tool_call_id: 'c1', content: [{ type: 'text', text: '失败：超时' }] },
      ],
    }, false)
    const body = JSON.parse(built.init.body as string)
    expect(body.contents.at(-1).parts[0].functionResponse.response).toEqual({ result: '失败：超时' })
  })

  /**
   * P1-6 回归：JSON Schema 里省略 `type` 是合法写法（靠 other keywords 推断），
   * 旧实现一律写 `type: 'null'`，上游会把该参数当成「不允许有值」。
   */
  it('未声明 type 的属性按 properties 推断 object，不能变成 null', () => {
    const built = gemini.buildChat(target, {
      messages: [{ role: 'user', content: 'x' }],
      tools: [{
        name: 't',
        parameters: {
          type: 'object',
          properties: {
            filter: { properties: { city: { type: 'string' } }, required: ['city'] },
            plain: { description: '没有 type 也没有其它线索' },
            list: { items: { type: 'string' } },
          },
        },
      }],
    }, false)
    const params = JSON.parse(built.init.body as string).tools[0].function_declarations[0].parameters
    expect(params.properties.filter.type).toBe('object')
    expect(params.properties.list.type).toBe('array')
    // 完全没有线索时退化成最宽松的标量，而不是 null（null 会让参数永远缺失）
    expect(params.properties.plain.type).not.toBe('null')
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
    // 有工具调用时上游照样给 STOP（Gemini 不像 OpenAI 那样返回 tool_calls），
    // 这里必须改写成 tool_calls，否则调用方会当成「正常结束」
    expect(parsed.finishReason).toBe('tool_calls')
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
    // 这一帧里有工具调用，finish 应为 tool_calls 而不是 stop（Gemini 上游给的是 STOP）
    expect(out.some((item) => item.type === 'finish' && item.reason === 'tool_calls')).toBe(true)
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

/**
 * Gemini 的 REST 响应是 **camelCase**（functionCall / finishReason / usageMetadata），
 * 请求体才是 snake_case。官方 SDK 内部做这层映射，手写 REST 客户端必须自己兜。
 *
 * 这组测试用**真实端点返回的原始 JSON** 做样本。之前的测试全部用 snake_case 的
 * `function_call` 构造响应，等于拿「自己以为的格式」去验证自己，掩盖了工具调用
 * 被静默丢弃的问题（模型能对话、但永远不调用工具，且没有任何报错）。
 */
describe('真实端点返回的 camelCase 响应', () => {
  it('functionCall（camelCase）能被解析成 toolCalls', () => {
    const parsed = gemini.parseResponse({
      candidates: [{
        content: {
          role: 'model',
          parts: [{
            thoughtSignature: 'sig',
            functionCall: { name: 'get_weather', args: { city: '北京' }, id: 'call_1211059' },
          }],
        },
        finishReason: 'STOP',
        finishMessage: 'Model generated function call(s).',
      }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
    })
    expect(parsed.toolCalls).toEqual([
      { id: 'call_1211059', name: 'get_weather', arguments: JSON.stringify({ city: '北京' }) },
    ])
    expect(parsed.usage).toEqual({ input_tokens: 10, output_tokens: 5, total_tokens: 15 })
    // 上游给 STOP，但有工具调用时必须是 tool_calls
    expect(parsed.finishReason).toBe('tool_calls')
  })

  it('流式：camelCase 的 functionCall 也产出 tool_call_delta', async () => {
    const out = await events([
      'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"lookup","args":{"q":"x"}}}]},"finishReason":"STOP"}]}\n\n',
    ])
    const call = out.find((e) => e.type === 'tool_call_delta')
    expect(call).toMatchObject({ type: 'tool_call_delta', name: 'lookup', argumentsDelta: '{"q":"x"}' })
    // snake_case 的兼容网关同样要支持
    const snake = await events([
      'data: {"candidates":[{"content":{"parts":[{"function_call":{"name":"lookup","args":{}}}]}}]}\n\n',
    ])
    expect(snake.some((e) => e.type === 'tool_call_delta')).toBe(true)
  })
})

/**
 * functionResponse.name 必须是**函数名**，不是调用 id。
 *
 * 用 id 填进去，上游会把「某个不存在函数的结果」当成无效输入，表现为模型忽略工具结果、
 * 或者直接说没法调用工具。契约里的 tool 消息只有 tool_call_id，所以要从历史的
 * assistant.tool_calls 反查名字。
 */
describe('functionResponse 的 name 用函数名', () => {
  it('从历史 tool_calls 反查出函数名，而不是用调用 id', () => {
    const built = gemini.buildChat(target, {
      messages: [
        { role: 'user', content: '天气' },
        { role: 'assistant', tool_calls: [{ id: 'call_abc', name: 'get_weather', arguments: '{"city":"北京"}' }] },
        { role: 'tool', tool_call_id: 'call_abc', content: '{"temp":25}' },
      ],
    }, false)
    const body = JSON.parse(built.init.body as string)
    const response = body.contents.at(-1).parts[0].functionResponse
    expect(response.name).toBe('get_weather')
    // id 仍然保留，用于和 functionCall 对应
    expect(response.id).toBe('call_abc')
  })

  it('反查不到时退回调用 id（不至于拼出空字段）', () => {
    const built = gemini.buildChat(target, {
      messages: [
        { role: 'user', content: 'x' },
        { role: 'tool', tool_call_id: 'orphan_id', content: 'r' },
      ],
    }, false)
    const body = JSON.parse(built.init.body as string)
    // 相邻的同 role content 会合并成一段，所以 functionResponse 是 parts 里的第二项
    const last = body.contents.at(-1)
    const response = last.parts.find((p: Record<string, unknown>) => p['functionResponse'])
    expect(response.functionResponse.name).toBe('orphan_id')
  })
})

/**
 * 请求体只放官方认识的字段。
 *
 * 官方端点对未知字段是**严格**的：多一个就会被拒，而且是在鉴权之前就拒——
 *
 *   Invalid JSON payload received. Unknown name "stream": Cannot find field.
 *
 * 宽松的兼容网关会忽略多余字段，所以本地对着网关测不出来，只有直连
 * generativelanguage 才炸。流式由 URL 的 `:streamGenerateContent` 决定；
 * 模型名在路径里，请求体没有 `model`。
 */
describe('请求体不带非标准字段', () => {
  const target2 = {
    provider: { id: 'p', name: 'P', protocol: 'gemini' as const, base_url: 'https://h/v1beta', api_key: 'k', enabled: true },
    model: { alias: 'm', provider: 'p', model: 'gemini-3-flash', enabled: true },
  }

  it('流式请求不在 body 里塞 stream（只在 URL 上体现）', () => {
    const built = gemini.buildChat(target2, { messages: [{ role: 'user', content: 'x' }] }, true)
    const body = JSON.parse(built.init.body as string)
    expect(body.stream).toBeUndefined()
    expect(built.url).toContain(':streamGenerateContent')
  })

  it('body 里没有 model（模型名在 URL 路径里）', () => {
    const built = gemini.buildChat(target2, { messages: [{ role: 'user', content: 'x' }] }, false)
    expect(JSON.parse(built.init.body as string).model).toBeUndefined()
  })
})

/**
 * usage 的三个数要对得上：input + output === total。
 *
 * Gemini 的 `candidatesTokenCount` **不含**思考 token，而 `totalTokenCount` 含。
 * 直接透出会让成本核算少算一截（实测 36 + 16 = 52，total 却是 101）。
 * OpenAI 的 completion_tokens 本来就含推理 token，所以把思考 token 并入 output
 * 是跨协议一致的口径，不必为此扩展 Usage 契约。
 */
describe('usage 含思考 token', () => {
  it('thoughtsTokenCount 并入 output_tokens，input + output === total', () => {
    const parsed = gemini.parseResponse({
      candidates: [{ content: { parts: [{ text: '2' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 36, candidatesTokenCount: 16, totalTokenCount: 101, thoughtsTokenCount: 49 },
    })
    expect(parsed.usage).toEqual({ input_tokens: 36, output_tokens: 65, total_tokens: 101 })
    expect(parsed.usage!.input_tokens! + parsed.usage!.output_tokens!).toBe(parsed.usage!.total_tokens)
  })
})

/**
 * 流式也要把「有工具调用」反映到 finish 上。
 *
 * 非流式早已修正，但流式是另一条代码路径，同样直传 STOP 会让调用方
 * 以为「正常结束」而不再继续跑工具。用真实端点的 SSE 形状验证。
 */
describe('流式 finish 识别工具调用', () => {
  it('有 functionCall 的流，finish.reason 是 tool_calls', async () => {
    const out = await events([
      'data: {"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"name":"get_weather","args":{"city":"北京"},"id":"call_1"}}]}}]}\n\n',
      'data: {"candidates":[{"content":{"role":"model","parts":[{"text":""}]},"finishReason":"STOP"}]}\n\n',
    ])
    const finish = out.find((e) => e.type === 'finish')
    expect(finish).toMatchObject({ type: 'finish', reason: 'tool_calls' })
  })

  it('没有工具调用的流，finish.reason 保持 stop', async () => {
    const out = await events([
      'data: {"candidates":[{"content":{"parts":[{"text":"你好"}]},"finishReason":"STOP"}]}\n\n',
    ])
    expect(out.find((e) => e.type === 'finish')).toMatchObject({ reason: 'stop' })
  })
})

/**
 * P2-13 / P2-17 回归：`thinkingBudget` 与 `maxOutputTokens` 互相约束。
 *
 * 上游硬性要求 `maxOutputTokens > thinkingBudget`，否则
 * `400 INVALID_ARGUMENT: maxOutputTokens must be greater than thinkingBudget`。
 * 旧实现各算各的：`ping()` 用 `max_tokens: 16`、模型配了 `high` 就发 8192 → 必坏。
 */
describe('Gemini thinkingBudget 与 maxOutputTokens 的约束（P2-13）', () => {
  const config = (model: string, effort: 'high' | 'low' | 'minimal', extra: Partial<Target['model']> = {}): Target => ({
    provider: target.provider,
    model: { alias: 'chat', provider: 'g', model, enabled: true, reasoning_effort: effort, ...extra },
  })
  const bodyOf = (built: { init: RequestInit }) => JSON.parse(built.init.body as string) as Record<string, any>

  it('ping 级别的极小 max_tokens 会被抬到大于预算（不再必 400）', () => {
    const body = bodyOf(gemini.buildChat(config('gemini-2.5-flash', 'high'), {
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 16,
    }, false))
    const generation = body.generationConfig
    expect(generation.thinkingConfig.thinkingBudget).toBe(8192)
    expect(generation.maxOutputTokens).toBeGreaterThan(generation.thinkingConfig.thinkingBudget)
  })

  it('调用方显式给了更大的 max_tokens 时尊重它', () => {
    const body = bodyOf(gemini.buildChat(config('gemini-2.5-flash', 'low'), {
      messages: [{ role: 'user', content: 'x' }],
      max_tokens: 32000,
    }, false))
    expect(body.generationConfig.maxOutputTokens).toBe(32000)
    expect(body.generationConfig.thinkingConfig.thinkingBudget).toBe(1024)
  })

  it('模型的 max_output_tokens 是硬上限：预算被压回上限以内，且 maxOutputTokens 仍大于预算', () => {
    const body = bodyOf(gemini.buildChat(config('gemini-2.5-flash', 'high', { max_output_tokens: 6000 }), {
      messages: [{ role: 'user', content: 'x' }],
    }, false))
    const generation = body.generationConfig
    expect(generation.maxOutputTokens).toBeLessThanOrEqual(6000)
    expect(generation.maxOutputTokens).toBeGreaterThan(generation.thinkingConfig.thinkingBudget)
  })

  it('3.x 用 thinkingLevel，没有 budget，不受 maxOutputTokens 约束', () => {
    const body = bodyOf(gemini.buildChat(config('gemini-3-pro-preview', 'high'), {
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 16,
    }, false))
    expect(body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'HIGH' })
    expect(body.generationConfig.maxOutputTokens).toBe(16)
  })
})

/**
 * P2-14 回归：Gemini 2.5 Pro 不接受 `thinkingBudget: 0`（只收 128–32768 或 -1）。
 * 旧实现把 `minimal` 一律翻译成 0，于是「2.5 Pro + 很浅」直接 400 INVALID_ARGUMENT。
 */
describe('Gemini 2.5 Pro 不接受 thinkingBudget: 0（P2-14）', () => {
  const bodyOf = (built: { init: RequestInit }) => JSON.parse(built.init.body as string) as Record<string, any>
  const config = (model: string): Target => ({
    provider: target.provider,
    model: { alias: 'chat', provider: 'g', model, enabled: true, reasoning_effort: 'minimal' as const },
  })

  it('2.5 Pro 的 minimal 退化成最小正预算 128，而不是非法的 0', () => {
    const body = bodyOf(gemini.buildChat(config('gemini-2.5-pro'), { messages: [{ role: 'user', content: 'x' }] }, false))
    expect(body.generationConfig.thinkingConfig.thinkingBudget).toBe(128)
  })

  it('2.5 Pro 的 preview 变体同样识别', () => {
    const body = bodyOf(gemini.buildChat(config('gemini-2.5-pro-preview-06-05'), { messages: [{ role: 'user', content: 'x' }] }, false))
    expect(body.generationConfig.thinkingConfig.thinkingBudget).toBe(128)
  })

  it('2.5 Flash 仍然允许 0（关闭思考），不能被这条修复误伤', () => {
    const body = bodyOf(gemini.buildChat(config('gemini-2.5-flash'), { messages: [{ role: 'user', content: 'x' }] }, false))
    expect(body.generationConfig.thinkingConfig.thinkingBudget).toBe(0)
  })
})

/**
 * P2-15 回归：流式与非流式的 `part_index` 口径必须一致。
 *
 * 重建顺序是「先文本 part、后 functionCall part」。thought part 的文本**不回传**
 * （reasoning 是独立字段），所以它不能占文本 part 的下标。
 * 旧实现流式路径对 thought part 也自增计数，导致同一条响应在流式下比非流式多 1，
 * 签名贴错位置 → 上游 400。
 */
describe('thought part 不占文本 part 下标（P2-15）', () => {
  it('非流式：thought part 后面第一个文本 part 的签名 part_index 是 0', () => {
    const parsed = gemini.parseResponse({
      candidates: [{
        content: { parts: [
          { text: '思考中', thought: true, thoughtSignature: 'sig-thought' },
          { text: '答案', thoughtSignature: 'sig-text' },
        ] },
        finish_reason: 'STOP',
      }],
    })
    expect(parsed.thoughtSignatures).toEqual([
      { part_index: 0, part_kind: 'text', signature: 'sig-thought' },
      { part_index: 0, part_kind: 'text', signature: 'sig-text' },
    ])
  })

  it('流式与非流式对同一段响应算出相同的 part_index', async () => {
    const nonStream = gemini.parseResponse({
      candidates: [{
        content: { parts: [
          { text: '思考中', thought: true },
          { text: '答案', thoughtSignature: 'sig-text' },
          { function_call: { name: 'lookup', args: {}, id: 'c1' }, thoughtSignature: 'sig-call' },
        ] },
        finish_reason: 'STOP',
      }],
    })
    const streamed = await events([
      'data: {"candidates":[{"content":{"parts":[{"text":"思考中","thought":true},{"text":"答案","thoughtSignature":"sig-text"},{"functionCall":{"name":"lookup","args":{},"id":"c1"},"thoughtSignature":"sig-call"}]}}]}\n\n',
    ])
    const streamSigs = streamed
      .filter((item) => item.type === 'thought_signature')
      .map(({ type: _type, ...rest }) => rest)
    expect(streamSigs).toEqual(nonStream.thoughtSignatures)
  })
})

/**
 * P3-19 回归：`buildListModels` 里 `['?te', '#']` 是笔误（`?te` 永远匹配不到 `?`）。
 * base_url 带查询串时，模型列表 URL 不能把 `?key=…` 拼进路径。
 */
describe('buildListModels 处理 base_url 的查询串（P3-19）', () => {
  it('base_url 带 ?key= 时切掉查询串再拼 /models', () => {
    const built = gemini.buildListModels({
      id: 'g',
      name: 'G',
      protocol: 'gemini',
      base_url: 'https://host/v1beta?key=abc',
      api_key: 'g-key',
      enabled: true,
    })
    expect(built.url).toBe('https://host/v1beta/models')
  })
})

/**
 * 调用方通过 `extra_body` 自己指定 thinkingConfig 时的自洽性。
 *
 * Gemini 要求 `maxOutputTokens > thinkingBudget`；旧实现直接用调用方的值、
 * 完全不管 `maxOutputTokens`，于是「调用方给大预算 + 默认 8192 输出」必 400。
 */
describe('extra_body 的 thinkingBudget 也要与 maxOutputTokens 自洽', () => {
  const bodyOf = (built: { init: RequestInit }) => JSON.parse(built.init.body as string) as Record<string, any>

  it('调用方给更大的预算时，maxOutputTokens 被抬到大于预算', () => {
    const body = bodyOf(gemini.buildChat(target, {
      messages: [{ role: 'user', content: 'x' }],
      extra_body: { generationConfig: { thinkingConfig: { thinkingBudget: 20000 } } },
    }, false))
    expect(body.generationConfig.thinkingConfig.thinkingBudget).toBe(20000)
    expect(body.generationConfig.maxOutputTokens).toBeGreaterThan(20000)
  })

  it('模型输出上限放不下这个预算时，放弃调用方的 thinkingConfig 并告警', () => {
    const warns: string[] = []
    const body = bodyOf(gemini.buildChat(
      { ...target, model: { ...target.model, max_output_tokens: 4096 } },
      {
        messages: [{ role: 'user', content: 'x' }],
        extra_body: { generationConfig: { thinkingConfig: { thinkingBudget: 20000 } } },
      },
      false,
      { warn: (message) => warns.push(message) },
    ))
    expect(body.generationConfig.thinkingConfig ?? {}).toEqual({})
    expect(warns).toHaveLength(1)
  })

  it('调用方只改 includeThoughts、不带预算时原样透传（不能被这条修复误伤）', () => {
    const body = bodyOf(gemini.buildChat(target, {
      messages: [{ role: 'user', content: 'x' }],
      extra_body: { generationConfig: { thinkingConfig: { includeThoughts: true } } },
    }, false))
    expect(body.generationConfig.thinkingConfig).toEqual({ includeThoughts: true })
  })
})
