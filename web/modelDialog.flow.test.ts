import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('./api.js', () => ({ toast: vi.fn(async () => {}) }))
vi.mock('./save.js', () => ({ updateConfig: vi.fn(async () => false) }))
vi.mock('./modelCatalog.js', () => ({ catalogProviderFor: vi.fn(), loadModelCatalog: () => new Promise(() => {}) }))
import { openModelDialog } from './modelDialog.js'
import { clearPending, hasPendingEdits } from './pending.js'
import { state } from './state.js'
import { updateConfig } from './save.js'

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
function button(text: string): HTMLButtonElement {
  return [...document.querySelectorAll('button')].find((item) => item.textContent === text)!
}
function control<T extends HTMLElement>(name: string): T {
  const label = [...document.querySelectorAll('label')].find((el) => el.textContent === name)!
  return document.getElementById(label.htmlFor)! as T
}
const edit = (name: string, value: string) => {
  const input = control<HTMLInputElement>(name)
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
  return input
}

beforeEach(() => {
  document.body.replaceChildren()
  clearPending()
  vi.mocked(updateConfig).mockClear()
  state.config = {
    providers: [{ id: 'p1', name: 'P1', protocol: 'openai', base_url: 'https://example.com/v1', enabled: true, api_key_set: false }],
    models: [], default_model: '', request_timeout_ms: 15000, max_retries: 0,
  }
  HTMLDialogElement.prototype.showModal = function () { this.open = true }
  HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new Event('close')) }
})
afterEach(() => {
  document.querySelectorAll('dialog').forEach((el) => el.close())
  clearPending()
})

describe('model draft recovery', () => {
  it('tracks pending edits, confirms Esc, keeps edits when continuing, and clears pending on discard', async () => {
    openModelDialog({})
    expect(hasPendingEdits()).toBe(false)
    edit('上游模型', 'custom-model')
    expect(hasPendingEdits()).toBe(true)
    const dialog = document.querySelector('.model-dialog')!
    const cancel = new Event('cancel', { cancelable: true })
    dialog.dispatchEvent(cancel)
    expect(cancel.defaultPrevented).toBe(true)
    expect(document.activeElement?.textContent).toBe('继续编辑')
    button('继续编辑').click()
    await flush()
    expect(control<HTMLInputElement>('上游模型').value).toBe('custom-model')
    expect(hasPendingEdits()).toBe(true)
    button('取消').click()
    button('放弃修改').click()
    await flush()
    expect(document.querySelector('.model-dialog')).toBeNull()
    expect(hasPendingEdits()).toBe(false)
  })

  it('focuses the invalid field with a persistent, associated error and clears it on input', () => {
    openModelDialog({})
    button('保存并应用').click()
    const upstream = control<HTMLInputElement>('上游模型')
    expect(upstream.getAttribute('aria-invalid')).toBe('true')
    expect(document.activeElement).toBe(upstream)
    expect(document.getElementById(upstream.getAttribute('aria-describedby')!)?.textContent).toContain('请填写')
    expect(updateConfig).not.toHaveBeenCalled()
    edit('上游模型', 'fixed')
    expect(upstream.hasAttribute('aria-invalid')).toBe(false)
  })

  it('keeps values and pending state after failure and allows retry', async () => {
    openModelDialog({})
    edit('上游模型', 'custom-model')
    button('保存并应用').click()
    await flush()
    expect(control<HTMLInputElement>('上游模型').value).toBe('custom-model')
    expect(document.querySelector('.form-error')?.textContent).toContain('输入已保留')
    expect(hasPendingEdits()).toBe(true)
    button('保存并应用').click()
    await flush()
    expect(updateConfig).toHaveBeenCalledTimes(2)
  })

  it('locks fields and all close paths while saving, then clears pending on success', async () => {
    let finish!: (value: boolean) => void
    vi.mocked(updateConfig).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    openModelDialog({})
    edit('上游模型', 'custom-model')
    button('保存并应用').click()
    expect(control<HTMLInputElement>('上游模型').disabled).toBe(true)
    expect(button('取消').disabled).toBe(true)
    const dialog = document.querySelector('.model-dialog')!
    dialog.dispatchEvent(new Event('cancel', { cancelable: true }))
    expect(document.querySelectorAll('dialog')).toHaveLength(1)
    finish(true)
    await flush()
    expect(document.querySelector('.model-dialog')).toBeNull()
    expect(hasPendingEdits()).toBe(false)
  })
})
