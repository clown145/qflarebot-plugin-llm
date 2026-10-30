/**
 * 思考等级 → 各协议请求体字段的翻译。
 *
 * ## 为什么需要这一层
 *
 * 「推理深度」在三个协议里是三套完全不同的机制，而且**同一协议内还会随模型世代变**：
 *
 * - **OpenAI 兼容**：`reasoning_effort: "low" | "medium" | "high"`（部分供应商还有 `minimal`）。
 *   这是个字符串枚举，最直接。
 * - **Anthropic**：`thinking: { type: "enabled", budget_tokens: N }`。
 *   没有等级概念，只有 token 预算，而且**硬性要求 `budget_tokens >= 1024`**，
 *   且必须**小于 `max_tokens`**（否则 400）。新一代模型改用 `thinking: { type: "adaptive" }`
 *   + `output_config.effort`，老写法在 Opus 4.6 / Sonnet 4.6 上已标记弃用。
 * - **Gemini**：2.5 系列用 `thinkingConfig.thinkingBudget`（token 数）；
 *   3.x 系列改用 `thinkingConfig.thinkingLevel`（`MINIMAL` / `LOW` / `MEDIUM` / `HIGH`）。
 *   **两套认模型名，混用会 400**。
 *
 * 所以用户只填一个等级，这一层负责把它翻译成上游能吃的形状。
 *
 * ## 设计取舍：翻译失败时宁可「不传」
 *
 * 所有函数在遇到「这个等级在这个协议上没有合理表达」时返回 `undefined`（= 不干预），
 * 而不是硬塞一个值。理由：推理参数错误在上游几乎都是 **400 硬失败**，
 * 一次坏参数会让整轮对话完全不可用；而「少调了一次推理深度」只是体验降级。
 * 宁可退化成上游默认值，也不要让用户的对话直接失败。
 */

import type { ModelConfig, ProviderConfig, ReasoningEffort } from '../config/types.js'

/**
 * Anthropic 的 `budget_tokens` 下限，来自官方文档的硬性约束。
 *
 * 小于它会直接 `400 thinking.budget_tokens: Input should be greater than or equal to 1024`。
 */
const ANTHROPIC_MIN_BUDGET = 1024

/**
 * 等级 → Anthropic 思考预算（tokens）。
 *
 * 取值参考：官方示例常用 1024 / 2048 / 4096 / 8192。这里刻意不用更大的数字——
 * 思考 token 计入输出计费，而且会**挤占** `max_tokens` 配额（thinking 与正文共享同一个
 * 输出预算），给太高会让正文被截断。
 *
 * `minimal` 映射到「关闭思考」而不是最小预算：Anthropic 没有「想一点点」这个档，
 * 关掉比给 1024 更接近用户的意图（1024 已经是一笔不小的开销）。
 */
const ANTHROPIC_BUDGET: Record<ReasoningEffort, number | null> = {
  minimal: null, // null = 显式关闭，不发 thinking 字段
  low: ANTHROPIC_MIN_BUDGET,
  medium: 4096,
  high: 8192,
}

/**
 * 等级 → Gemini 2.5 的 `thinkingBudget`（tokens）。
 *
 * Gemini 2.5 的规则和 Anthropic 不同：
 * - `0` = **完全关闭思考**（这是 2.5 特有的，Anthropic 没有等价物）
 * - `-1` = 动态（由模型自己决定）
 * - 正数 = 预算上限
 *
 * 所以 `minimal` 在这里能真正表达成「关掉」，比 Anthropic 那条路更贴合语义。
 */
const GEMINI_BUDGET: Record<ReasoningEffort, number> = {
  minimal: 0,
  low: 1024,
  medium: 4096,
  high: 8192,
}

/** 等级 → Gemini 3.x 的 `thinkingLevel`（枚举，全大写） */
const GEMINI_LEVEL: Record<ReasoningEffort, string> = {
  minimal: 'MINIMAL',
  low: 'LOW',
  medium: 'MEDIUM',
  high: 'HIGH',
}

/**
 * 判断是不是 Gemini 3.x 系列（用 `thinkingLevel` 而不是 `thinkingBudget`）。
 *
 * 按模型名前缀判断，和 AstrBot 的做法一致（它也是前缀匹配，好让新变体
 * 比如 `3.1` / `3-flash-lite-preview` 自动被覆盖）。
 *
 * 注意匹配 `3-` 和 `3.` 两种写法：官方模型名是 `gemini-3-pro-preview` 这种
 * （`3-`），但部分网关会写成 `gemini-3.0-pro`（`3.`）。
 */
