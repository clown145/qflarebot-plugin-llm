import type { ConfigIssue } from '../src/config/types.js'
import { ApiError, api, toast } from './api.js'
import { confirmDialog } from './dialogs.js'
import { applySaved, setBusy, state } from './state.js'
import type { AppConfigDraft } from './types.js'
import { clone, toInput } from './types.js'

type Outcome = 'ok' | 'failed' | 'invalid' | 'conflict' | 'reloaded'

export interface SaveCallbacks {
  reload: () => Promise<void>
  rerender: () => void
}

let callbacks: SaveCallbacks | null = null
let queue: Promise<unknown> = Promise.resolve()

export function configureSaving(next: SaveCallbacks): void {
  callbacks = next
}

/** 所有写 KV 的操作走同一条队列，避免两个 PUT 用同一个版本号。 */
function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task)
  queue = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

function issuesOf(err: unknown): ConfigIssue[] | undefined {
  if (!(err instanceof ApiError) || !err.payload || typeof err.payload !== 'object') return undefined
  const errors = (err.payload as { errors?: unknown }).errors
  return Array.isArray(errors) ? (errors as ConfigIssue[]) : undefined
}

async function put(): Promise<Outcome> {
  if (!state.config) return 'failed'
  setBusy(true)
  try {
    const data = await api.saveConfig({ version: state.version, config: toInput(state.config) })
    applySaved(data)
    return 'ok'
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) {
      const ok = await confirmDialog('配置已经被别处修改。重新加载会丢弃当前页面上未保存的编辑。', '重新加载')
      if (ok && callbacks) {
        await callbacks.reload()
        return 'reloaded'
      }
      await toast('配置已被别处修改，请刷新后再试', 'error')
      return 'conflict'
    }
    const issues = issuesOf(err)
    if (issues) {
      state.issues = issues
      await toast('配置有误，请按提示修改', 'error')
      return 'invalid'
    }
    await toast(err instanceof Error ? err.message : String(err), 'error')
    return 'failed'
  } finally {
    setBusy(false)
  }
}

/**
 * 先改页面上的配置，再立即保存；失败回滚到修改前。
 * 调用方负责成功后的重新渲染。
 */
export function updateConfig(
  mutator: (config: AppConfigDraft) => void,
  options: { success?: string } = {},
): Promise<boolean> {
  return enqueue(async () => {
    if (!state.config) return false
    const before = clone(state.config)
    mutator(state.config)
    const outcome = await put()
    if (outcome === 'ok') {
      if (options.success) await toast(options.success, 'success')
      return true
    }
    if (outcome === 'reloaded') return false
    state.config = before
    callbacks?.rerender()
    return false
  })
}
