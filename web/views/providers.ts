import type { ProtocolId, ProtocolMeta, PublicProviderInput } from '../../src/config/types.js'
import { api, toast } from '../api.js'
import { confirmDialog, pickModels, showTestResult } from '../dialogs.js'
import { badge, field, h } from '../dom.js'
import { emit, state } from '../state.js'
import type { ProviderDraft } from '../types.js'
import { toInput } from '../types.js'

let counter = 1

function nextId(): string {
  const used = new Set((state.config?.providers ?? []).map((item) => item.id))
  for (;;) {
    const id = `provider-${counter++}`
    if (!used.has(id)) return id
  }
}

function protocolMeta(id: ProtocolId): ProtocolMeta | undefined {
  return state.meta?.protocols.find((item) => item.id === id)
}

function parseHeaders(text: string): Record<string, string> | undefined {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const at = trimmed.indexOf(':')
    if (at < 0) continue
    const key = trimmed.slice(0, at).trim()
    const value = trimmed.slice(at + 1).trim()
    if (key) out[key] = value
  }
  return Object.keys(out).length ? out : undefined
}

function formatHeaders(headers: Record<string, string> | undefined): string {
  return Object.entries(headers ?? {}).map(([key, value]) => `${key}: ${value}`).join('\n')
}

function providerInput(provider: ProviderDraft): PublicProviderInput {
  const { api_key, clear_key, api_key_set, ...rest } = provider
  const out: PublicProviderInput = { ...rest, enabled: provider.enabled }
  if (clear_key) out.api_key = null
  else if (api_key?.trim()) out.api_key = api_key.trim()
  return out
}

