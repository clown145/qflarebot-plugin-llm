/**
 * 渲染策略回归：**保存不再整块重绘**。
 *
 * 用户反馈「每次保存就闪一下」。根因是 `saveProvider` 成功后调 `rerenderView()`，
 * `main.ts` 的 `render()` 会把整个 `.tab-content` 从 DOM 摘掉重建：输入框焦点、
 * 滚动位置、DOM 节点全部重来。
 *
 * 现在保存只调局部刷新。这里用两条断言守住：
 * 1. 保存期间 `rerender` 回调**一次都不该被调用**；
 * 2. 供应商卡片节点在保存前后是**同一个节点**（没被 replaceWith 换掉）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { h } from '../dom.js'

const { mockState } = vi.hoisted(() => ({
  mockState: {
    config: {
      providers: [{ id: 'p1', name: 'P1', protocol: 'openai', base_url: 'https://a/v1', enabled: true, api_key_set: true }],
      models: [{ alias: 'chat', provider: 'p1', model: 'm', enabled: true }],
      default_model: 'chat',
      request_timeout_ms: 15000,
      max_retries: 0,
      updated_at: '',
    },
    meta: { protocols: [] },
    busy: false,
    version: 1,
  } as Record<string, unknown>,
}))

vi.mock('../api.js', () => ({
  api: { saveConfig: vi.fn(), test: vi.fn(), models: vi.fn(), getConfig: vi.fn(), meta: vi.fn() },
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

import { renderService, resetServiceState } from './service.js'

/** 等一轮微任务，让 click 里的 async 处理器跑完 */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('保存不重建 DOM', () => {
  beforeEach(() => {
    resetServiceState()
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
    const nameInput = root.querySelector('input[placeholder="显示名称"]') as HTMLInputElement
    nameInput.value = 'P1-改'
    nameInput.dispatchEvent(new Event('input'))

    const saveButton = [...root.querySelectorAll('button')].find((b) => b.textContent === '保存') as HTMLButtonElement
    expect(saveButton).toBeTruthy()
    saveButton.click()
    await flush()

    expect(rerender).not.toHaveBeenCalled()
    expect(root.querySelector('.provider-detail')?.isSameNode(cardBefore)).toBe(true)
  })
})
