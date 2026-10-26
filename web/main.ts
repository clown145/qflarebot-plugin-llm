import { ApiError, api, resizePage, setPageTitle, toast } from './api.js'
import { confirmDialog } from './dialogs.js'
import { clear, download, h } from './dom.js'
import { applySaved, emit, isDirty, setBusy, setLoaded, setMeta, state, subscribe } from './state.js'
import type { Tab } from './types.js'
import { normalizeDraft, toExport, toInput } from './types.js'
import { renderModels } from './views/models.js'
import { renderOverview } from './views/overview.js'
import { renderProviders } from './views/providers.js'
import { renderSettings } from './views/settings.js'
import { renderUsage } from './views/usage.js'

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'overview', label: '概览' },
  { id: 'providers', label: '供应商' },
  { id: 'models', label: '模型' },
  { id: 'settings', label: '设置' },
  { id: 'usage', label: '用法' },
]

function goTab(tab: Tab): void {
  state.activeTab = tab
  render()
}

function updateHeader(): void {
  const dirty = isDirty()
  const dirtyEl = document.getElementById('dirty')
  if (dirtyEl) {
    dirtyEl.textContent = dirty ? '未保存' : '已保存'
    dirtyEl.className = `badge ${dirty ? 'warn' : 'ok'}`
  }
  const save = document.getElementById('save-btn') as HTMLButtonElement | null
  if (save) {
    save.disabled = !dirty || state.busy
    save.textContent = state.busy ? '保存中…' : '保存'
  }
  const refresh = document.getElementById('refresh-btn') as HTMLButtonElement | null
  if (refresh) refresh.disabled = state.busy
}

function header(): HTMLElement {
  const save = h('button', { class: 'btn primary', text: '保存', type: 'button', attrs: { id: 'save-btn' } })
  save.addEventListener('click', () => void saveConfig())
  const refresh = h('button', { class: 'btn ghost', text: '刷新', type: 'button', attrs: { id: 'refresh-btn' } })
  refresh.addEventListener('click', () => void reload())
  const importButton = h('button', { class: 'btn', text: '导入', type: 'button' })
  importButton.addEventListener('click', () => void importConfig())
  const exportButton = h('button', { class: 'btn', text: '导出', type: 'button' })
  exportButton.addEventListener('click', () => exportConfig())

  return h(
    'div',
    { class: 'page-head' },
    h(
      'div',
      {},
      h('h1', { text: 'LLM 接口' }),
      h('p', { class: 'subtitle', text: '配置供应商与模型别名，向其他插件提供 llm 服务；这里不聊天，也不执行工具。' }),
    ),
    h(
      'div',
      { class: 'actions' },
      h('span', { class: 'badge ok', text: '已保存', attrs: { id: 'dirty' } }),
      save,
      refresh,
      importButton,
      exportButton,
    ),
  )
}

function tabs(): HTMLElement {
  const nav = h('nav', { class: 'tabs' })
  for (const tab of TABS) {
    const button = h('button', {
      class: `tab${state.activeTab === tab.id ? ' active' : ''}`,
      text: tab.label,
      type: 'button',
    })
    button.addEventListener('click', () => goTab(tab.id))
    nav.append(button)
  }
  return nav
}

function issuesBanner(): HTMLElement | null {
  const errors = state.issues.filter((item) => item.level === 'error')
  if (errors.length === 0) return null
  const card = h('div', { class: 'card', style: 'border-color:var(--qb-danger)' })
  card.append(h('h3', { text: `有 ${errors.length} 个配置错误，保存会被拦下` }))
  for (const item of errors.slice(0, 3)) {
    card.append(
      h(
        'div',
        { class: 'issue error', style: 'margin-top:8px' },
        item.path ? h('span', { class: 'mono small', text: `${item.path}：` }) : null,
        item.message,
      ),
    )
  }
  card.append(h('button', { class: 'btn small', text: '去概览看全部', type: 'button', on: { click: () => goTab('overview') } }))
  return card
}

