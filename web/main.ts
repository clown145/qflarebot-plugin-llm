import { api, resizePage, setPageTitle, toast } from './api.js'
import { confirmDialog } from './dialogs.js'
import { clear, download, h } from './dom.js'
import { clearPending, hasPendingEdits } from './pending.js'
import { configureSaving, updateConfig } from './save.js'
import { setLoaded, setMeta, state, subscribe } from './state.js'
import type { AppConfigDraft, Tab } from './types.js'
import { clone, normalizeDraft, reconcileKeyState, toExport } from './types.js'
import { renderOverview } from './views/overview.js'
import { renderService, resetServiceState } from './views/service.js'
import { renderSettings, resetSettingsDraft } from './views/settings.js'
import { renderUsage } from './views/usage.js'

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'overview', label: '概览' },
  { id: 'service', label: '模型服务' },
  { id: 'settings', label: '设置' },
  { id: 'usage', label: '用法' },
]

function goTab(tab: Tab): void {
  state.activeTab = tab
  try {
    const url = new URL(location.href)
    url.searchParams.set('tab', tab)
    history.replaceState(null, '', url.toString())
  } catch {
    // 沙箱里不允许改地址时忽略，页面内切换仍然有效
  }
  render()
}

function updateHeader(): void {
  const pending = hasPendingEdits()
  const dirtyEl = document.getElementById('dirty')
  if (dirtyEl) {
    dirtyEl.textContent = pending ? '有未保存修改' : '已保存'
    dirtyEl.className = `badge ${pending ? 'warn' : 'ok'}`
  }
  const refresh = document.getElementById('refresh-btn') as HTMLButtonElement | null
  if (refresh) refresh.disabled = state.busy
  const importButton = document.getElementById('import-btn') as HTMLButtonElement | null
  if (importButton) importButton.disabled = state.busy
  const exportButton = document.getElementById('export-btn') as HTMLButtonElement | null
  if (exportButton) exportButton.disabled = state.busy
}

function header(): HTMLElement {
  const refresh = h('button', { class: 'qb-btn qb-btn--ghost', text: '刷新', type: 'button', attrs: { id: 'refresh-btn' } })
  refresh.addEventListener('click', () => void reload())
  const importButton = h('button', { class: 'qb-btn', text: '导入', type: 'button', attrs: { id: 'import-btn' } })
  importButton.addEventListener('click', () => void importConfig())
  const exportButton = h('button', { class: 'qb-btn', text: '导出', type: 'button', attrs: { id: 'export-btn' } })
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
      h('span', {
        class: 'badge ok',
        text: '已保存',
        attrs: { id: 'dirty', title: '模型改动会立即保存；供应商和默认设置需要点页面里的保存' },
      }),
      refresh,
      importButton,
      exportButton,
    ),
  )
}

/**
 * 页内标签。对标 `QSegmented`（`packages/ui/src/components/ui/QSegmented.vue`）。
 *
 * ## 规范原文（MASTER.md「动效」表）
 *
 * > 页内标签：选中块滑过去；内容旧的淡出、新的淡入并上浮 6px
 *
 * 所以这里**不是**给当前 tab 改个背景色 —— 而是一个绝对定位的
 * 「指示块」用 `translateX` + `width` 滑到选中项下面。两种做法看起来
 * 都是「选中项有底色」，但滑动版有连续的位移感，直接改背景是硬切。
 *
 * ## 三个容易漏的细节（都照 QSegmented）
 *
 * 1. **首次渲染不要动画**：`animate` 标志在 `requestAnimationFrame` 之后
 *    才置真。否则页面刚打开时指示块会从 `translateX(0)` 滑到第一个 tab，
 *    看着像刚加载出来就抖一下。
 * 2. **尺寸变了要重新量**：字体加载完、窗口缩放都会让 tab 宽度变化，
 *    用 `ResizeObserver` 跟着重量，不然指示块和文字会错位。
 * 3. **方向键切换**：`role="tablist"` 下左右方向键是约定，漏了键盘用户
 *    只能用 Tab 键一个个挪。
 */
let tabIndicator: HTMLElement | null = null
let tabAnimate = false
let tabObserver: ResizeObserver | null = null

