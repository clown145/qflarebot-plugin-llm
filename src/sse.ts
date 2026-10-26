/** 增量 SSE 解析：只认 data / event，注释行与 id/retry 忽略。 */

export interface SSEMessage {
  event?: string
  data: string
}

const MAX_LINE = 1024 * 1024

export async function* readSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<SSEMessage> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let event: string | undefined
  let data: string[] = []

  const dispatch = (): SSEMessage | null => {
    if (data.length === 0) {
      event = undefined
      return null
    }
    const message: SSEMessage = { data: data.join('\n') }
    if (event) message.event = event
    event = undefined
    data = []
    return message
  }

  const takeLine = (): string | null => {
    const at = buffer.indexOf('\n')
    if (at < 0) return null
    let line = buffer.slice(0, at)
    buffer = buffer.slice(at + 1)
    if (line.endsWith('\r')) line = line.slice(0, -1)
    return line
  }

  const accept = (line: string): SSEMessage | null => {
    if (line === '') return dispatch()
    if (line.startsWith(':')) return null
    const colon = line.indexOf(':')
    const field = colon < 0 ? line : line.slice(0, colon)
    let value = colon < 0 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'event') event = value
    else if (field === 'data') data.push(value)
    return null
  }

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      if (buffer.length > MAX_LINE) throw new Error('SSE 单行过长')

      for (let line = takeLine(); line !== null; line = takeLine()) {
        const message = accept(line)
        if (message) yield message
      }
    }

    buffer += decoder.decode()
    if (buffer && !buffer.endsWith('\n')) buffer += '\n'
    for (let line = takeLine(); line !== null; line = takeLine()) {
      const message = accept(line)
      if (message) yield message
    }
    const last = dispatch()
    if (last) yield last
  } finally {
    try {
      await reader.cancel()
    } catch {
      // 流已经结束或已取消
    }
  }
}
