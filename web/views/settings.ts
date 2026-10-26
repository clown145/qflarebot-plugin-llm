import { badge, field, h } from '../dom.js'
import { emit, state } from '../state.js'

export function renderSettings(container: HTMLElement): void {
  const config = state.config
  if (!config) return

  const listId = 'alias-options'
  const datalist = h('datalist', { attrs: { id: listId } })
  for (const model of config.models) datalist.append(h('option', { value: model.alias }))

  const defaultModel = h('input', { value: config.default_model, placeholder: 'chat', attrs: { list: listId } })
  defaultModel.addEventListener('input', () => {
    config.default_model = defaultModel.value
    emit()
  })

  const timeout = h('input', {
    type: 'number',
    attrs: { min: '1000', max: '28000', step: '1000' },
    value: config.request_timeout_ms,
  })
  timeout.addEventListener('input', () => {
    config.request_timeout_ms = Number(timeout.value)
    emit()
  })

  const retries = h('input', {
    type: 'number',
    attrs: { min: '0', max: '2', step: '1' },
    value: config.max_retries,
  })
  retries.addEventListener('input', () => {
    config.max_retries = Number(retries.value)
    emit()
  })

  container.append(
    h(
      'div',
      { class: 'card' },
      h('div', { class: 'card-head' }, h('div', {}, h('h2', { text: '默认设置' }), h('p', { class: 'hint', text: '调用方不传 model / timeout 时用这里的值。' }))),
      h(
        'div',
        { class: 'grid grid-3' },
        field('默认模型别名', defaultModel, '必须是上面某个模型别名'),
        field('默认超时（毫秒）', timeout, '1000–28000，建议 25000'),
        field('失败重试次数', retries, '0–2；只对限流、5xx、网络错误重试'),
      ),
      datalist,
    ),
  )

  const protocols = state.meta?.protocols ?? []
  const protocolList = h('div', { class: 'issue-list' })
  for (const item of protocols) {
    protocolList.append(
      h(
        'div',
        { class: 'small muted' },
        h('span', { class: 'mono', text: item.id }),
        ' · ',
        item.label,
        ' · ',
        ...item.capabilities.map((cap) => badge(cap, '')),
      ),
    )
  }

  container.append(
    h(
      'div',
      { class: 'card' },
      h('div', { class: 'card-head' }, h('div', {}, h('h2', { text: '服务信息' }), h('p', { class: 'hint', text: '其他插件通过 ctx.service("llm") 取这个服务。' }))),
      h(
        'div',
        { class: 'kv' },
        h('div', {}, h('div', { class: 'small muted', text: '插件版本' }), h('div', { class: 'value mono', text: state.meta?.plugin.version ?? '—' })),
        h('div', {}, h('div', { class: 'small muted', text: '服务名' }), h('div', { class: 'value mono', text: state.meta?.service.name ?? 'llm' })),
        h('div', {}, h('div', { class: 'small muted', text: '契约版本' }), h('div', { class: 'value mono', text: String(state.meta?.service.contractVersion ?? 1) })),
        h('div', {}, h('div', { class: 'small muted', text: '配置存储' }), h('div', { class: 'value', text: '插件 KV' })),
      ),
      h('div', { style: 'margin-top:12px' }, h('div', { class: 'small muted', text: '协议能力' }), protocolList),
      h('p', { class: 'small subtle', text: 'KV 是最终一致的：保存后其他边缘节点可能最多约一分钟才看到，和框架自己的配置快照一致。' }),
    ),
  )
}
