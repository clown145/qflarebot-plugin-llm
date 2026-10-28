import { toast } from '../api.js'
import { copyText, h } from '../dom.js'

function codeBlock(title: string, code: string): HTMLElement {
  const button = h('button', { class: 'btn small', text: '复制', type: 'button' })
  button.addEventListener('click', async () => {
    const ok = await copyText(code)
    await toast(ok ? '已复制' : '复制失败，请手动选择', ok ? 'success' : 'warning')
  })
  return h(
    'div',
    { style: 'margin-bottom:16px' },
    h('h3', { text: title, style: 'margin-bottom:8px' }),
    h('div', { class: 'code-block' }, h('pre', { text: code }), button),
  )
}

export function renderUsage(container: HTMLElement): void {
  container.append(
    h(
      'div',
      { class: 'card' },
      h('div', { class: 'card-head' }, h('div', {}, h('h2', { text: '给插件作者的用法' }), h('p', { class: 'hint', text: '这个插件只提供 llm 服务；聊天、上下文、工具执行都在你自己的插件里。' }))),
      codeBlock(
        '1. 声明依赖',
        `export default definePlugin({
  // 必需依赖：没装或停用 llm 时，安装/运行会明确报错
  depends: { llm: '*' },
})`,
      ),
      codeBlock(
        '2. 调用（非流式）',
        `interface LLMService {
  chat(req: {
    model?: string
    messages: { role: 'system' | 'user' | 'assistant' | 'tool'; content?: string }[]
    temperature?: number
    max_tokens?: number
  }): Promise<{ text: string; model: string; usage?: { input_tokens?: number; output_tokens?: number } }>
}

const llm = ctx.service<LLMService>('llm')
const res = await llm.chat({
  model: 'chat',
  messages: [{ role: 'user', content: '你好' }],
})
return res.text`,
      ),
      codeBlock(
        '3. 流式',
        `const stream = await session.stream()
for await (const ev of llm.stream({ model: 'chat', messages })) {
  if (ev.type === 'text_delta') await stream.write(ev.text)
}
await stream.end()`,
      ),
      codeBlock(
        '4. 工具调用（执行在调用方）',
        `const res = await llm.chat({ model: 'chat', messages, tools })
if (res.tool_calls?.length) {
  messages.push({ role: 'assistant', content: res.text, tool_calls: res.tool_calls })
  for (const call of res.tool_calls) {
    const args = JSON.parse(call.arguments)
    const output = await runTool(call.name, args)
    messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(output) })
  }
  // 再调用一次 llm.chat，把工具结果交回模型
}`,
      ),
      h(
        'div',
        { class: 'issue warn' },
        '工具只做定义透传和调用结果归一化，llm 插件不会执行任何工具；循环、超时、权限都由调用方自己控制。',
      ),
      h('p', { class: 'small muted', text: '完整类型见仓库 src/contract.ts。外部插件不能安装本包，按上面的结构声明即可。' }),
    ),
  )

  container.append(
    h(
      'div',
      { class: 'card' },
      h('h2', { text: '能力与限制' }),
      h(
        'ul',
        { class: 'issue-list', style: 'margin-top:8px' },
        h('li', { class: 'small muted', text: '支持 OpenAI 兼容（Chat Completions）与 Anthropic Messages。' }),
        h('li', { class: 'small muted', text: '工具调用：OpenAI tool_calls / Anthropic tool_use、tool_result 已归一化。' }),
        h('li', { class: 'small muted', text: '单次调用默认 15 秒，实际生效上限 20 秒（配置里可填到 28 秒但会被压到 20）；一次事件总共 30 秒，工具循环请自己控制预算。' }),
        h('li', { class: 'small muted', text: 'API Key 只存在插件 KV，调用方拿不到；调用方只能选模型别名。' }),
        h('li', { class: 'small muted', text: '服务不保存会话，也不做重试之外的排队、限流或计费。' }),
      ),
    ),
  )
}
