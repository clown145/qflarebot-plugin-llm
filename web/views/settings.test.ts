import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderSettings, resetSettingsDraft } from './settings.js'
import { state } from '../state.js'
import { updateConfig } from '../save.js'
import { clearPending } from '../pending.js'

vi.mock('../save.js', () => ({ updateConfig: vi.fn(async () => false) }))

beforeEach(() => {
  vi.mocked(updateConfig).mockReset().mockResolvedValue(false)
  document.body.replaceChildren()
  clearPending()
  resetSettingsDraft()
  state.config = {
    providers: [],
    models: [],
    default_model: '',
    request_timeout_ms: 15000,
    max_retries: 0,
  }
  state.saved = structuredClone(state.config)
  state.busy = false
})

afterEach(() => {
  resetSettingsDraft()
  clearPending()
  document.body.replaceChildren()
})

describe('默认设置的保存', () => {
  it('保存失败后即使页面重绘，输入和错误提示仍保留，允许再次保存', async () => {
    const root = document.createElement('div')
    document.body.append(root)
    const render = () => {
      root.replaceChildren()
      renderSettings(root, render)
    }
    render()

    const timeout = root.querySelector<HTMLInputElement>('input[type="number"]')!
    timeout.value = '20000'
    timeout.dispatchEvent(new Event('input'))
    vi.mocked(updateConfig).mockImplementationOnce(async () => {
      render()
      return false
    })
    const save = [...root.querySelectorAll('button')].find((el) => el.textContent === '保存设置')!
    save.click()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(root.querySelector('.form-error')?.textContent).toContain('修改已保留')
    expect(root.querySelector<HTMLInputElement>('input[type="number"]')?.value).toBe('20000')
    expect([...root.querySelectorAll('button')].find((el) => el.textContent === '保存设置')?.disabled).toBe(false)
  })
})
