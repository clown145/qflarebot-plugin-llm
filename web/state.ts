import type { ConfigGetResponse, ConfigPutResponse, MetaResponse } from '../src/apiTypes.js'
import type { ConfigIssue } from '../src/config/types.js'
import type { AppConfigDraft, Tab } from './types.js'
import { clone, fromPublicConfig, toInput } from './types.js'

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

const listeners = new Set<() => void>()

export function subscribe(fn: () => void): void {
  listeners.add(fn)
}

export function emit(): void {
  for (const fn of listeners) fn()
}

export function setLoaded(data: ConfigGetResponse): void {
  state.config = fromPublicConfig(data.config)
  state.saved = clone(state.config)
  state.version = data.config.version
  state.updatedAt = data.config.updated_at
  state.issues = data.issues
  state.corrupt = data.corrupt
  emit()
}

export function applySaved(data: ConfigPutResponse): void {
  state.config = fromPublicConfig(data.config)
  state.saved = clone(state.config)
  state.version = data.config.version
  state.updatedAt = data.config.updated_at
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

export function isDirty(): boolean {
  if (!state.config || !state.saved) return false
  return JSON.stringify(toInput(state.config)) !== JSON.stringify(toInput(state.saved))
}
