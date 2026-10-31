/**
 * 模型弹窗：思考等级配置、校验和草稿恢复。
 *
 * 这组测试守的是**可配置性**：后端能算出各协议的 thinking 参数（见
 * src/protocols/thinking.test.ts），但如果页面上根本点不到，用户就用不了。
 * 所以这里断言控件真的渲染出来、选项齐全、并且能写回 ModelConfig。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppConfigDraft } from './types.js'

const { mockState } = vi.hoisted(() => ({
  mockState: {
    config: {} as AppConfigDraft,
    meta: { protocols: [] },
    busy: false,
  },
}))

vi.mock('./api.js', () => ({ api: {}, toast: vi.fn(async () => {}) }))
vi.mock('./state.js', () => ({ state: mockState, onSavedApplied: vi.fn(), subscribe: vi.fn(), emit: vi.fn() }))
vi.mock('./modelCatalog.js', () => ({ catalogProviderFor: vi.fn(() => undefined), loadModelCatalog: vi.fn(async () => null) }))
vi.mock('./save.js', () => ({ updateConfig: vi.fn(async () => true) }))

import { openModelDialog } from './modelDialog.js'
import { clearPending, hasPendingEdits } from './pending.js'
import { updateConfig } from './save.js'

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
const dialogDescriptors = {
  showModal: Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal'),
  close: Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close'),
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(updateConfig).mockResolvedValue(true)
  mockState.config = {
    providers: [
      { id: 'p1', name: 'P1', protocol: 'openai', base_url: 'https://a/v1', enabled: true, api_key_set: true },
    ],
    models: [{ alias: 'chat', provider: 'p1', model: 'gpt-5', enabled: true }],
    default_model: 'chat',
    request_timeout_ms: 15000,
    max_retries: 0,
  }
  mockState.busy = false
  clearPending()
  document.body.replaceChildren()
  // jsdom 没实现 dialog.showModal/close；只补本组件依赖的开关与 close 事件。
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: {
      configurable: true,
      value(this: HTMLDialogElement) { this.open = true },
    },
    close: {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.open = false
        this.dispatchEvent(new Event('close'))
      },
    },
  })
})

afterEach(() => {
  document.querySelectorAll('dialog').forEach((dialog) => dialog.close())
  document.body.replaceChildren()
  clearPending()
  for (const [name, descriptor] of Object.entries(dialogDescriptors)) {
    if (descriptor) Object.defineProperty(HTMLDialogElement.prototype, name, descriptor)
    else Reflect.deleteProperty(HTMLDialogElement.prototype, name)
  }
  vi.restoreAllMocks()
})

function labels(): string[] {
  return [...document.querySelectorAll('label')].map((item) => item.textContent ?? '')
}

/** 按 label 文本找到它 for= 指向的控件 */
function controlByLabel<T extends Element>(text: string): T | undefined {
  const label = [...document.querySelectorAll('label')].find((item) => item.textContent === text)
  const id = label?.getAttribute('for')
  return id ? (document.getElementById(id) as T | null) ?? undefined : undefined
}

function button(text: string): HTMLButtonElement {
  return [...document.querySelectorAll('button')].find((item) => item.textContent === text)!
}

