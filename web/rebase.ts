/**
 * 草稿 rebase：保存成功后把「用户改过的字段保留、其余字段取最新已保存值」合并进本地草稿。
 *
 * 视图里的草稿（供应商编辑、默认设置）是独立对象，`state.config` 被整体替换时不会自动更新。
 * 没有 rebase 时，别处保存（比如模型即时保存、另一个标签页）之后，草稿里没被用户改过的
 * 字段会一直停在旧值，再点保存就把旧值写回去，覆盖别处的改动。
 *
 * 这里只放纯函数，方便单测；视图在 `onSavedApplied` 回调里调用。
 */

import type { ProviderDraft } from './types.js'

/** 默认设置的草稿形状（与 web/views/settings.ts 保持一致） */
export interface SettingsDraftLike {
  default_model: string
  request_timeout_ms: number
  max_retries: number
}

/** 供应商里由后端保存、可以被 rebase 的字段；api_key / clear_key / api_key_set 单独处理 */
const PROVIDER_FIELDS = ['name', 'protocol', 'base_url', 'timeout_ms', 'enabled', 'headers', 'allow_http'] as const

/** 稳定序列化：对象键排序后再比较，避免请求头顺序影响「是否改过」的判断 */
function stable(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (value === null) return 'null'
  if (typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`
}

export function sameValue(left: unknown, right: unknown): boolean {
  return stable(left) === stable(right)
}

/**
 * 把供应商草稿 rebase 到最新已保存的供应商。
 *
 * - `previous` 是上一次已保存的版本，用来判断用户改过哪些字段；
 * - 用户改过的字段保留草稿值，没改过的字段取 `next`；
 * - `api_key_set` 只在本机没有输入新 Key、也没有点清除时跟随服务端；
 * - 没有基线（previous 为 null）时原样返回，避免把「未知」当成「用户改过」。
 */
export function rebaseProviderDraft(
  draft: ProviderDraft,
  previous: ProviderDraft | null | undefined,
  next: ProviderDraft,
): ProviderDraft {
  if (!previous) return { ...draft }
  const out: ProviderDraft = { ...draft }
  const target = out as unknown as Record<string, unknown>
  const after = next as unknown as Record<string, unknown>
  for (const field of PROVIDER_FIELDS) {
    if (!sameValue(draft[field], previous[field])) continue
    if (after[field] === undefined) delete target[field]
    else target[field] = after[field]
  }
  const typed = Boolean(draft.api_key?.trim())
  if (!typed && !draft.clear_key) out.api_key_set = next.api_key_set
  return out
}

/** 默认设置草稿的 rebase；规则同供应商。 */
export function rebaseSettingsDraft(
  draft: SettingsDraftLike,
  previous: SettingsDraftLike | null | undefined,
  next: SettingsDraftLike,
): SettingsDraftLike {
  if (!previous) return { ...draft }
  return {
    default_model: sameValue(draft.default_model, previous.default_model) ? next.default_model : draft.default_model,
    request_timeout_ms: sameValue(draft.request_timeout_ms, previous.request_timeout_ms)
      ? next.request_timeout_ms
      : draft.request_timeout_ms,
    max_retries: sameValue(draft.max_retries, previous.max_retries) ? next.max_retries : draft.max_retries,
  }
}
