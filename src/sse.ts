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
    const joined = data.join('\n')
    const pendingEvent = event
    event = undefined
    data = []
    // **空的 data 帧是合法的心跳**（`data:` 后直接空行），很多网关/反代定期发它保活。
    // 派发出去会让适配器 `JSON.parse('')` 抛「上游流式数据不是合法 JSON」，
    // 整条流直接失败——心跳把正常对话打断。这里不派发，直接丢弃。
    if (!joined.trim()) return null
    const message: SSEMessage = { data: joined }
    if (pendingEvent) message.event = pendingEvent
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
    if (line.length > MAX_LINE) throw new Error('SSE 单行过长')
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

      for (let line = takeLine(); line !== null; line = takeLine()) {
        const message = accept(line)
        if (message) yield message
      }
      // 完整行已经处理完；剩下的半行超过上限才说明单行真的过长
      if (buffer.length > MAX_LINE) throw new Error('SSE 单行过长')
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
