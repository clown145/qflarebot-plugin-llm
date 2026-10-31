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

import type { ModelConfig, ReasoningEffort } from '../config/types.js'

/**
 * Anthropic 的 `budget_tokens` 下限，来自官方文档的硬性约束。
 *
 * 小于它会直接 `400 thinking.budget_tokens: Input should be greater than or equal to 1024`。
 */
const ANTHROPIC_MIN_BUDGET = 1024

/**
 * 思考预算占用多少输出配额、要预留多少给正文。
 *
 * 用于装配层（`protocols/*.ts` 的 buildChat）在决定 `max_tokens` 时同时满足两条硬约束：
 *
 * - **Anthropic**：thinking 与正文**共享** `max_tokens`，要求 `budget_tokens < max_tokens`，
 *   而且贴着上限会把正文挤成 0 —— 所以 `max_tokens` 至少是 `预算 + 余量`。
 * - **Gemini 2.5**：实际思考 token 计入 `thoughtsTokenCount`（由输出预算承担），
 *   `maxOutputTokens` 小于 `thinkingBudget` 时上游直接
 *   `400 INVALID_ARGUMENT: maxOutputTokens must be greater than thinkingBudget`。
 * - OpenAI 的 `reasoning_effort`、Gemini 3.x 的 `thinkingLevel` 没有显式预算，不用预留。
 *
 * 装配层还要考虑模型的 `max_output_tokens` 硬上限：预算 + 余量顶到上限时，
 * 宁可把预算压回上限以内，也不能发出一个超过模型上限的 `max_tokens`（同样 400）。
 */
export const OUTPUT_RESERVE = 1024

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
 *
 * **例外：2.5 Pro 不接受 0**。它只收 `128–32768` 或 `-1`，发 0 直接
 * `400 INVALID_ARGUMENT`；`minimal` 在 Pro 上退化成最小正预算 128。
 */
const GEMINI_BUDGET: Record<ReasoningEffort, number> = {
  minimal: 0,
  low: 1024,
  medium: 4096,
  high: 8192,
}

/** 2.5 Pro 允许的最小正预算；0（关闭思考）在 Pro 上不合法 */
const GEMINI_PRO_MIN_BUDGET = 128

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
 * 是不是 Gemini 2.5 Pro（含 `2.5-pro-preview` 之类变体）。
 *
 * Pro 与 Flash 对 `thinkingBudget: 0` 的接受度不同：Flash 允许 0（关闭思考），
 * Pro 只收 `128–32768` 或 `-1`，发 0 直接 400。
 */