function isGemini3(model: string): boolean {
  const name = model.toLowerCase()
  return name.includes('gemini-3-') || name.includes('gemini-3.')
}

/**
 * 单次 chat 调用实际生效的思考等级。
 *
 * 优先级：**请求显式传的 > 模型配置的**。请求层可以通过 `reasoning_effort` 字段
 * 覆盖（例如某个调用方想让这一轮想得更深），不传就用模型配置。
 */
export function effectiveEffort(
  request: { reasoning_effort?: ReasoningEffort },
  model: ModelConfig,
): ReasoningEffort | undefined {
  return request.reasoning_effort ?? model.reasoning_effort
}

/**
 * 给 OpenAI 兼容协议生成 `reasoning_effort` 字段值。
 *
 * 直接透传等级。但要注意：**不是所有 OpenAI 兼容上游都认这个字段**。
 * 认的（OpenAI o 系列、DeepSeek reasoner、多数中转网关）会用它控制思考量；
 * 不认的网关通常会静默忽略未知字段，少数会 400。
 *
 * 所以这里只在用户**显式配了等级**时才返回，没配就完全不发——
 * 这样对「不认这个字段」的上游保持零影响。
 */
export function openAIReasoningEffort(effort: ReasoningEffort | undefined): string | undefined {
  return effort
}

/**
 * 给 Anthropic 生成 `thinking` 字段。
 *
 * 两种形态：
 * - `minimal` → `undefined`（不发字段 = 保持默认；显式关闭思考要发 `{type:'disabled'}`，
 *   但那个值并非所有版本都接受，不发更安全）
 * - 其余等级 → `{ type: 'enabled', budget_tokens: N }`
 *
 * ## 与 max_tokens 的关系（调用方必须处理）
 *
 * Anthropic 要求 `budget_tokens < max_tokens`。这个约束在 `service.ts` 里统一兜底：
 * 开了思考时会把 `max_tokens` 抬到 `budget + 余量`。这里只负责产出 thinking 字段本身，
 * 不修改 max_tokens——那是请求装配层的职责，放在这里会让这个函数有副作用。
 */
export function anthropicThinking(
  effort: ReasoningEffort | undefined,
): { type: 'enabled'; budget_tokens: number } | undefined {
  if (!effort) return undefined
  const budget = ANTHROPIC_BUDGET[effort]
  if (budget === null) return undefined
  return { type: 'enabled', budget_tokens: budget }
}

/** Anthropic 某等级对应的预算；`undefined` / `minimal` 时为 0，供装配层判断要不要抬 max_tokens */
export function anthropicBudgetOf(effort: ReasoningEffort | undefined): number {
  if (!effort) return 0
  return ANTHROPIC_BUDGET[effort] ?? 0
}

/**
 * 给 Gemini 生成 `generationConfig.thinkingConfig`。
 *
 * 按模型世代二选一，**不能两个都发**：
 * - 2.5 系列 → `{ thinkingBudget: N }`（`minimal` 是 0 = 关闭思考）
 * - 3.x 系列 → `{ thinkingLevel: 'HIGH' }`
 *
 * 返回的对象由调用方合进 `generationConfig`。
 */
export function geminiThinkingConfig(
  effort: ReasoningEffort | undefined,
  model: string,
): Record<string, unknown> | undefined {
  if (!effort) return undefined
  if (isGemini3(model)) {
    return { thinkingLevel: GEMINI_LEVEL[effort] }
  }
  return { thinkingBudget: GEMINI_BUDGET[effort] }
}

/**
 * 某个模型的思考等级是否会让正文预算被挤占。
 *
 * 用于 `service.ts` 在装配请求时决定要不要抬高 `max_tokens`。
 * 只有 Anthropic 有这个约束（thinking 与正文共享 `max_tokens`）；
 * OpenAI 的 `reasoning_effort` 和 Gemini 的 budget 都是独立配额。
 */
export function needsHeadroomForThinking(protocol: ProviderConfig['protocol'], effort: ReasoningEffort | undefined): number {
  if (protocol !== 'anthropic') return 0
  return anthropicBudgetOf(effort)
}

export { isGemini3, ANTHROPIC_MIN_BUDGET }
