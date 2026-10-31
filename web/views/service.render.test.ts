/**
 * 渲染策略回归：**保存不再整块重绘**，但保存之后仍然能继续保存、测试用的是界面当前值。
 *
 * ## 背景一：保存不该闪
 *
 * 用户反馈「每次保存就闪一下」。根因是 `saveProvider` 成功后调 `rerenderView()`，
 * `main.ts` 的 `render()` 会把整个 `.tab-content` 从 DOM 摘掉重建：输入框焦点、
 * 滚动位置、DOM 节点全部重来。所以现在保存只调局部刷新，卡片节点在保存前后是同一个。
 *
 * ## 背景二：不重建 DOM 的代价（这是本文件真正防的 bug）
 *
 * `buildProviderCard()` 里的输入事件处理器过去闭包捕获了「建卡片那一刻的 draft 对象」。
 * 保存成功后 `saveProvider()` 会把 `service.draft` 换成从 `state.config` 重新读出的
 * **新对象**，但卡片刻意不重建，于是处理器继续改那个已经废弃的旧对象：
 *
 * - 之后的字段改动落在旧对象上，`draftDirty()` 比较的是新 draft 与 base → 永远 false，
 *   保存按钮保持 disabled：**保存过一次以后再也保存不了**；
 * - 「测试」发的也是保存前的旧快照。
 *
 * 这里同时锁住三条行为：
 * 1. 保存期间 `rerender` 一次都不调用；
 * 2. 卡片节点身份不变（不闪、不丢焦点）；
 * 3. **保存后改任意字段能再次保存**，且「测试」用的是界面上的当前值。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { h } from '../dom.js'

const { mockState, testCalls } = vi.hoisted(() => ({
  mockState: {
    config: {
      providers: [
        {
          id: 'p1',
          name: 'P1',
          protocol: 'openai',
          base_url: 'https://a/v1',
          enabled: true,
          api_key_set: true,
        },
      ],
      models: [{ alias: 'chat', provider: 'p1', model: 'm', enabled: true }],
      default_model: 'chat',
      request_timeout_ms: 15000,
      max_retries: 0,
      updated_at: '',
    } as Record<string, unknown>,
    meta: { protocols: [] },
    busy: false,
    version: 1,
  },
  /** `api.test` 收到的 draft 快照；用来断言「测试」用的是界面当前值 */
  testCalls: [] as Array<Record<string, unknown>>,
}))

vi.mock('../api.js', () => ({
  api: {
    saveConfig: vi.fn(),
    test: vi.fn(async (payload: { draft?: { providers?: Array<Record<string, unknown>> } }) => {
      testCalls.push(payload as unknown as Record<string, unknown>)
      return { ok: true, result: { ok: true, latency_ms: 1 } }
    }),
    models: vi.fn(),
    getConfig: vi.fn(),
    meta: vi.fn(),
  },
  toast: vi.fn(async () => {}),
}))
vi.mock('../save.js', () => ({
  updateConfig: vi.fn(async (mutate: (config: Record<string, unknown>) => void) => {
    mutate(mockState.config as Record<string, unknown>)
    return true
  }),
  takeDroppedSecrets: vi.fn(() => []),
  configureSaving: vi.fn(),
}))
vi.mock('../state.js', () => ({ state: mockState, onSavedApplied: vi.fn(), subscribe: vi.fn(), emit: vi.fn() }))
vi.mock('../pending.js', () => ({ setPending: vi.fn() }))
vi.mock('../dialogs.js', () => ({ confirmDialog: vi.fn(async () => true), showTestResult: vi.fn() }))
vi.mock('../modelDialog.js', () => ({ openModelDialog: vi.fn() }))
vi.mock('../providerTemplateDialog.js', () => ({ pickProviderPreset: vi.fn(async () => null) }))
vi.mock('../modelCatalog.js', () => ({ catalogProviderFor: vi.fn(() => undefined), loadModelCatalog: vi.fn(async () => null) }))

import { updateConfig } from '../save.js'
import { renderService, resetServiceState } from './service.js'

/** 等一轮微任务，让 click 里的 async 处理器跑完 */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

function nameInput(root: HTMLElement): HTMLInputElement {
  return root.querySelector('input[placeholder="显示名称"]') as HTMLInputElement
}

function saveButton(root: HTMLElement): HTMLButtonElement {
  const found = [...root.querySelectorAll('button')].find((b) => b.textContent === '保存' || b.textContent === '添加供应商')
  return found as HTMLButtonElement
}

function testButton(root: HTMLElement): HTMLButtonElement {
  return [...root.querySelectorAll('button')].find((b) => b.textContent === '测试当前草稿') as HTMLButtonElement
}

describe('保存不重建 DOM', () => {
  beforeEach(() => {
    resetServiceState()
    testCalls.length = 0
    document.body.replaceChildren()
  })

  it('保存供应商后：没有触发整块重绘，卡片还是同一个节点', async () => {
    const root = h('div')
    document.body.append(root)
    const rerender = vi.fn(() => {
      throw new Error('保存不该触发整块重绘')
    })
    renderService(root, rerender)

    const cardBefore = root.querySelector('.provider-detail')
    expect(cardBefore).not.toBeNull()

    // 改个名字让保存按钮变可用，然后点保存
    const input = nameInput(root)
    input.value = 'P1-改'
    input.dispatchEvent(new Event('input'))

    const save = saveButton(root)
    expect(save.disabled).toBe(false)
    save.click()
    await flush()

    expect(rerender).not.toHaveBeenCalled()
    expect(root.querySelector('.provider-detail')?.isSameNode(cardBefore)).toBe(true)
  })
})

