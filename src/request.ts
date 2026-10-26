import type { ChatMessage, ChatRequest, ToolChoice } from './contract.js'
import { LLMError } from './errors.js'
import { isRecord } from './json.js'

const ROLES = new Set(['system', 'user', 'assistant', 'tool'])

function bad(message: string): never {
  throw new LLMError('bad_request', message)
}

function checkArguments(text: string, where: string): void {
  if (!text.trim()) return
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    bad(`${where} 的 arguments 不是合法 JSON`)
  }
  if (!isRecord(value)) bad(`${where} 的 arguments 必须是 JSON 对象`)
}

function checkMessage(message: ChatMessage, index: number): void {
  const where = `messages[${index}]`
  if (!isRecord(message)) bad(`${where} 必须是对象`)
  if (!ROLES.has(message.role)) bad(`${where}.role 不合法`)
  if (message.content !== undefined && typeof message.content !== 'string') bad(`${where}.content 必须是字符串`)

  if (message.role === 'system' || message.role === 'user') {
    if (!message.content?.trim()) bad(`${where}.content 不能为空`)
    return
  }
  if (message.role === 'tool') {
    if (!message.tool_call_id) bad(`${where}.tool_call_id 必填`)
    return
  }

  const calls = message.tool_calls
  if (calls !== undefined && !Array.isArray(calls)) bad(`${where}.tool_calls 必须是数组`)
  if (!message.content?.trim() && !calls?.length) bad(`${where} 既没有内容也没有工具调用`)
  for (const [i, call] of (calls ?? []).entries()) {
    if (!isRecord(call)) bad(`${where}.tool_calls[${i}] 必须是对象`)
    if (!call.id) bad(`${where}.tool_calls[${i}].id 必填`)
    if (!call.name) bad(`${where}.tool_calls[${i}].name 必填`)
    if (typeof call.arguments !== 'string') bad(`${where}.tool_calls[${i}].arguments 必须是字符串`)
    checkArguments(call.arguments, `${where}.tool_calls[${i}]`)
  }
}

function checkToolChoice(choice: ToolChoice | undefined, names: Set<string>): void {
  if (choice === undefined) return
  if (typeof choice === 'string') {
    if (choice !== 'auto' && choice !== 'none' && choice !== 'required') bad('tool_choice 不合法')
    return
  }
  if (!isRecord(choice) || typeof choice.name !== 'string' || !choice.name) bad('tool_choice 不合法')
  if (!names.has(choice.name)) bad(`tool_choice 指定的工具 ${choice.name} 不在 tools 里`)
}

/** 调用方参数有问题时在发请求前就报 bad_request，别让上游的 400 去猜 */
export function validateChatRequest(request: ChatRequest): void {
  if (!isRecord(request)) bad('请求必须是对象')
  if (request.model !== undefined && typeof request.model !== 'string') bad('model 必须是字符串')
  if (!Array.isArray(request.messages) || request.messages.length === 0) bad('messages 不能为空')
  request.messages.forEach(checkMessage)

  const tools = request.tools
  if (tools !== undefined && !Array.isArray(tools)) bad('tools 必须是数组')
  const names = new Set<string>()
  for (const [i, tool] of (tools ?? []).entries()) {
    if (!isRecord(tool)) bad(`tools[${i}] 必须是对象`)
    if (typeof tool.name !== 'string' || !tool.name.trim()) bad(`tools[${i}].name 必填`)
    if (names.has(tool.name)) bad(`工具名 ${tool.name} 重复`)
    names.add(tool.name)
    if (!isRecord(tool.parameters)) bad(`tools[${i}].parameters 必须是 JSON Schema 对象`)
    if (tool.description !== undefined && typeof tool.description !== 'string') bad(`tools[${i}].description 必须是字符串`)
  }

  checkToolChoice(request.tool_choice, names)
  if (names.size === 0 && request.tool_choice !== undefined && request.tool_choice !== 'auto' && request.tool_choice !== 'none') {
    bad('传了 tool_choice 但没有 tools')
  }
  if (request.temperature !== undefined && (typeof request.temperature !== 'number' || request.temperature < 0 || request.temperature > 2)) {
    bad('temperature 应在 0–2 之间')
  }
  if (request.max_tokens !== undefined && (!Number.isInteger(request.max_tokens) || request.max_tokens < 1)) {
    bad('max_tokens 必须是正整数')
  }
  if (request.top_p !== undefined && (typeof request.top_p !== 'number' || request.top_p < 0 || request.top_p > 1)) {
    bad('top_p 应在 0–1 之间')
  }
  if (request.timeout_ms !== undefined && (typeof request.timeout_ms !== 'number' || request.timeout_ms <= 0)) {
    bad('timeout_ms 必须是正数')
  }
  if (request.stop !== undefined) {
    const stop = request.stop
    if (typeof stop !== 'string' && (!Array.isArray(stop) || stop.some((item) => typeof item !== 'string'))) {
      bad('stop 必须是字符串或字符串数组')
    }
  }
  if (request.extra_body !== undefined && !isRecord(request.extra_body)) bad('extra_body 必须是对象')
  if (request.json !== undefined && typeof request.json !== 'boolean') bad('json 必须是布尔值')
}