function measureTabIndicator(): void {
  const root = tabIndicator?.parentElement
  if (!root || !tabIndicator) return
  const selected = root.querySelector<HTMLElement>('[aria-selected="true"]')
  if (!selected) {
    tabIndicator.style.opacity = '0'
    return
  }
  tabIndicator.style.opacity = '1'
  // offsetLeft/offsetWidth 相对定位父级，正是指示块要的位置
  tabIndicator.style.width = `${selected.offsetWidth}px`
  tabIndicator.style.transform = `translateX(${selected.offsetLeft}px)`
}

function tabs(): HTMLElement {
  const wrappers = h('nav', { class: 'tabs' })
  // 指示块和 tab 按钮同处一个定位容器，才能用同一个坐标系
  const root = h('div', { class: 'tabs-inner', attrs: { role: 'tablist', 'aria-label': '页面分区' } })
  wrappers.append(root)

  const indicator = h('span', {
    class: 'tab-indicator',
    attrs: { 'aria-hidden': 'true' },
  })
  tabIndicator = indicator
  root.append(indicator)

  for (const tab of TABS) {
    const active = state.activeTab === tab.id
    const button = h('button', {
      class: `tab${active ? ' active' : ''}`,
      text: tab.label,
      type: 'button',
      attrs: {
        role: 'tab',
        'aria-selected': String(active),
        // 只有选中的那个进 Tab 序列，其余靠方向键 —— WAI-ARIA 的标准做法
        tabindex: active ? '0' : '-1',
      },
    })
    button.addEventListener('click', () => goTab(tab.id))
    root.append(button)
  }

  // 方向键左右切换
  root.addEventListener('keydown', (event) => {
    const key = (event as KeyboardEvent).key
    if (key !== 'ArrowLeft' && key !== 'ArrowRight') return
    event.preventDefault()
    const index = TABS.findIndex((item) => item.id === state.activeTab)
    const step = key === 'ArrowRight' ? 1 : -1
    const next = TABS[(index + step + TABS.length) % TABS.length]
    if (!next) return
    goTab(next.id)
    // 焦点跟到新选中的 tab 上，键盘用户不会丢位置
    const target = root.querySelector<HTMLElement>(`[role="tab"]:nth-of-type(${
      TABS.findIndex((item) => item.id === next.id) + 1
    })`)
    target?.focus()
  })

  // 量一次；下一帧再开动画（避免首次渲染时滑动）
  measureTabIndicator()
  requestAnimationFrame(() => {
    tabAnimate = true
    indicator.classList.add('animate')
  })

  // 尺寸变化（字体加载、窗口缩放）时重量
  if (typeof ResizeObserver !== 'undefined') {
    tabObserver?.disconnect()
    tabObserver = new ResizeObserver(() => measureTabIndicator())
    tabObserver.observe(root)
  }

  return wrappers
}

function issuesBanner(): HTMLElement | null {
  const errors = state.issues.filter((item) => item.level === 'error')
  if (errors.length === 0) return null
  const card = h('div', { class: 'qb-card', style: 'border-color:var(--qb-danger)' })
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
  card.append(h('button', { class: 'qb-btn qb-btn--sm', text: '去概览看全部', type: 'button', on: { click: () => goTab('overview') } }))
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
  // 内容区包一层：切换时给它一个入场动画（规范：旧的淡出、新的淡入并上浮 6px）。
  //
  // 为什么只做「新内容入场」不做「旧内容离场」：旧内容是在 `clear(app)` 里
  // 整个移除的，要让它淡出得先挂住 DOM 等动画跑完 —— 那会让点击到内容
  // 出现之间多出 160ms 空档，反而更卡。而**只做入场**是纯视觉收益，
  // 用户感知到的是「新内容浮上来」，切换依然是即时的。
  const main = h('div', { class: 'tab-content' })
  app.append(main)

  if (state.activeTab === 'overview') renderOverview(main, goTab)
  else if (state.activeTab === 'service') renderService(main, render)
  else if (state.activeTab === 'settings') renderSettings(main, render)
  else renderUsage(main)

  // 用完即删：不加这个的话 `.tab-content` 上的动画类会一直留着，
  // 之后任何一次重渲染都会再放一遍动画
  requestAnimationFrame(() => main.classList.add('tab-content--in'))

  updateHeader()
  void resizePage()
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
    clearPending()
    resetServiceState()
    resetSettingsDraft()
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
          h('button', { class: 'qb-btn', text: '重试', type: 'button', on: { click: () => void load() } }),
        ),
      )
    }
  }
}

