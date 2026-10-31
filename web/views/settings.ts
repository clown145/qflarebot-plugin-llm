import { badge, field, fieldError, h } from '../dom.js'
import { timeoutHint, timeoutLimits } from '../limits.js'
import { setPending } from '../pending.js'
import { rebaseSettingsDraft, type SettingsDraftLike } from '../rebase.js'
import { updateConfig } from '../save.js'
import { onSavedApplied, state } from '../state.js'
import { clone } from '../types.js'

type SettingsDraft = SettingsDraftLike

let draft: SettingsDraft | null = null
let touched = false
let saveError = ''
let mountedError: HTMLElement | null = null

function settingsOf(): SettingsDraft | null {
  const config = state.config
  if (!config) return null
  return {
    default_model: config.default_model,
    request_timeout_ms: config.request_timeout_ms,
    max_retries: config.max_retries,
  }
}

function savedSettings(): SettingsDraft | null {
  const config = state.saved
  if (!config) return null
  return {
    default_model: config.default_model,
    request_timeout_ms: config.request_timeout_ms,
    max_retries: config.max_retries,
  }
}

function dirty(): boolean {
  const current = settingsOf()
  if (!current || !draft) return false
  return (
    draft.default_model !== current.default_model ||
    draft.request_timeout_ms !== current.request_timeout_ms ||
    draft.max_retries !== current.max_retries
  )
}

function syncPending(): void {
  setPending('settings', dirty())
}

export function resetSettingsDraft(): void {
  draft = null
  touched = false
  saveError = ''
  setPending('settings', false)
}

/**
 * 别处保存后把草稿 rebase 到最新已保存值：用户改过的字段保留，没改过的跟随。
 * 没有未保存编辑时（`touched === false`）整体刷新，保持原有行为。
 */
onSavedApplied((previous, next) => {
  if (!draft) return
  if (!touched) {
    draft = {
      default_model: next.default_model,
      request_timeout_ms: next.request_timeout_ms,
      max_retries: next.max_retries,
    }
    setPending('settings', false)
    return
  }
  const before: SettingsDraft | null = previous
    ? {
        default_model: previous.default_model,
        request_timeout_ms: previous.request_timeout_ms,
        max_retries: previous.max_retries,
      }
    : null
  draft = rebaseSettingsDraft(draft, before, {
    default_model: next.default_model,
    request_timeout_ms: next.request_timeout_ms,
    max_retries: next.max_retries,
  })
  syncPending()
})

