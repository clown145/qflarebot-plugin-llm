import type { ConfigGetResponse, ConfigPutResponse, MetaResponse } from '../src/apiTypes.js'
import type { ConfigIssue } from '../src/config/types.js'
import type { AppConfigDraft, Tab } from './types.js'
import { clone, fromPublicConfig } from './types.js'

export interface AppState {
  meta: MetaResponse | null
  config: AppConfigDraft | null
  saved: AppConfigDraft | null
  version: number
  updatedAt: string
  issues: ConfigIssue[]
  corrupt: boolean
  activeTab: Tab
  busy: boolean
}

export const state: AppState = {
  meta: null,
  config: null,
  saved: null,
  version: 0,
  updatedAt: '',
  issues: [],
  corrupt: false,
  activeTab: 'overview',
  busy: false,
}

/**
 * 保存成功后通知各视图把本地草稿 rebase 到新的已保存配置。
 *
 * 视图的草稿是独立对象，`applySaved` 只替换 `state.config` / `state.saved`，
 * 不会碰草稿。没有这个回调时，别处（比如模型即时保存、另一个标签页）保存后，
 * 草稿里没被用户改过的字段（enabled / timeout_ms / …）会一直停在旧值。
 *
 * 回调参数是「上一次已保存的配置」和「这次已保存的配置」，视图据此判断用户改过哪些字段。
 */
export type SavedAppliedListener = (previous: AppConfigDraft | null, next: AppConfigDraft) => void

const listeners = new Set<() => void>()
const savedAppliedListeners = new Set<SavedAppliedListener>()

export function subscribe(fn: () => void): void {
  listeners.add(fn)
}

/** 注册草稿 rebase 回调；返回取消注册的函数。 */
export function onSavedApplied(listener: SavedAppliedListener): () => void {
  savedAppliedListeners.add(listener)
  return () => {
    savedAppliedListeners.delete(listener)
  }
}

export function emit(): void {
  for (const fn of listeners) fn()
}

function applyConfig(next: AppConfigDraft, data: { version: number; updated_at: string }): void {
  const previous = state.saved
  state.config = next
  state.saved = clone(next)
  state.version = data.version
  state.updatedAt = data.updated_at
  for (const listener of savedAppliedListeners) listener(previous ? clone(previous) : null, clone(next))
}

export function setLoaded(data: ConfigGetResponse): void {
  applyConfig(fromPublicConfig(data.config), data.config)
  state.issues = data.issues
  state.corrupt = data.corrupt
  emit()
}

export function applySaved(data: ConfigPutResponse): void {
  applyConfig(fromPublicConfig(data.config), data.config)
  state.issues = data.issues
  state.corrupt = false
  emit()
}

export function setMeta(meta: MetaResponse): void {
  state.meta = meta
}

export function setBusy(busy: boolean): void {
  state.busy = busy
  emit()
}
