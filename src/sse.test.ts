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
})
