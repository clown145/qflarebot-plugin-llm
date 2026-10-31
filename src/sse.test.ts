import { describe, expect, it } from 'vitest'
import { readSSE } from './sse.js'

function bodyOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
}

async function collect(chunks: string[]) {
  const out = []
  for await (const message of readSSE(bodyOf(chunks))) out.push(message)
  return out
}

describe('readSSE', () => {
  it('跨 chunk 的行能拼回来', async () => {
    await expect(collect(['data: he', 'llo\n\n'])).resolves.toEqual([{ data: 'hello' }])
  })

  it('支持 CRLF、event、注释和空行', async () => {
    await expect(collect([': ping\r\n', 'event: message_delta\r\n', 'data: {"a":1}\r\n\r\n'])).resolves.toEqual([
      { event: 'message_delta', data: '{"a":1}' },
    ])
  })

  it('多条 data 用换行连接', async () => {
    await expect(collect(['data: a\ndata: b\n\n'])).resolves.toEqual([{ data: 'a\nb' }])
  })

  it('一次 chunk 里有多条消息', async () => {
    await expect(collect(['data: 1\n\ndata: 2\n\n'])).resolves.toEqual([{ data: '1' }, { data: '2' }])
  })

  it('末尾没有空行也能派发', async () => {
    await expect(collect(['data: x'])).resolves.toEqual([{ data: 'x' }])
  })

  it('[DONE] 原样交给调用方', async () => {
    await expect(collect(['data: [DONE]\n\n'])).resolves.toEqual([{ data: '[DONE]' }])
  })

  it('单个 chunk 总长超过 1MB 但每行不超限时正常解析', async () => {
    const chunk = 'a'.repeat(600 * 1024)
    const out = await collect([`data: ${chunk}\n\ndata: ${chunk}\n\n`])
    expect(out.map((message) => message.data.length)).toEqual([chunk.length, chunk.length])
  })

  it('单行超过 1MB 时报错', async () => {
    await expect(collect([`data: ${'a'.repeat(1024 * 1024)}\n\n`])).rejects.toThrow('SSE 单行过长')
  })

  it('跨 chunk 的半行超过 1MB 时报错', async () => {
    await expect(collect(['data: ' + 'a'.repeat(700 * 1024), 'b'.repeat(700 * 1024)])).rejects.toThrow('SSE 单行过长')
  })
})

/**
 * P2-16 回归：空的 `data:` 帧是**合法的心跳**（`data:` 后直接空行）。
 *
 * 很多网关/反代定期发它保活。旧实现照样派发出去，适配器 `JSON.parse('')` 抛
 * 「上游流式数据不是合法 JSON」，整条流直接失败——心跳把正常对话打断。
 */
describe('空 data 帧（心跳）', () => {
  it('空 data 帧不派发', async () => {
    await expect(collect(['data:\n\n'])).resolves.toEqual([])
  })

  it('心跳夹在正常帧之间时，正常帧照常解析', async () => {
    await expect(collect(['data:\n\ndata: {"a":1}\n\ndata:\n\n'])).resolves.toEqual([{ data: '{"a":1}' }])
  })

  it('只有空白字符的 data 帧同样丢弃', async () => {
    await expect(collect(['data:   \n\n'])).resolves.toEqual([])
  })

  it('空帧后面紧跟的 event 不会被错配到下一帧（event 与 data 同帧配对）', async () => {
    await expect(collect([
      'event: ping\ndata:\n\n',
      'event: message_delta\ndata: {"a":1}\n\n',
    ])).resolves.toEqual([{ event: 'message_delta', data: '{"a":1}' }])
  })
})

/**
 * 适配器共享的心跳场景：Anthropic 的 keep-alive 空帧不能让流失败。
 * 这里用 Anthropic 适配器跑一条夹着心跳的完整流，确认事件数量与内容都对。
 */
describe('适配器在心跳帧下不中断', () => {
  it('Anthropic 流里夹空 data 帧仍然正常产出', async () => {
    const { anthropic } = await import('./protocols/anthropic.js')
    const encoder = new TextEncoder()
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of [
          'data:\n\n',
          'event: content_block_delta\ndata: {"index":0,"delta":{"type":"text_delta","text":"好"}}\n\n',
          'data:\n\n',
          'event: message_stop\ndata: {"type":"message_stop"}\n\n',
        ]) controller.enqueue(encoder.encode(chunk))
        controller.close()
      },
    })
    const out: string[] = []
    for await (const event of anthropic.parseStream(body)) {
      if (event.type === 'text_delta') out.push(event.text)
    }
    expect(out).toEqual(['好'])
  })
})