function edit(name: string, value: string): void {
  const input = controlByLabel<HTMLInputElement>(name)!
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('模型弹窗的思考等级控件', () => {
  it('渲染出「思考等级」选择器，选项是四档 + 不干预', () => {
    openModelDialog({})
    expect(labels()).toContain('思考等级')
    const select = controlByLabel<HTMLSelectElement>('思考等级')
    expect(select).toBeDefined()
    expect([...select!.options].map((option) => option.value)).toEqual([
      '',
      'minimal',
      'low',
      'medium',
      'high',
    ])
    // 空选项的文案要说清「留空会发生什么」
    expect(select!.options[0]!.textContent).toContain('不干预')
  })

  it('打开已有模型时回显它配的等级', () => {
    openModelDialog({
      model: {
        alias: 'chat',
        provider: 'p1',
        model: 'gpt-5',
        enabled: true,
        reasoning_effort: 'high',
      },
    })
    const select = controlByLabel<HTMLSelectElement>('思考等级')
    expect(select!.value).toBe('high')
  })

  it('没配等级的模型默认停在「不干预」', () => {
    openModelDialog({ model: { alias: 'chat', provider: 'p1', model: 'gpt-5', enabled: true } })
    expect(controlByLabel<HTMLSelectElement>('思考等级')!.value).toBe('')
  })
})

describe('思考等级能写回配置', () => {
  it('选了等级并保存后，写进模型的 reasoning_effort', async () => {
    const mutate = vi.mocked(updateConfig)
    mutate.mockClear()

    // 必须传配置里的**同一个对象**：别名冲突检查用 `item !== existing` 判断
    // 「是不是在编辑自己」，换个新对象会被当成重复别名而提前 return
    const config = mockState.config
    config.models = [{ alias: 'chat', provider: 'p1', model: 'gpt-5', enabled: true }]
    const existing = config.models[0]!

    openModelDialog({ model: existing })
    controlByLabel<HTMLSelectElement>('思考等级')!.value = 'medium'
    const save = [...document.querySelectorAll('button')].find((item) => item.textContent === '保存并应用')
    save!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush()

    expect(mutate).toHaveBeenCalled()
    // 拿一个和真实结构一致的 target 让回调执行，观察它写了什么
    const target = structuredClone(config)
    mutate.mock.calls[0]![0](target)
    expect(target.models[0]).toMatchObject({ reasoning_effort: 'medium' })
  })

  it('保持「不干预」时不写这个字段（不留空串污染配置）', async () => {
    const mutate = vi.mocked(updateConfig)
    mutate.mockClear()

    const config = mockState.config
    config.models = [{ alias: 'chat', provider: 'p1', model: 'gpt-5', enabled: true }]
    const existing = config.models[0]!

    openModelDialog({ model: existing })
    // 不动选择器，保持默认空值
    const save = [...document.querySelectorAll('button')].find((item) => item.textContent === '保存并应用')
    save!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush()

    const target = structuredClone(config)
    mutate.mock.calls[0]![0](target)
    expect(target.models[0]).not.toHaveProperty('reasoning_effort')
  })
})

describe('模型弹窗的草稿恢复', () => {
  beforeEach(() => {
    mockState.config.models = []
    mockState.config.default_model = ''
    vi.mocked(updateConfig).mockResolvedValue(false)
  })

  it('Esc 关闭前确认，继续编辑保留内容，放弃后清除草稿', async () => {
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
    expect(controlByLabel<HTMLInputElement>('上游模型')!.value).toBe('custom-model')
    expect(hasPendingEdits()).toBe(true)
    button('取消').click()
    button('放弃修改').click()
    await flush()
    expect(document.querySelector('.model-dialog')).toBeNull()
    expect(hasPendingEdits()).toBe(false)
  })

  it('校验失败聚焦输入框并关联错误提示，继续输入后清除错误', () => {
    openModelDialog({})
    button('保存并应用').click()
    const upstream = controlByLabel<HTMLInputElement>('上游模型')!
    expect(upstream.getAttribute('aria-invalid')).toBe('true')
    expect(document.activeElement).toBe(upstream)
    expect(document.getElementById(upstream.getAttribute('aria-describedby')!)?.textContent).toContain('请填写')
    expect(updateConfig).not.toHaveBeenCalled()
    edit('上游模型', 'fixed')
    expect(upstream.hasAttribute('aria-invalid')).toBe(false)
  })

  it('保存失败保留输入与草稿状态，可以直接重试', async () => {
    openModelDialog({})
    edit('上游模型', 'custom-model')
    button('保存并应用').click()
    await flush()
    expect(controlByLabel<HTMLInputElement>('上游模型')!.value).toBe('custom-model')
    expect(document.querySelector('.form-error')?.textContent).toContain('输入已保留')
    expect(hasPendingEdits()).toBe(true)
    button('保存并应用').click()
    await flush()
    expect(updateConfig).toHaveBeenCalledTimes(2)
  })

  it('保存期间禁用输入和关闭，成功后清除草稿', async () => {
    let finish!: (value: boolean) => void
    vi.mocked(updateConfig).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    openModelDialog({})
    edit('上游模型', 'custom-model')
    button('保存并应用').click()
    expect(controlByLabel<HTMLInputElement>('上游模型')!.disabled).toBe(true)
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
