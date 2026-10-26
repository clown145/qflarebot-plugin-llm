import { api, toast } from '../api.js'
import { state } from '../state.js'
import type { Tab } from '../types.js'
import { toInput } from '../types.js'
import { formatTime, h } from '../dom.js'
import { showTestResult } from '../dialogs.js'

function stat(label: string, value: string): HTMLElement {
  return h('div', {}, h('div', { class: 'small muted', text: label }), h('div', { class: 'value mono', text: value }))
}

function testOptions(): HTMLSelectElement {
  const select = h('select')
  select.append(h('option', { value: '', text: '默认模型' }))
  const aliases = h('optgroup', { attrs: { label: '模型别名' } })
  for (const model of state.config?.models ?? []) {
    aliases.append(h('option', { value: `alias:${model.alias}`, text: model.alias || '(未命名)' }))
  }
  if (aliases.childElementCount) select.append(aliases)
  const providers = h('optgroup', { attrs: { label: '供应商（第一个可用模型）' } })
  for (const provider of state.config?.providers ?? []) {
    providers.append(h('option', { value: `provider:${provider.id}`, text: provider.name || provider.id }))
  }
  if (providers.childElementCount) select.append(providers)
  return select
}

export function renderOverview(container: HTMLElement, goTab: (tab: Tab) => void): void {
  const config = state.config
  if (!config) return

  const enabledProviders = config.providers.filter((item) => item.enabled).length
  const enabledModels = config.models.filter((item) => item.enabled).length
  container.append(
    h(
      'div',
      { class: 'card' },
      h('div', { class: 'card-head' }, h('div', {}, h('h2', { text: '概览' }), h('p', { class: 'hint', text: '配置保存在插件自己的 KV 里；保存后其他插件下一次调用就会读到。' }))),
      h(
        'div',
        { class: 'kv' },
        stat('默认模型', config.default_model || '未设置'),
        stat('供应商', `${enabledProviders} / ${config.providers.length}`),
        stat('模型别名', `${enabledModels} / ${config.models.length}`),
        stat('配置版本', String(state.version)),
      ),
      h('p', { class: 'small subtle', text: `最后更新：${formatTime(state.updatedAt)}` }),
    ),
  )

  const issues = state.issues
  const issuesCard = h(
    'div',
    { class: 'card' },
    h('div', { class: 'card-head' }, h('div', {}, h('h2', { text: '配置问题' }), h('p', { class: 'hint', text: '错误会阻止保存；警告不影响保存，但可能导致调用失败。' }))),
  )
  if (issues.length === 0) {
    issuesCard.append(h('p', { class: 'small muted', text: '没有发现配置问题。' }))
  } else {
    const list = h('ul', { class: 'issue-list' })
    for (const item of issues) {
      list.append(
        h(
          'li',
          { class: `issue ${item.level === 'error' ? 'error' : 'warn'}` },
          item.path ? h('span', { class: 'mono small', text: `${item.path}：` }) : null,
          item.message,
        ),
      )
    }
    issuesCard.append(list)
  }
  if (state.corrupt) issuesCard.append(h('p', { class: 'small muted', text: '存储里的配置损坏；保存一次就会覆盖成当前页面上的内容。' }))
  container.append(issuesCard)

  const select = testOptions()
  const button = h('button', { class: 'btn primary', text: '测试', type: 'button' })
  button.addEventListener('click', async () => {
    if (!state.config) return
    const value = select.value
    const target = value.startsWith('alias:')
      ? { alias: value.slice(6) }
      : value.startsWith('provider:')
        ? { provider: value.slice(9) }
        : {}
    button.disabled = true
    button.textContent = '测试中…'
    try {
      const data = await api.test({ target, draft: toInput(state.config) })
      showTestResult(data.result)
    } catch (err) {
      await toast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      button.disabled = false
      button.textContent = '测试'
    }
  })

  container.append(
    h(
      'div',
      { class: 'card' },
      h('div', { class: 'card-head' }, h('div', {}, h('h2', { text: '快速测试' }), h('p', { class: 'hint', text: '会产生一次极小的真实调用；用的是页面当前内容，不需要先保存。' }))),
      h('div', { class: 'grid' }, h('div', { class: 'field' }, h('label', { text: '测试目标' }), select), h('div', { class: 'field' }, h('label', { text: ' ' }), h('div', {}, button))),
    ),
  )

  const usageCard = h(
    'div',
    { class: 'card' },
    h('div', { class: 'card-head' }, h('div', {}, h('h2', { text: '给其他插件用' }), h('p', { class: 'hint', text: '调用方在 depends 里声明 llm，然后 ctx.service("llm")。' }))),
  )
  usageCard.append(
    h('p', { class: 'small muted', text: '模型别名是唯一入口：换供应商、换模型只需要改这里。工具定义会透传，执行由调用方负责。' }),
    h('button', { class: 'btn', text: '查看用法与示例', type: 'button', on: { click: () => goTab('usage') } }),
  )
  container.append(usageCard)
}
