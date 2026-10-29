/**
 * 工具名的上游合法化（内部名 ↔ wire 名）。
 *
 * ## 为什么要做
 *
 * 插件里的工具名习惯写成 `<域>.<动作>`（`time.now`、`vfs.read_file`），可读、好归类。
 * 但上游对工具名的字符集有硬性要求，各家还不一样：
 *
 * - **OpenAI 兼容（含 DeepSeek）**：`^[a-zA-Z0-9_-]+$`。**点号直接 400**：
 *   `Invalid 'tools[0].function.name': string does not match pattern`
 * - **Gemini**：function 声明名只接受字母数字下划线（不允许连字符），且首字符不能是数字
 * - **Anthropic**：实际较宽松，但统一按最严口径生成，换模型时名字不必再变
 *
 * 于是「内部叫什么」与「发出去叫什么」必须分开：发出去的一律换成合法标识符，
 * 模型选中的调用再换回内部名 —— 调用方（插件）看到的始终是自己定义的名字。
 *
 * ## 为什么放在 service 层而不是每个 adapter 里
 *
 * 三套协议要做同一件事，差别只在一个字符集。放在 service 的请求/响应边界上：
 * 映射只建一次、单次调用内自然自洽（`tools[].name`、`tool_choice.name`、回包与流式增量里的
 * `tool_calls[].name`、Gemini 思考签名里的 `tool_name` 全在这一层对齐），
 * 而放进 adapter 则要各自维护，且流式要跨 chunk 记忆状态，容易漏。
 *
 * ## 模型怎么知道真实名字
 *
 * 换名后模型只看到 `time_now`。所以在 description 尾部补一句原始名
 * （`Internal tool name: time.now.`）—— 既帮模型判断用途，排障时也对得上号。
 * 与 serverless-agent 的 `tool-name-mapper.ts` 同一做法。
 */
import type { ChatRequest, ThoughtSignature, ToolCall, ToolDefinition } from './contract.js'
import type { ProtocolId } from './config/types.js'

/** 各协议不允许出现在工具名里的字符；未收录的协议按 OpenAI 兼容口径 */
const ILLEGAL_CHARS: Record<string, RegExp> = {
  openai: /[^a-zA-Z0-9_-]/g,
  gemini: /[^a-zA-Z0-9_]/g,
  anthropic: /[^a-zA-Z0-9_-]/g,
}

/** 上游最严的合法名字口径（OpenAI 与 Gemini 的交集）；导出便于测试与文档引用 */
export const WIRE_TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/

/** OpenAI 兼容实现普遍限制 64 字符；留余量给去重后缀 */
const MAX_WIRE_NAME = 64

/** 内部工具名 → 上游可接受的标识符 */
export function sanitizeToolName(name: string, protocol: ProtocolId): string {
  const illegal = ILLEGAL_CHARS[protocol] ?? ILLEGAL_CHARS['openai']!
  const normalized = name.replace(illegal, '_')
  // 首字符必须是字母或下划线（Gemini 明确要求；多数兼容实现也这样校验）
  const prefixed = /^[a-zA-Z_]/.test(normalized) ? normalized : `tool_${normalized}`
  return prefixed.length > MAX_WIRE_NAME ? prefixed.slice(0, MAX_WIRE_NAME) : prefixed
}

export interface ToolNameMap {
  /** 内部名 → 发出去的名字 */
  toWire(name: string): string
  /** 发出去的名字 → 内部名；对不上就原样返回（模型可能编出不存在的名字） */
  toInternal(name: string): string
  /** 内部名是否被改过 */
  renamed(name: string): boolean
}

/**
 * 为单次调用建立双向映射。
 *
 * 输入是本次请求出现的所有内部工具名；同一内部名每次都映射到同一 wire 名，
 * 不同内部名不会撞到同一个 wire 名（撞了加 `_2`、`_3` 后缀）。
 * 映射不跨调用共享——配置改过之后不该残留旧映射。
 */
