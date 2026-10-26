import { api, toast } from '../api.js'
import { confirmDialog, showTestResult } from '../dialogs.js'
import { h } from '../dom.js'
import { emit, state } from '../state.js'
import { toInput } from '../types.js'

function uniqueAlias(base: string): string {
  const used = new Set((state.config?.models ?? []).map((item) => item.alias))
  if (!used.has(base)) return base
  for (let i = 2; ; i += 1) {
    const next = `${base}-${i}`
    if (!used.has(next)) return next
  }
}

function addModel(rerender: () => void): void {
  if (!state.config) return
  const provider = state.config.providers[0]
  if (!provider) {
    void toast('先添加一个供应商', 'warning')
    return
  }
  state.config.models.push({ alias: uniqueAlias('model'), provider: provider.id, model: '', enabled: true })
  rerender()
}

function providerSelect(value: string): HTMLSelectElement {
  const select = h('select')
  const providers = state.config?.providers ?? []
  if (!providers.some((item) => item.id === value) && value) {
    select.append(h('option', { value, text: `${value}（不存在）`, selected: true }))
  }
  for (const provider of providers) {
    select.append(h('option', { value: provider.id, text: provider.name || provider.id, selected: provider.id === value }))
  }
  return select
}

function numberInput(value: number | undefined, min: number, max: number, step: string, placeholder: string): HTMLInputElement {
  return h('input', {
    type: 'number',
    attrs: { min: String(min), max: String(max), step },
    value: value ?? '',
    placeholder,
  })
}

export function renderModels(container: HTMLElement, rerender: () => void): void {
  const config = state.config
  if (!config) return

  const head = h('div', { class: 'card-head' }, h('div', {}, h('h2', { text: '模型别名' }), h('p', { class: 'hint', text: '调用方只认别名。换供应商、换上游模型只改这里，不用改调用方代码。' })))
  head.append(h('button', { class: 'btn primary', text: '添加模型', type: 'button', on: { click: () => addModel(rerender) } }))
  container.append(head)

  if (config.models.length === 0) {
    container.append(h('div', { class: 'empty', text: '还没有模型别名。添加一个，再把它设成默认模型。' }))
    return
  }

  const tbody = h('tbody')
  config.models.forEach((model, index) => {
    const alias = h('input', { value: model.alias, placeholder: 'chat' })
    alias.addEventListener('input', () => {
      model.alias = alias.value
      emit()
    })

    const provider = providerSelect(model.provider)
    provider.addEventListener('change', () => {
      model.provider = provider.value
      emit()
    })

    const upstream = h('input', { value: model.model, placeholder: 'deepseek-chat' })
    upstream.addEventListener('input', () => {
      model.model = upstream.value
      emit()
    })

    const maxTokens = numberInput(model.max_tokens, 1, 131072, '1', '默认')
    maxTokens.addEventListener('input', () => {
      model.max_tokens = maxTokens.value ? Number(maxTokens.value) : undefined
      emit()
    })

    const temperature = numberInput(model.temperature, 0, 2, '0.1', '默认')
    temperature.addEventListener('input', () => {
      model.temperature = temperature.value ? Number(temperature.value) : undefined
      emit()
    })

    const enabled = h('input', { type: 'checkbox', checked: model.enabled })
    enabled.addEventListener('change', () => {
      model.enabled = enabled.checked
      emit()
    })

    const test = h('button', { class: 'btn small', text: '测试', type: 'button' })
    test.addEventListener('click', async () => {
      if (!state.config) return
      if (!model.alias.trim()) {
        await toast('先填模型别名', 'warning')
        return
      }
      test.disabled = true
      test.textContent = '测试中…'
      try {
        const data = await api.test({ target: { alias: model.alias }, draft: toInput(state.config) })
        showTestResult(data.result)
      } catch (err) {
        await toast(err instanceof Error ? err.message : String(err), 'error')
      } finally {
        test.disabled = false
        test.textContent = '测试'
      }
    })

    const remove = h('button', { class: 'btn small danger', text: '删除', type: 'button' })
    remove.addEventListener('click', async () => {
      if (!state.config) return
      const ok = await confirmDialog(`删除模型别名「${model.alias || '未命名'}」？`, '删除')
      if (!ok || !state.config) return
      state.config.models.splice(index, 1)
      rerender()
    })

    tbody.append(
      h(
        'tr',
        {},
        h('td', {}, alias),
        h('td', {}, provider),
        h('td', {}, upstream),
        h('td', {}, maxTokens),
        h('td', {}, temperature),
        h('td', {}, enabled),
        h('td', {}, h('div', { class: 'row-actions' }, test, remove)),
      ),
    )
  })

  const table = h(
    'table',
    {},
    h(
      'thead',
      {},
      h(
        'tr',
        {},
        h('th', { text: '别名' }),
        h('th', { text: '供应商' }),
        h('th', { text: '上游模型' }),
        h('th', { text: 'max_tokens' }),
        h('th', { text: '温度' }),
        h('th', { text: '启用' }),
        h('th', { text: '操作', style: 'text-align:right' }),
      ),
    ),
    tbody,
  )
  container.append(h('div', { class: 'table-wrap' }, table))
}