describe('保存后仍能继续编辑并保存（P1-9 回归）', () => {
  beforeEach(() => {
    resetServiceState()
    testCalls.length = 0
    document.body.replaceChildren()
    const provider = (mockState.config as { providers: Array<Record<string, unknown>> }).providers[0]!
    provider.name = 'P1'
  })

  it('保存一次之后再改任意字段，保存按钮重新可用，且能再次保存', async () => {
    const root = h('div')
    document.body.append(root)
    renderService(root, () => { throw new Error('不该整块重绘') })

    // 第一次改动 + 保存
    const input = nameInput(root)
    input.value = 'P1-第一次'
    input.dispatchEvent(new Event('input'))
    const save = saveButton(root)
    expect(save.disabled).toBe(false)
    save.click()
    await flush()

    // 保存后：草稿已与已保存值一致，按钮应该变灰
    expect(save.disabled).toBe(true)

    // 再改一个字段：这一步在修复前会失败——处理器写的是保存前的旧 draft 对象
    input.value = 'P1-第二次'
    input.dispatchEvent(new Event('input'))
    expect(save.disabled).toBe(false)

    const second = saveButton(root)
    second.click()
    await flush()

    // 第二次保存真的落到了 state.config 上
    const providers = (mockState.config as { providers: Array<Record<string, unknown>> }).providers
    expect(providers[0]?.['name']).toBe('P1-第二次')
  })

  it('a later provider edit survives an in-flight save', async () => {
    let finish!: () => void
    vi.mocked(updateConfig).mockImplementationOnce(async (mutate) => {
      await new Promise<void>((resolve) => { finish = resolve })
      mutate(mockState.config as never)
      return true
    })
    const root = h('div')
    document.body.append(root)
    renderService(root, vi.fn())
    const input = nameInput(root)
    input.value = 'submitted'
    input.dispatchEvent(new Event('input'))
    saveButton(root).click()
    input.value = 'typed while waiting'
    input.dispatchEvent(new Event('input'))
    finish()
    await flush()
    expect(input.value).toBe('typed while waiting')
    expect(saveButton(root).disabled).toBe(false)
    saveButton(root).click()
    await flush()
    expect((mockState.config.providers as Array<{ name: string }>)[0]?.name).toBe('typed while waiting')
  })

  it('保存后改启停开关也能再次保存（不只是文本输入框）', async () => {
    const root = h('div')
    document.body.append(root)
    renderService(root, () => { throw new Error('不该整块重绘') })

    const input = nameInput(root)
    input.value = 'P1-改'
    input.dispatchEvent(new Event('input'))
    saveButton(root).click()
    await flush()
    expect(saveButton(root).disabled).toBe(true)

    const toggle = root.querySelector('input[type="checkbox"]') as HTMLInputElement
    toggle.checked = !toggle.checked
    toggle.dispatchEvent(new Event('change'))
    expect(saveButton(root).disabled).toBe(false)
  })

  it('保存后点「测试」发送的是界面上的当前值，不是保存前的旧快照', async () => {
    const root = h('div')
    document.body.append(root)
    renderService(root, () => { throw new Error('不该整块重绘') })

    // 保存一次，让草稿对象被整体替换（旧实现就是从这一刻开始错位的）
    const input = nameInput(root)
    input.value = 'P1-保存前'
    input.dispatchEvent(new Event('input'))
    saveButton(root).click()
    await flush()

    // 保存后继续改名字但不保存，然后直接点「测试」
    input.value = 'P1-界面上的值'
    input.dispatchEvent(new Event('input'))
    testButton(root).click()
    await flush()

    const draft = testCalls.at(-1)?.['draft'] as { providers: Array<Record<string, unknown>> }
    expect(draft.providers[0]?.['name']).toBe('P1-界面上的值')
  })
})


describe('供应商连接表单', () => {
  beforeEach(() => { resetServiceState(); document.body.replaceChildren() })
  it('已有连接默认折叠，修改或验证错误不会丢掉输入', async () => {
    const root = h('div')
    document.body.append(root)
    renderService(root, vi.fn())
    const connection = root.querySelector<HTMLDetailsElement>('.connection-editor')!
    // May retain the previous user-open state; explicitly collapse to exercise error recovery.
    connection.open = false
    const input = nameInput(root)
    input.value = ''
    input.dispatchEvent(new Event('input'))
    saveButton(root).click()
    await flush()
    expect(connection.open).toBe(true)
    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(document.activeElement).toBe(input)
    expect(input.value).toBe('')
  })
  it('all connection controls and model switches have accessible names', () => {
    const root = h('div')
    document.body.append(root)
    renderService(root, vi.fn())
    for (const input of root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input, select, textarea')) {
      expect(input.getAttribute('aria-label') || input.labels?.[0]?.textContent, input.outerHTML).toBeTruthy()
    }
  })
})