function safeAlias(name: string): string {
  const base = name.replace(/[^A-Za-z0-9._:-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 36)
  return base || 'model'
}

function uniqueAlias(base: string): string {
  const used = new Set((state.config?.models ?? []).map((item) => item.alias))
  if (!used.has(base)) return base
  for (let i = 2; ; i += 1) {
    const next = `${base}-${i}`
    if (!used.has(next)) return next
  }
}

function addProvider(rerender: () => void): void {
  if (!state.config) return
  const meta = state.meta?.protocols[0]
  const protocol = meta?.id ?? 'openai'
  state.config.providers.push({
    id: nextId(),
    name: '新供应商',
    protocol,
    base_url: meta?.default_base_url ?? '',
    enabled: true,
    api_key_set: false,
    clear_key: false,
  })
  rerender()
}

function providerCard(provider: ProviderDraft, index: number, rerender: () => void): HTMLElement {
  const meta = protocolMeta(provider.protocol)
  const name = h('input', { class: 'input', value: provider.name, placeholder: '显示名' })
  name.addEventListener('input', () => {
    provider.name = name.value
    emit()
  })

  const enabled = h('input', { type: 'checkbox', checked: provider.enabled })
  enabled.addEventListener('change', () => {
    provider.enabled = enabled.checked
    emit()
  })
  const enabledLabel = h('label', { class: 'small muted', style: 'display:flex;gap:6px;align-items:center;white-space:nowrap' }, enabled, '启用')

  const keyBadge = badge(provider.api_key_set && !provider.clear_key ? 'Key 已设置' : '未设置 Key', provider.api_key_set && !provider.clear_key ? 'ok' : '')

  const protocol = h('select')
  for (const item of state.meta?.protocols ?? [{ id: 'openai' as const, label: 'OpenAI 兼容', capabilities: [], default_base_url: '', base_url_hint: '' }]) {
    protocol.append(h('option', { value: item.id, text: item.label, selected: item.id === provider.protocol }))
  }

  const baseUrl = h('input', {
    value: provider.base_url,
    placeholder: 'https://api.example.com/v1',
  })
  const hint = h('span', { class: 'desc', text: meta ? meta.base_url_hint : '' })
  const baseField = h('div', { class: 'field' }, h('label', { text: '接口地址' }), baseUrl, hint)

  protocol.addEventListener('change', () => {
    const previous = protocolMeta(provider.protocol)
    provider.protocol = protocol.value as ProtocolId
    const next = protocolMeta(provider.protocol)
    hint.textContent = next?.base_url_hint ?? ''
    if (!baseUrl.value.trim() || baseUrl.value === previous?.default_base_url) {
      const value = next?.default_base_url ?? ''
      provider.base_url = value
      baseUrl.value = value
    }
    emit()
  })
  baseUrl.addEventListener('input', () => {
    provider.base_url = baseUrl.value
    emit()
  })

  const timeout = h('input', {
    type: 'number',
    attrs: { min: '1000', max: '28000', step: '1000' },
    value: provider.timeout_ms ?? '',
    placeholder: '默认 25000',
  })
  timeout.addEventListener('input', () => {
    provider.timeout_ms = timeout.value ? Number(timeout.value) : undefined
    emit()
  })

  const key = h('input', {
    type: 'password',
    value: provider.api_key ?? '',
    placeholder: provider.api_key_set && !provider.clear_key ? '已设置，留空保持不变' : '未设置',
    attrs: { autocomplete: 'new-password' },
  })
  const clear = h('button', {
    class: 'btn small',
    text: provider.clear_key ? '保存后清除' : '清除',
    type: 'button',
    disabled: !provider.api_key_set && !provider.api_key && !provider.clear_key,
  })
  key.addEventListener('input', () => {
    provider.api_key = key.value
    if (key.value) {
      provider.clear_key = false
      keyBadge.textContent = 'Key 已填写'
      keyBadge.className = 'badge ok'
      clear.disabled = false
    } else {
      keyBadge.textContent = provider.api_key_set ? 'Key 已设置' : '未设置 Key'
      keyBadge.className = `badge ${provider.api_key_set ? 'ok' : ''}`.trim()
      clear.disabled = !provider.api_key_set
    }
    emit()
  })
  clear.addEventListener('click', () => {
    provider.api_key = undefined
    provider.clear_key = true
    provider.api_key_set = false
    key.value = ''
    key.placeholder = '保存后清除'
    clear.textContent = '保存后清除'
    clear.disabled = true
    keyBadge.textContent = '保存后清除'
    keyBadge.className = 'badge warn'
    emit()
  })
  const keyField = h('div', { class: 'field' }, h('label', { text: 'API Key' }), h('div', { style: 'display:flex;gap:6px' }, key, clear), h('span', { class: 'desc', text: '只存在插件 KV 里，页面不回显；不需要认证的接口可以留空。' }))

  const headers = h('textarea', { value: formatHeaders(provider.headers), placeholder: 'X-Title: QFlareBot\nHTTP-Referer: https://example.com' })
  headers.addEventListener('input', () => {
    provider.headers = parseHeaders(headers.value)
    emit()
  })
  const headersField = h('div', { class: 'field' }, h('label', { text: '额外请求头' }), headers, h('span', { class: 'desc', text: '每行 Key: Value。只放非密钥头，Authorization / x-api-key 会按 API Key 生成。' }))

  const test = h('button', { class: 'btn small', text: '测试', type: 'button' })
  test.addEventListener('click', async () => {
    if (!state.config) return
    test.disabled = true
    test.textContent = '测试中…'
    try {
      const data = await api.test({ target: { provider: provider.id }, draft: toInput(state.config) })
      showTestResult(data.result)
    } catch (err) {
      await toast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      test.disabled = false
      test.textContent = '测试'
    }
  })

  const models = h('button', { class: 'btn small', text: '拉取模型', type: 'button' })
  models.addEventListener('click', async () => {
    models.disabled = true
    models.textContent = '拉取中…'
    try {
      const data = await api.models({ provider: providerInput(provider) })
      if (!data.models.length) {
        await toast('上游没有返回模型列表', 'warning')
        return
      }
      const existing = new Set((state.config?.models ?? []).filter((item) => item.provider === provider.id).map((item) => item.model))
      const picked = await pickModels(data.models, existing)
      if (!picked.length || !state.config) return
      for (const name of picked) {
        state.config.models.push({ alias: uniqueAlias(safeAlias(name)), provider: provider.id, model: name, enabled: true })
      }
      rerender()
    } catch (err) {
      await toast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      models.disabled = false
      models.textContent = '拉取模型'
    }
  })

  const remove = h('button', { class: 'btn small danger', text: '删除', type: 'button' })
  remove.addEventListener('click', async () => {
    if (!state.config) return
    const count = state.config.models.filter((item) => item.provider === provider.id).length
    const ok = await confirmDialog(`删除供应商「${provider.name}」${count ? `和它下面的 ${count} 个模型别名` : ''}？`, '删除')
    if (!ok || !state.config) return
    state.config.providers.splice(index, 1)
    state.config.models = state.config.models.filter((item) => item.provider !== provider.id)
    rerender()
  })

  return h(
    'div',
    { class: 'provider' },
    h(
      'div',
      { class: 'provider-head' },
      h('div', { class: 'provider-title' }, name, enabledLabel, keyBadge),
      h('div', { class: 'actions' }, test, models, remove),
    ),
    h(
      'div',
      { class: 'grid grid-3' },
      field('协议', protocol),
      baseField,
      field('超时（毫秒）', timeout, '留空用默认值，上限 28000'),
    ),
    h('div', { class: 'grid', style: 'margin-top:12px' }, keyField, headersField),
  )
}

export function renderProviders(container: HTMLElement, rerender: () => void): void {
  const config = state.config
  if (!config) return
  const head = h('div', { class: 'card-head' }, h('div', {}, h('h2', { text: '供应商' }), h('p', { class: 'hint', text: '一个供应商 = 一个接口地址 + 一把 Key。同一家可以配多条。' })))
  const add = h('button', { class: 'btn primary', text: '添加供应商', type: 'button', on: { click: () => addProvider(rerender) } })
  head.append(add)
  container.append(head)

  if (config.providers.length === 0) {
    container.append(h('div', { class: 'empty', text: '还没有供应商，点「添加供应商」开始。' }))
    return
  }
  config.providers.forEach((provider, index) => container.append(providerCard(provider, index, rerender)))
}
