import type { PingResult } from '../src/contract.js'
import { badge, clear, h } from './dom.js'

interface Shell {
  dialog: HTMLDialogElement
  body: HTMLElement
  actions: HTMLElement
}

function shell(title: string, onClose?: () => void): Shell {
  const body = h('div')
  const actions = h('div', { class: 'dialog-actions' })
  const close = h('button', { class: 'btn ghost small', text: '关闭', type: 'button' })
  const dialog = h(
    'dialog',
    {},
    h(
      'div',
      { class: 'dialog-body' },
      h('div', { class: 'dialog-head' }, h('h2', { text: title }), close),
      body,
    ),
    actions,
  )
  close.addEventListener('click', () => dialog.close())
  dialog.addEventListener('close', () => {
    dialog.remove()
    onClose?.()
  })
  document.body.append(dialog)
  dialog.showModal()
  return { dialog, body, actions }
}

export function showTestResult(result: PingResult): void {
  const view = shell('测试结果')
  view.body.append(
    h(
      'div',
      { class: 'grid grid-3' },
      kv('状态', result.ok ? badge('成功', 'ok') : badge('失败', 'err')),
      kv('耗时', h('span', { text: `${result.latency_ms} ms` })),
      kv('供应商', h('span', { class: 'mono', text: result.provider || '—' })),
    ),
    h(
      'div',
      { class: 'grid grid-3', style: 'margin-top:12px' },
      kv('别名', h('span', { class: 'mono', text: result.alias ?? '—' })),
      kv('模型', h('span', { class: 'mono', text: result.model ?? '—' })),
      kv('Token', h('span', { text: usageText(result) })),
    ),
  )
  if (result.text) view.body.append(h('h3', { text: '返回内容', style: 'margin-top:16px' }), h('pre', { text: result.text }))
  if (result.error) view.body.append(h('div', { class: 'issue error', text: result.error, style: 'margin-top:12px' }))
  view.actions.append(h('button', { class: 'btn primary', text: '知道了', type: 'button', on: { click: () => view.dialog.close() } }))
}

function usageText(result: PingResult): string {
  const usage = result.usage
  if (!usage) return '—'
  const input = usage.input_tokens ?? '—'
  const output = usage.output_tokens ?? '—'
  return `${input} / ${output}`
}

function kv(label: string, value: HTMLElement): HTMLElement {
  return h('div', {}, h('div', { class: 'small muted', text: label }), h('div', { class: 'value' }, value))
}

export function pickModels(models: string[], existing: Set<string>): Promise<string[]> {
  return new Promise((resolve) => {
    let done = false
    let view!: Shell
    const finish = (value: string[]) => {
      if (done) return
      done = true
      resolve(value)
      view.dialog.close()
    }
    view = shell('从上游选择模型', () => finish([]))
    const search = h('input', { placeholder: '筛选模型名', type: 'search' })
    const list = h('div', { class: 'check-list' })
    const selected = new Set<string>()

    const render = () => {
      clear(list)
      const keyword = search.value.trim().toLowerCase()
      const shown = models.filter((name) => !keyword || name.toLowerCase().includes(keyword))
      if (shown.length === 0) {
        list.append(h('div', { class: 'empty', text: '没有匹配的模型' }))
        return
      }
      for (const name of shown) {
        const isExisting = existing.has(name)
        const box = h('input', { type: 'checkbox', checked: selected.has(name), disabled: isExisting })
        box.addEventListener('change', () => {
          if (box.checked) selected.add(name)
          else selected.delete(name)
        })
        list.append(h('label', {}, box, h('span', { class: 'mono', text: name }), isExisting ? badge('已添加', '') : null))
      }
    }

    search.addEventListener('input', render)
    render()
    view.body.append(
      h('p', { class: 'small muted', text: '选中的模型会以模型名作为别名添加，之后可以再改。' }),
      search,
      h('div', { style: 'height:8px' }),
      list,
    )
    const all = h('button', { class: 'btn ghost small', text: '全选', type: 'button' })
    all.addEventListener('click', () => {
      for (const name of models) if (!existing.has(name)) selected.add(name)
      render()
    })
    const none = h('button', { class: 'btn ghost small', text: '清空', type: 'button' })
    none.addEventListener('click', () => {
      selected.clear()
      render()
    })
    view.actions.append(
      all,
      none,
      h('div', { style: 'flex:1' }),
      h('button', { class: 'btn', text: '取消', type: 'button', on: { click: () => finish([]) } }),
      h('button', { class: 'btn primary', text: '添加选中', type: 'button', on: { click: () => finish([...selected]) } }),
    )
  })
}

export function confirmDialog(message: string, confirmText = '确定'): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false
    let view!: Shell
    const finish = (value: boolean) => {
      if (done) return
      done = true
      resolve(value)
      view.dialog.close()
    }
    view = shell('确认', () => finish(false))
    view.body.append(h('p', { text: message }))
    view.actions.append(
      h('button', { class: 'btn', text: '取消', type: 'button', on: { click: () => finish(false) } }),
      h('button', { class: 'btn danger', text: confirmText, type: 'button', on: { click: () => finish(true) } }),
    )
  })
}
