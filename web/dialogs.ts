import type { PingResult } from '../src/contract.js'
import { badge, h } from './dom.js'

export interface DialogShell {
  dialog: HTMLDialogElement
  body: HTMLElement
  actions: HTMLElement
}

export function dialogShell(title: string, onClose?: () => void, className = ''): DialogShell {
  const body = h('div')
  const actions = h('div', { class: 'dialog-actions' })
  const close = h('button', { class: 'qb-btn qb-btn--ghost qb-btn--sm', text: '关闭', type: 'button' })
  const dialog = h(
    'dialog',
    { class: className, aria: { label: title } },
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

export function showTestResult(result: PingResult, context?: { source: string; baseUrl?: string }): void {
  const view = dialogShell('测试结果')
  if (context) view.body.append(h('p', { class: 'hint', text: `配置来源：${context.source}` }),
    h('p', { class: 'small mono test-address', text: `接口地址：${context.baseUrl || '—'}` }))
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
  view.actions.append(h('button', { class: 'qb-btn qb-btn--primary', text: '知道了', type: 'button', on: { click: () => view.dialog.close() } }))
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

export function confirmDialog(message: string, confirmText = '确定', cancelText = '取消'): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false
    let view!: DialogShell
    const finish = (value: boolean) => {
      if (done) return
      done = true
      resolve(value)
      view.dialog.close()
    }
    view = dialogShell('确认', () => finish(false))
    view.body.append(h('p', { text: message }))
    const cancel = h('button', { class: 'qb-btn', text: cancelText, type: 'button', on: { click: () => finish(false) } })
    view.actions.append(
      cancel,
      h('button', { class: 'qb-btn qb-btn--danger', text: confirmText, type: 'button', on: { click: () => finish(true) } }),
    )
    cancel.focus()
  })
}
