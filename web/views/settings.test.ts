import { beforeEach, expect, it, vi } from 'vitest'
vi.mock('../save.js', () => ({ updateConfig: vi.fn(async () => false) }))
import { renderSettings, resetSettingsDraft } from './settings.js'
import { state } from '../state.js'
import { updateConfig } from '../save.js'

beforeEach(() => {
  document.body.replaceChildren()
  resetSettingsDraft()
  state.config = { providers: [], models: [], default_model: '', request_timeout_ms: 15000, max_retries: 0 }
  state.saved = structuredClone(state.config)
  state.busy = false
})

it('keeps a server failure visible after the save infrastructure rerenders the page', async () => {
  const root = document.createElement('div')
  document.body.append(root)
  const render = () => { root.replaceChildren(); renderSettings(root, render) }
  render()
  const timeout = root.querySelector<HTMLInputElement>('input[type="number"]')!
  timeout.value = '20000'
  timeout.dispatchEvent(new Event('input'))
  vi.mocked(updateConfig).mockImplementationOnce(async () => { render(); return false })
  ;[...root.querySelectorAll('button')].find((el) => el.textContent === '保存设置')!.click()
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(root.querySelector('.form-error')?.textContent).toContain('修改已保留')
  expect(root.querySelector<HTMLInputElement>('input[type="number"]')?.value).toBe('20000')
  expect([...root.querySelectorAll('button')].find((el) => el.textContent === '保存设置')?.disabled).toBe(false)
})