export function createToolNameMap(names: readonly string[], protocol: ProtocolId): ToolNameMap {
  const internalToWire = new Map<string, string>()
  const wireToInternal = new Map<string, string>()

  for (const name of names) {
    const base = sanitizeToolName(name, protocol)
    let wire = base
    let suffix = 2
    while (wireToInternal.has(wire)) {
      const tail = `_${suffix}`
      // 截断过的长名再加后缀会超限，所以从 base 上先切出空间
      wire = `${base.slice(0, MAX_WIRE_NAME - tail.length)}${tail}`
      suffix += 1
    }
    internalToWire.set(name, wire)
    wireToInternal.set(wire, name)
  }

  return {
    // 没登记的名字也走一次合法化：模型编名字时上游仍要能接受 tools 列表
    toWire: (name) => internalToWire.get(name) ?? sanitizeToolName(name, protocol),
    // 对不上时原样返回：调用方拿到一个不存在的名字，会在自己的白名单里被拒
    toInternal: (name) => wireToInternal.get(name) ?? name,
    renamed: (name) => (internalToWire.get(name) ?? sanitizeToolName(name, protocol)) !== name,
  }
}

/** 发请求前的映射：换 tools 名、补原始名说明、换 tool_choice 里的名字 */
export function mapRequestToolNames(request: ChatRequest, map: ToolNameMap): ChatRequest {
  const tools = request.tools
  if (!tools?.length) return request

  const mappedTools: ToolDefinition[] = tools.map((tool) => {
    const wire = map.toWire(tool.name)
    if (wire === tool.name) return tool
    const note = `Internal tool name: ${tool.name}.`
    return {
      ...tool,
      name: wire,
      description: tool.description ? `${tool.description} ${note}` : note,
    }
  })

  const choice = request.tool_choice
  const mappedChoice: ChatRequest['tool_choice'] =
    choice && typeof choice === 'object' && 'name' in choice ? { name: map.toWire(choice.name) } : choice

  const next: ChatRequest = { ...request, tools: mappedTools }
  if (mappedChoice !== undefined) next.tool_choice = mappedChoice
  return next
}

/**
 * 回包里的工具调用名换回内部名。
 *
 * **注意顺带处理 `thought_signatures[].tool_name`**：Gemini 回传签名时按
 * `tool_call_id` → `tool_name` 匹配 part，签名里的 tool_name 是**上游名字**；
 * 若只换 `toolCalls` 而不换签名里的名字，下一轮回传时会按内部名去找上游名、匹配不上，
 * 签名贴不回函数调用 part → 上游 400 INVALID_ARGUMENT。
 */
export function mapResultToolNames(
  calls: readonly ToolCall[] | undefined,
  signatures: readonly ThoughtSignature[] | undefined,
  map: ToolNameMap,
): { toolCalls?: ToolCall[]; thoughtSignatures?: ThoughtSignature[] } {
  const mappedCalls = calls?.length ? calls.map((call) => ({ ...call, name: map.toInternal(call.name) })) : undefined
  const mappedSignatures = signatures?.length
    ? signatures.map((item) =>
        item.tool_name === undefined ? {...item} : { ...item, tool_name: map.toInternal(item.tool_name) },
      )
    : undefined

  return {
    ...(mappedCalls ? { toolCalls: mappedCalls } : {}),
    ...(mappedSignatures ? { thoughtSignatures: mappedSignatures } : {}),
  }
}

/**
 * 回填历史时把内部名换回 wire 名。
 *
 * 多轮工具调用要把上一轮的 `assistant.tool_calls` 原样回传，上游按 wire 名核对，
 * 所以这里必须是 wire 名，而不是公告给调用方的内部名。
 */
export function mapHistoryToolNames(request: ChatRequest, map: ToolNameMap): ChatRequest {
  const messages = request.messages
  if (!messages.length) return request

  let changed = false
  const mapped = messages.map((message) => {
    const calls = message.tool_calls
    if (!calls?.length) return message
    changed = true
    return {
      ...message,
      tool_calls: calls.map((call) => ({ ...call, name: map.toWire(call.name) })),
    }
  })
  return changed ? { ...request, messages: mapped } : request
}

/**
 * 建立本次调用的完整映射：既要覆盖要发的工具，也要覆盖历史里出现过的调用名
 * （后者用于回填，模型上一轮调用过、这一轮可能不再提供同名工具）。
 */
export function toolNameMapFor(request: ChatRequest, protocol: ProtocolId): ToolNameMap {
  const names = new Set<string>()
  for (const tool of request.tools ?? []) names.add(tool.name)
  for (const message of request.messages) for (const call of message.tool_calls ?? []) names.add(call.name)
  return createToolNameMap([...names], protocol)
}