function render(): void {
  const app = document.getElementById('app')
  if (!app) return
  if (!state.config) {
    clear(app)
    app.append(h('div', { class: 'fatal', text: '还没有加载到配置' }))
    return
  }
  clear(app)
  app.append(header(), tabs())
  const banner = issuesBanner()
  if (banner) app.append(banner)
  const main = h('div')
  app.append(main)

  if (state.activeTab === 'overview') renderOverview(main, goTab)
  else if (state.activeTab === 'providers') renderProviders(main, render)
  else if (state.activeTab === 'models') renderModels(main, render)
  else if (state.activeTab === 'settings') renderSettings(main)
  else renderUsage(main)

  updateHeader()
  void resizePage()
}

async function saveConfig(): Promise<void> {
  if (!state.config || state.busy) return
  setBusy(true)
  try {
    const data = await api.saveConfig({ version: state.version, config: toInput(state.config) })
    applySaved(data)
    render()
    await toast('已保存', 'success')
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) {
      const ok = await confirmDialog('配置已经被别处修改，重新加载会丢弃当前未保存的修改。', '重新加载')
      if (ok) await load()
    } else if (err instanceof ApiError && err.payload && typeof err.payload === 'object' && 'errors' in err.payload) {
      const errors = (err.payload as { errors?: typeof state.issues }).errors
      if (errors) state.issues = errors
      render()
      await toast('配置有误，请按提示修改', 'error')
    } else {
      await toast(err instanceof Error ? err.message : String(err), 'error')
    }
  } finally {
    setBusy(false)
    updateHeader()
  }
}

async function load(): Promise<void> {
  const app = document.getElementById('app')
  if (app) {
    clear(app)
    app.append(h('div', { class: 'fatal', text: '加载中…' }))
  }
  try {
    const meta = await api.meta()
    setMeta(meta)
    const data = await api.getConfig()
    setLoaded(data)
    render()
  } catch (err) {
    if (app) {
      clear(app)
      app.append(
        h(
          'div',
          { class: 'fatal' },
          h('h2', { text: '加载失败' }),
          h('p', { class: 'muted', text: err instanceof Error ? err.message : String(err), style: 'margin-top:8px' }),
          h('button', { class: 'btn', text: '重试', type: 'button', on: { click: () => void load() } }),
        ),
      )
    }
  }
}

async function reload(): Promise<void> {
  if (isDirty()) {
    const ok = await confirmDialog('刷新会丢弃当前未保存的修改。', '刷新')
    if (!ok) return
  }
  await load()
}

async function importConfig(): Promise<void> {
  const input = h('input', { type: 'file', attrs: { accept: 'application/json,.json' }, style: 'display:none' })
  document.body.append(input)
  input.addEventListener('change', async () => {
    const file = input.files?.[0]
    input.remove()
    if (!file) return
    try {
      const draft = normalizeDraft(JSON.parse(await file.text()))
      if (isDirty()) {
        const ok = await confirmDialog('导入会覆盖当前未保存的修改。', '导入')
        if (!ok) return
      }
      state.config = draft
      state.issues = []
      state.corrupt = false
      emit()
      render()
      await toast('已导入，检查后点保存', 'success')
    } catch (err) {
      await toast(`导入失败：${err instanceof Error ? err.message : String(err)}`, 'error')
    }
  })
  input.click()
}

function exportConfig(): void {
  if (!state.config) return
  const data = toExport(state.config, state.version, state.updatedAt)
  download('llm-config.json', `${JSON.stringify(data, null, 2)}\n`)
  void toast('已导出（不含 API Key）', 'success')
}

function installGuards(): void {
  window.addEventListener('beforeunload', (event) => {
    if (!isDirty()) return
    event.preventDefault()
    event.returnValue = ''
  })
  subscribe(updateHeader)
}

async function boot(): Promise<void> {
  installGuards()
  const initial = new URLSearchParams(location.search).get('tab')
  if (initial && TABS.some((item) => item.id === initial)) state.activeTab = initial as Tab
  await setPageTitle('LLM 接口')
  await load()
}

void boot()