function isGemini25Pro(model: string): boolean {
  const name = model.toLowerCase()
  return name.includes('gemini-2.5-pro') || (name.includes('gemini-2.5') && name.includes('pro'))
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

/** Anthropic 某等级对应的预算；`undefined` / `minimal` 时为 0，供装配层判断要不要抬 max_tokens */
export function anthropicBudgetOf(effort: ReasoningEffort | undefined): number {
  if (!effort) return 0
  return ANTHROPIC_BUDGET[effort] ?? 0
}

/**
 * 给 Gemini 生成 `generationConfig.thinkingConfig`。
 *
 * 按模型世代二选一，**不能两个都发**：
 * - 2.5 系列 → `{ thinkingBudget: N }`（`minimal` 是 0 = 关闭思考；2.5 Pro 上退化成 128）
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
  const budget = GEMINI_BUDGET[effort]
  // 2.5 Pro 只收 128–32768 或 -1；0 会直接 400 INVALID_ARGUMENT。
  // 语义上「很浅」仍然是想得尽可能少 → 用允许的最小正预算，而不是硬塞一个非法值。
  if (budget === 0 && isGemini25Pro(model)) {
    return { thinkingBudget: GEMINI_PRO_MIN_BUDGET }
  }
  return { thinkingBudget: budget }
}

/**
 * 装配层（各适配器的 buildChat）最终采用的输出上限与思考开关。
 *
 * `thinking` 为 undefined 表示这一轮**不发思考**（没配等级、协议没有对应形状、
 * 或者模型的输出上限根本放不下思考预算）；其它情况是**最终要发出去的字段值**。
 */
export interface AnthropicOutputPlan {
  /** 最终写进请求的 `max_tokens` */
  maxTokens: number
  /** 最终写进 `thinking` 的对象；undefined = 不发 thinking 字段 */
  thinking?: { type: 'enabled'; budget_tokens: number }
}

export interface GeminiOutputPlan {
  /** 最终写进请求的 `generationConfig.maxOutputTokens` */
  maxTokens: number
  /**
   * 最终写进 `generationConfig.thinkingConfig` 的对象；undefined = 不发。
   * 注意 `{ thinkingBudget: 0 }` 是**合法值**（2.5 系列关闭思考），与「不发」不是一回事。
   */
  thinkingConfig?: Record<string, unknown>
}

/**
 * 算 Anthropic 的 `max_tokens` + `thinking`，同时满足全部硬约束：
 *
 * - `budget_tokens` ≥ 1024；
 * - `budget_tokens` **严格小于** `max_tokens`（否则 400）；
 * - 思考与正文共享同一个输出预算，贴着上限会把正文挤成 0 → 至少 `预算 + 余量`；
 * - 不超过模型自己的 `max_output_tokens`（超过同样 400）。
 *
 * 所以不能简单地「把输出上限抬到预算的两倍」——预算 8192 时那是 16384，
 * 直接撞上 `claude-3-5-sonnet`（8192）这类模型的上限。放不下时**直接不发思考**：
 * 少想一次只是体验降级，发一个必 400 的组合会让整轮对话不可用。
 */
export function planAnthropicOutput(options: {
  effort: ReasoningEffort | undefined
  requestedMaxTokens: number
  /** 模型配置里的输出上限（`max_output_tokens`），未知时 undefined */
  outputCap?: number | undefined
}): AnthropicOutputPlan {
  const requested = normalizeTokens(options.requestedMaxTokens)
  const budget = anthropicBudgetOf(options.effort)
  // minimal / 未配置：不发 thinking（minimal 在 Anthropic 上没有合法表达）
  if (budget <= 0) return { maxTokens: requested }
  const fitted = fitBudget(requested, budget, ANTHROPIC_MIN_BUDGET, options.outputCap)
  return fitted.budget === undefined
    ? { maxTokens: fitted.maxTokens }
    : { maxTokens: fitted.maxTokens, thinking: { type: 'enabled', budget_tokens: fitted.budget } }
}

/**
 * 算 Gemini 的 `maxOutputTokens` + `thinkingConfig`。
 *
 * 上游要求 `maxOutputTokens > thinkingBudget`（否则
 * `400 INVALID_ARGUMENT: maxOutputTokens must be greater than thinkingBudget`），
 * 而旧实现各算各的：`ping()` 用 `max_tokens: 16`、模型配了 `high` 就发 8192，必坏。
 *
 * `thinkingLevel`（3.x）没有显式预算、也不受 `maxOutputTokens` 约束，原样发。
 */
export function planGeminiOutput(options: {
  effort: ReasoningEffort | undefined
  model: string
  requestedMaxTokens: number
  outputCap?: number | undefined
}): GeminiOutputPlan {
  const requested = normalizeTokens(options.requestedMaxTokens)
  const config = geminiThinkingConfig(options.effort, options.model)
  if (!config) return { maxTokens: requested }
  const raw = config['thinkingBudget']
  // 3.x 的 thinkingLevel：没有可预留的预算
  if (typeof raw !== 'number') return { maxTokens: requested, thinkingConfig: config }
  // 0 = 明确关闭思考（2.5 Flash 系列合法）：不需要给正文留额外余地，原样发
  if (raw <= 0) return { maxTokens: requested, thinkingConfig: config }
  const fitted = fitBudget(requested, raw, GEMINI_PRO_MIN_BUDGET, options.outputCap)
  // 预算被压到 0 或整个放弃：回落到「关闭思考」这个**合法**状态，而不是发一个 400 的组合
  if (fitted.budget === undefined) return { maxTokens: fitted.maxTokens, thinkingConfig: { thinkingBudget: 0 } }
  return { maxTokens: fitted.maxTokens, thinkingConfig: { thinkingBudget: fitted.budget } }
}

function normalizeTokens(value: number): number {
  return Number.isFinite(value) && value >= 1 ? Math.trunc(value) : 1
}

/**
 * 调用方自己用 `extra_body` 指定了思考预算时：把输出上限抬到跟它自洽。
 *
 * `extra_body` 是「调用方更具体所以优先」，但优先不等于可以发出一个必 400 的组合：
 * Anthropic 要求 `budget_tokens < max_tokens`，Gemini 要求 `maxOutputTokens > thinkingBudget`。
 * 这里只负责算输出上限；`fits === false` 表示**连模型的输出上限都放不下**这个预算，
 * 适配器据此放弃调用方指定的思考字段（并 warn），而不是发出去等 400。
 */
export function maxTokensForBudget(options: {
  requestedMaxTokens: number
  budget: number
  /** 模型配置里的输出上限（`max_output_tokens`），未知时 undefined */
  outputCap?: number | undefined
  /** 需要给正文留的余量；Anthropic 共享预算用 1024，Gemini 只要严格大于即可 */
  reserve?: number
}): { maxTokens: number; fits: boolean } {
  const requested = normalizeTokens(options.requestedMaxTokens)
  const budget = Math.trunc(options.budget)
  if (!Number.isFinite(budget) || budget <= 0) return { maxTokens: requested, fits: true }
  const reserve = options.reserve ?? OUTPUT_RESERVE
  const wanted = Math.max(requested, budget + reserve)
  const cap = options.outputCap !== undefined && Number.isFinite(options.outputCap) && options.outputCap >= 1
    ? Math.trunc(options.outputCap)
    : undefined
  if (cap === undefined) return { maxTokens: wanted, fits: true }
  const maxTokens = Math.min(wanted, cap)
  return { maxTokens, fits: maxTokens > budget }
}

/**
 * `plan*Output` 的收尾：抬到「预算 + 余量」，再按模型上限压回。
 *
 * 返回的 `budget` 为 undefined 表示「放不下，这一轮不发思考」。
 */
function fitBudget(requested: number, budget: number, minBudget: number, outputCap: number | undefined): { maxTokens: number; budget?: number } {
  const maxTokens = Math.max(requested, budget + OUTPUT_RESERVE)
  if (outputCap === undefined || !Number.isFinite(outputCap) || outputCap < 1) {
    return { maxTokens, budget }
  }
  const cap = Math.trunc(outputCap)
  if (maxTokens <= cap) return { maxTokens, budget }
  const room = cap - OUTPUT_RESERVE
  // 放不下最小合法预算：这一轮不发思考，至少不要让请求一定 400
  if (room < minBudget) return { maxTokens: cap }
  return { maxTokens: cap, budget: Math.min(budget, room) }
}

export { isGemini3, isGemini25Pro, ANTHROPIC_MIN_BUDGET }