async function reload(): Promise<void> {
  if (hasPendingEdits()) {
    const ok = await confirmDialog('刷新会丢弃页面上未保存的供应商 / 设置修改。', '刷新')
    if (!ok) return
  }
  await load()
}

function importConfig(): void {
  const input = h('input', { type: 'file', attrs: { accept: 'application/json,.json' }, style: 'display:none' })
  document.body.append(input)
  // 用户取消文件选择时 change 不触发，input 会永久残留在 DOM；窗口关闭/失焦时兜底清理
  const cleanup = () => input.remove()
  window.addEventListener('focus', cleanup, { once: true })
  input.addEventListener('change', async () => {
    window.removeEventListener('focus', cleanup)
    const file = input.files?.[0]
    input.remove()
    if (!file) return
    let imported: AppConfigDraft
    let dropped: string[]
    try {
      const normalized = normalizeDraft(JSON.parse(await file.text()))
      const reconciled = reconcileKeyState(normalized, state.saved)
      imported = reconciled.draft
      dropped = reconciled.dropped
    } catch (err) {
      await toast(`导入失败：${err instanceof Error ? err.message : String(err)}`, 'error')
      return
    }
    if (hasPendingEdits()) {
      const ok = await confirmDialog('导入会覆盖配置，并丢弃页面上未保存的供应商 / 设置修改。', '导入')
      if (!ok) return
    }
    if (dropped.length) {
      // 这些供应商的地址/协议和本机不一致，本机已存的 Key 不会被继承（也不会被沿用），
      // 导入后必须重新填写；不提示的话页面会显示「未设置 Key」而用户不知道为什么。
      const preview = dropped.slice(0, 5).join('、')
      const more = dropped.length > 5 ? ` 等 ${dropped.length} 个` : ''
      const ok = await confirmDialog(
        `这些供应商的接口地址或协议和本机配置不一致，API Key 需要重新填写：${preview}${more}。继续导入吗？`,
        '继续导入',
      )
      if (!ok) return
    }
    const ok = await updateConfig(
      (target) => {
        target.providers = imported.providers.map((provider) => clone(provider))
        target.models = imported.models.map((model) => clone(model))
        target.default_model = imported.default_model
        target.request_timeout_ms = imported.request_timeout_ms
        target.max_retries = imported.max_retries
      },
      { success: '已导入配置' },
    )
    if (!ok) return
    clearPending()
    resetServiceState()
    resetSettingsDraft()
    render()
  })
  input.click()
}

function exportConfig(): void {
  if (!state.config) return
  const data = toExport(state.config, state.version, state.updatedAt)
  download('llm-config.json', `${JSON.stringify(data, null, 2)}\n`)
  const omitted = new Set(data.providers.flatMap((provider) => provider.headers_omitted ?? []))
  const omittedNote = omitted.size ? `；${[...omitted].slice(0, 5).join('、')} 等 ${omitted.size} 个自定义请求头已剔除` : ''
  if (hasPendingEdits()) {
    void toast(`已导出已保存的配置；未保存的供应商 / 设置修改不在文件里${omittedNote}`, 'warning')
  } else {
    void toast(`已导出（不含 API Key 和敏感请求头${omittedNote}）`, 'success')
  }
}

function installGuards(): void {
  window.addEventListener('beforeunload', (event) => {
    if (!hasPendingEdits()) return
    event.preventDefault()
    event.returnValue = ''
  })
  subscribe(updateHeader)
}

async function boot(): Promise<void> {
  installGuards()
  configureSaving({ reload: load, rerender: render })
  const initial = new URLSearchParams(location.search).get('tab')
  const legacy = initial === 'providers' || initial === 'models' ? 'service' : initial
  if (legacy && TABS.some((item) => item.id === legacy)) state.activeTab = legacy as Tab
  await setPageTitle('LLM 接口')
  await load()
}

void boot()
