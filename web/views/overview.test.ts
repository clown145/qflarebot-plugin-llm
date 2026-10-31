import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderOverview } from './overview.js'
import { state } from '../state.js'
import { api } from '../api.js'
import { showTestResult } from '../dialogs.js'

vi.mock('../api.js', () => ({
  api: { test: vi.fn(async () => ({ result: { provider: 'p', ok: true, latency_ms: 1 } })) },
  toast: vi.fn(),
}))
vi.mock('../dialogs.js', () => ({ showTestResult: vi.fn() }))

beforeEach(() => {
  vi.clearAllMocks()
  document.body.replaceChildren()
  state.saved = {
    providers: [
      { id: 'p', name: 'Saved', protocol: 'openai', base_url: 'https://saved.example/v1', enabled: true, api_key_set: false },
    ],
    models: [],
    default_model: '',
    request_timeout_ms: 15000,
    max_retries: 0,
  }
  state.config = structuredClone(state.saved)
  state.busy = false
  state.issues = []
})

afterEach(() => {
  document.body.replaceChildren()
})

describe('概览页快速测试', () => {
  it('请求使用已保存配置，结果标明配置来源与接口地址', async () => {
    state.config!.providers[0]!.base_url = 'https://draft.example/v1'
    const root = document.createElement('div')
    document.body.append(root)
    renderOverview(root, vi.fn())

    const test = [...root.querySelectorAll('button')].find((el) => el.textContent === '测试已保存配置')!
    test.click()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(vi.mocked(api.test).mock.calls[0]?.[0].draft?.providers?.[0]?.base_url).toBe('https://saved.example/v1')
    expect(showTestResult).toHaveBeenCalledWith(expect.anything(), {
      source: '已保存配置',
      baseUrl: 'https://saved.example/v1',
    })
  })
})
