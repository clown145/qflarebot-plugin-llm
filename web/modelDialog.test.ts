/**
 * 模型弹窗的「思考等级」控件。
 *
 * 这组测试守的是**可配置性**：后端能算出各协议的 thinking 参数（见
 * src/protocols/thinking.test.ts），但如果页面上根本点不到，用户就用不了。
 * 所以这里断言控件真的渲染出来、选项齐全、并且能写回 ModelConfig。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockState } = vi.hoisted(() => ({
  mockState: {
    config: {
      providers: [
        { id: 'p1', name: 'P1', protocol: 'openai', base_url: 'https://a/v1', enabled: true, api_key_set: true },
      ],
      models: [{ alias: 'chat', provider: 'p1', model: 'gpt-5', enabled: true }],
      default_model: 'chat',
      request_timeout_ms: 15000,
      max_retries: 0,
      updated_at: '',
    },
    meta: { protocols: [] },
    busy: false,
  } as Record<string, unknown>,
}))

vi.mock('./api.js', () => ({ api: {}, toast: vi.fn(async () => {}) }))
vi.mock('./state.js', () => ({ state: mockState, onSavedApplied: vi.fn(), subscribe: vi.fn(), emit: vi.fn() }))
vi.mock('./modelCatalog.js', () => ({ catalogProviderFor: vi.fn(() => undefined), loadModelCatalog: vi.fn(async () => null) }))
vi.mock('./save.js', () => ({ updateConfig: vi.fn(async () => true) }))

import { openModelDialog } from './modelDialog.js'

/** jsdom 没实现 dialog.showModal */
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '')
  }
  document.body.replaceChildren()
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
  beforeEach(() => {
    // jsdom 没实现 close()
    HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
      this.removeAttribute('open')
    }
  })

  it('选了等级并保存后，写进模型的 reasoning_effort', async () => {
    const { updateConfig } = await import('./save.js')
    const mutate = vi.mocked(updateConfig)
    mutate.mockClear()

    // 必须传配置里的**同一个对象**：别名冲突检查用 `item !== existing` 判断
    // 「是不是在编辑自己」，换个新对象会被当成重复别名而提前 return
    const config = mockState.config as {
      models: Array<Record<string, unknown>>
      default_model: string
    }
    config.models = [{ alias: 'chat', provider: 'p1', model: 'gpt-5', enabled: true }]
    const existing = config.models[0]!

    openModelDialog({ model: existing as never })
    controlByLabel<HTMLSelectElement>('思考等级')!.value = 'medium'
    const save = [...document.querySelectorAll('button')].find((item) => item.textContent === '保存并应用')
    save!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(mutate).toHaveBeenCalled()
    // 拿一个和真实结构一致的 target 让回调执行，观察它写了什么
    const target = { models: [{ ...existing }], default_model: 'chat' }
    ;(mutate.mock.calls[0]![0] as unknown as (cfg: typeof target) => void)(target)
    expect(target.models[0]).toMatchObject({ reasoning_effort: 'medium' })
  })

  it('保持「不干预」时不写这个字段（不留空串污染配置）', async () => {
    const { updateConfig } = await import('./save.js')
    const mutate = vi.mocked(updateConfig)
    mutate.mockClear()

    const config = mockState.config as { models: Array<Record<string, unknown>> }
    config.models = [{ alias: 'chat', provider: 'p1', model: 'gpt-5', enabled: true }]
    const existing = config.models[0]!

    openModelDialog({ model: existing as never })
    // 不动选择器，保持默认空值
    const save = [...document.querySelectorAll('button')].find((item) => item.textContent === '保存并应用')
    save!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 0))

    const target = { models: [{ ...existing }], default_model: 'chat' }
    ;(mutate.mock.calls[0]![0] as unknown as (cfg: typeof target) => void)(target)
    expect('reasoning_effort' in (target.models[0] as object)).toBe(false)
  })
})