export function renderSettings(container: HTMLElement, rerender?: () => void): void {
  const config = state.config
  if (!config) return
  if (!touched) {
    draft = settingsOf()
    setPending('settings', false)
  }
  if (!draft) return
  const current = draft
  const limits = timeoutLimits()

  /**
   * 默认模型用**下拉**而不是可输入框。
   *
   * 原来是 `<input list=datalist>`——看起来像下拉，实际是「手写 + 提示」，
   * 而且允许填不存在的别名（保存时才被拦）。别名是调用方唯一认的入口，
   * 填错就是一个运行时才暴露的坑，不如从一开始就只能选。
   *
   * `select` 里保留两类特殊项：
   * - 「（不设置）」：留空是合法配置，调用方必须显式传 model；
   * - 已停用的别名：老配置可能正指着它，直接不显示会让下拉对不上当前值，
   *   标成「已停用」并允许选中，靠下面的提示说明后果。
   */
  const options: Array<{ value: string; label: string; disabled?: boolean }> = [
    { value: '', label: '（不设置，调用方必须传 model）' },
    ...config.models.map((model) => ({
      value: model.alias,
      label: model.enabled ? model.alias : `${model.alias}（已停用）`,
    })),
  ]
  // 当前值不在列表里（别名被删了）：补一项，避免 select 静默回落到第一项
  if (current.default_model && !config.models.some((m) => m.alias === current.default_model)) {
    options.push({ value: current.default_model, label: `${current.default_model}（已不存在）` })
  }
  const defaultModel = h('select')
  for (const option of options) {
    defaultModel.append(
      h('option', { value: option.value, text: option.label, selected: option.value === current.default_model }),
    )
  }
  const defaultHint = h('span', { class: 'desc' })
  const refreshDefaultHint = () => {
    const alias = defaultModel.value.trim()
    if (!alias) {
      defaultHint.textContent = '留空允许，但调用方必须显式传模型名。'
      defaultHint.className = 'desc'
      return
    }
    const found = config.models.find((item) => item.alias === alias)
    if (!found) {
      defaultHint.textContent = '这个别名不存在，保存会被拦下。'
      defaultHint.className = 'desc danger-text'
      return
    }
    if (!found.enabled) {
      defaultHint.textContent = '这个别名已停用，调用会失败。'
      defaultHint.className = 'desc warn-text'
      return
    }
    defaultHint.textContent = '调用方不传 model 时使用。'
    defaultHint.className = 'desc'
  }

  const timeout = h('input', {
    type: 'number',
    attrs: { min: String(limits.min), max: String(limits.max), step: '1000' },
    value: current.request_timeout_ms,
  })
  const retries = h('input', {
    type: 'number',
    attrs: { min: '0', max: '2', step: '1' },
    value: current.max_retries,
  })

  const dirtyBadge = badge('未保存', 'warn')
  const save = h('button', { class: 'qb-btn qb-btn--primary', text: '保存设置', type: 'button' })
  const errorSummary = h('p', { class: 'form-error', text: saveError, attrs: { role: 'alert' } })
  mountedError = errorSummary
  const reset = h('button', { class: 'qb-btn qb-btn--ghost', text: '放弃修改', type: 'button' })

  const updateLocal = () => {
    const changed = dirty()
    dirtyBadge.style.display = changed ? '' : 'none'
    save.disabled = !changed || state.busy
    reset.disabled = !changed || state.busy
    refreshDefaultHint()
  }

  defaultModel.addEventListener('input', () => {
    current.default_model = defaultModel.value
    touched = true
    syncPending()
    updateLocal()
  })
  timeout.addEventListener('input', () => {
    current.request_timeout_ms = timeout.value.trim() ? Number(timeout.value) : 0
    touched = true
    syncPending()
    updateLocal()
  })
  retries.addEventListener('input', () => {
    current.max_retries = retries.value.trim() ? Number(retries.value) : 0
    touched = true
    syncPending()
    updateLocal()
  })

  save.addEventListener('click', async () => {
    const next = clone(current)
    const live = timeoutLimits()
    if (!Number.isFinite(next.request_timeout_ms) || next.request_timeout_ms < live.min || next.request_timeout_ms > live.max) {
      fieldError(timeout, `超时应在 ${live.min}–${live.max} 毫秒之间`)
      return
    }
    if (!Number.isInteger(next.max_retries) || next.max_retries < 0 || next.max_retries > 2) {
      fieldError(retries, '重试次数应为 0–2 的整数')
      return
    }
    if (next.default_model && !state.config?.models.some((model) => model.alias === next.default_model)) { fieldError(defaultModel, '模型别名已不存在，请重新选择'); return }
    saveError = ''
    errorSummary.textContent = ''
    for (const control of [defaultModel, timeout, retries, reset]) control.disabled = true
    save.disabled = true
    save.textContent = '保存中…'
    const ok = await updateConfig(
      (target) => {
        target.default_model = next.default_model.trim()
        target.request_timeout_ms = next.request_timeout_ms
        target.max_retries = next.max_retries
      },
      { success: '默认设置已保存' },
    )
    save.textContent = '保存设置'
    for (const control of [defaultModel, timeout, retries, reset]) control.disabled = false
    if (!ok) {
      saveError = '保存失败，修改已保留，请重试。'
      if (mountedError) mountedError.textContent = saveError
      updateLocal()
      return
    }
    touched = false
    draft = settingsOf()
    syncPending()
    rerender?.()
  })
  reset.addEventListener('click', () => {
    saveError = ''
    touched = false
    draft = settingsOf()
    syncPending()
    rerender?.()
  })

  updateLocal()

  const card = h(
    'div',
    { class: 'qb-card' },
    h(
      'div',
      { class: 'card-head' },
      h(
        'div',
        {},
        h('div', { class: 'title-with-badge' }, h('h2', { text: '默认设置' }), dirtyBadge),
        h('p', { class: 'hint', text: '调用方不传 model / timeout 时用这里的值；改完需要保存。' }),
      ),
      h('div', { class: 'actions' }, reset, save),
    ),
    h(
      'div',
      { class: 'grid grid-3' },
      h('div', {}, field('默认模型别名', defaultModel), defaultHint),
      field('默认超时（毫秒）', timeout, `${timeoutHint(limits)}；默认 ${limits.defaultMs}`),
      field('失败重试次数', retries, '0–2；只对限流、5xx、网络错误重试'),
    ),
    h(
      'p',
      {
        class: 'small subtle',
        text: `配置允许填到 ${limits.max} 毫秒，但单次调用实际压到 ${limits.callMax} 毫秒：一次 QQ 事件里所有插件合计只有 30 秒，剩下的留给调用方收尾。`,
      },
    ),
  )

  card.append(errorSummary)
  container.append(card)

  const protocols = state.meta?.protocols ?? []
  const protocolList = h('div', { class: 'issue-list' })
  for (const item of protocols) {
    protocolList.append(
      h(
        'div',
        { class: 'small muted' },
        h('span', { class: 'mono', text: item.id }),
        ' · ',
        item.label,
        ' · ',
        ...item.capabilities.map((cap) => badge(cap, '')),
      ),
    )
  }

  container.append(
    h(
      'div',
      { class: 'qb-card' },
      h('div', { class: 'card-head' }, h('div', {}, h('h2', { text: '服务信息' }), h('p', { class: 'hint', text: '其他插件通过 ctx.service("llm") 取这个服务。' }))),
      h(
        'div',
        { class: 'kv' },
        h('div', {}, h('div', { class: 'small muted', text: '插件版本' }), h('div', { class: 'value mono', text: state.meta?.plugin.version ?? '—' })),
        h('div', {}, h('div', { class: 'small muted', text: '服务名' }), h('div', { class: 'value mono', text: state.meta?.service.name ?? 'llm' })),
        h('div', {}, h('div', { class: 'small muted', text: '契约版本' }), h('div', { class: 'value mono', text: String(state.meta?.service.contractVersion ?? 1) })),
        h('div', {}, h('div', { class: 'small muted', text: '配置存储' }), h('div', { class: 'value', text: '插件 KV' })),
      ),
      h('div', { style: 'margin-top:12px' }, h('div', { class: 'small muted', text: '协议能力' }), protocolList),
      h('p', { class: 'small subtle', text: 'KV 是最终一致的：保存后其他边缘节点可能最多约一分钟才看到，和框架自己的配置快照一致。' }),
    ),
  )
}
