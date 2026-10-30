import type { Capability } from '../../src/contract.js'
import type { ModelConfig, ProtocolId, ProtocolMeta, PublicConfigInput, PublicProviderInput } from '../../src/config/types.js'
import { capabilitiesOf } from '../../src/config/types.js'
import type { MetadataField, MetadataResolution, ModelCatalog } from '../../src/modelMetadata.js'
import { resolveModelMetadata, withMetadata } from '../../src/modelMetadata.js'
import { api, toast } from '../api.js'
import { confirmDialog, showTestResult } from '../dialogs.js'
import { badge, clear, field, formatTokenCount, h } from '../dom.js'
import { headerIssues, managedHeaderKeys } from '../headers.js'
import { timeoutHint, timeoutLimits } from '../limits.js'
import { catalogProviderFor, loadModelCatalog } from '../modelCatalog.js'
import { openModelDialog } from '../modelDialog.js'
import { setPending } from '../pending.js'
import { aliasBase, isProviderDraftDirty, uniqueProviderId } from '../providerDraft.js'
import { pickProviderPreset } from '../providerTemplateDialog.js'
import { rebaseProviderDraft } from '../rebase.js'
import { updateConfig } from '../save.js'
import { onSavedApplied, state } from '../state.js'
import type { AppConfigDraft, ProviderDraft } from '../types.js'
import { clone, toInput, uniqueAlias } from '../types.js'

const LABELS: Record<Capability, string> = {
  text: '文本',
  image: '图片',
  audio: '音频',
  tools: '工具',
  json: 'JSON',
  reasoning: '推理',
}

const FIELD_LABELS: Record<MetadataField, string> = {
  context_window: '上下文窗口',
  max_output_tokens: '输出上限',
  capabilities: '能力',
}

const AVAILABLE_LIMIT = 200

type Mode = 'workbench' | 'aliases'

interface ServiceState {
  mode: Mode
  selectedId: string | null
  draft: ProviderDraft | null
  base: ProviderDraft | null
  isNew: boolean
  baseVersion: number
  available: string[]
  availableFor: string | null
  providerSearch: string
  modelSearch: string
  aliasSearch: string
  fetching: boolean
  adding: boolean
}

const service: ServiceState = {
  mode: 'workbench',
  selectedId: null,
  draft: null,
  base: null,
  isNew: false,
  baseVersion: -1,
  available: [],
  availableFor: null,
  providerSearch: '',
  modelSearch: '',
  aliasSearch: '',
  fetching: false,
  adding: false,
}

let rerenderView: () => void = () => {}
let activeSidebarName: HTMLElement | null = null
let activeSidebarDirty: HTMLElement | null = null
let activeSidebarMeta: HTMLElement | null = null
let activeSidebarDot: HTMLElement | null = null

export function resetServiceState(): void {
  service.mode = 'workbench'
  service.selectedId = null
  service.draft = null
  service.base = null
  service.isNew = false
  service.baseVersion = -1
  service.available = []
  service.availableFor = null
  service.providerSearch = ''
  service.modelSearch = ''
  service.aliasSearch = ''
  service.fetching = false
  service.adding = false
  activeSidebarName = null
  activeSidebarDirty = null
  activeSidebarMeta = null
  activeSidebarDot = null
  setPending('provider', false)
}
function draftDirty(): boolean {
  return Boolean(service.draft && isProviderDraftDirty(service.draft, service.base, service.isNew))
}

function syncPending(): void {
  setPending('provider', draftDirty())
}

/**
 * 别处保存后（模型即时保存、设置保存、另一个标签页）把供应商草稿 rebase 到最新已保存值。
 * 没有未保存编辑时直接整体刷新草稿，保持原有行为。
 */
onSavedApplied((previous, next) => {
  if (!service.draft) return
  if (service.isNew) {
    // 新建供应商没有服务端基线，只可能被别人清掉，交给 renderService 兜底
    syncPending()
    return
  }
  const nextProvider = next.providers.find((item) => item.id === service.draft?.id)
  if (!nextProvider) {
    // 供应商在别处被删掉了：清掉草稿，renderService 会重新选一个
    service.draft = null
    service.base = null
    service.selectedId = null
    service.isNew = false
    syncPending()
    return
  }
  if (!draftDirty()) {
    service.draft = { ...clone(nextProvider), clear_key: false }
    service.base = clone(service.draft)
    service.baseVersion = state.version
    syncPending()
    return
  }
  const before = previous?.providers.find((item) => item.id === service.draft?.id) ?? null
  service.draft = rebaseProviderDraft(service.draft, before, nextProvider)
  syncPending()
})

function clearAvailable(): void {
  service.available = []
  service.availableFor = null
}

function protocolMeta(id: ProtocolId): ProtocolMeta | undefined {
  return state.meta?.protocols.find((item) => item.id === id)
}

function protocolLabel(id: ProtocolId): string {
  return protocolMeta(id)?.label ?? (id === 'anthropic' ? 'Anthropic' : id === 'gemini' ? 'Google Gemini' : 'OpenAI 兼容')
}

function providerInput(provider: ProviderDraft): PublicProviderInput {
  const { api_key, clear_key, api_key_set, ...rest } = provider
  void api_key_set
  const out: PublicProviderInput = { ...rest, enabled: provider.enabled }
  if (clear_key) out.api_key = null
  else if (api_key?.trim()) out.api_key = api_key.trim()
  return out
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

function modelsOf(providerId: string): ModelConfig[] {
  return state.config?.models.filter((item) => item.provider === providerId) ?? []
}

function providerNotes(
  provider: Pick<ProviderDraft, 'protocol' | 'enabled' | 'api_key_set' | 'clear_key'>,
  count: number,
): string {
  const notes = [protocolLabel(provider.protocol), `${count} 个别名`]
  if (!provider.enabled) notes.push('已停用')
  if (provider.clear_key) notes.push('待清除 Key')
  else if (!provider.api_key_set) notes.push('未设置 Key')
  if (count === 0) notes.push('无模型')
  return notes.join(' · ')
}

function loadDraft(id: string | null): void {
  const config = state.config
  const changed = service.selectedId !== id
  const previous = service.draft
  service.selectedId = id
  service.isNew = false
  service.base = null
  if (!config || !id) {
    service.draft = null
    syncPending()
    return
  }
  const provider = config.providers.find((item) => item.id === id)
  if (!provider) {
    service.draft = null
    syncPending()
    return
  }
  if (changed) {
    service.modelSearch = ''
    clearAvailable()
  } else if (previous && (previous.base_url !== provider.base_url || previous.protocol !== provider.protocol)) {
    clearAvailable()
  }
  service.draft = { ...clone(provider), clear_key: false }
  service.base = clone(service.draft)
  service.baseVersion = state.version
  syncPending()
}

function configWithDraft(): AppConfigDraft | null {
  if (!state.config || !service.draft) return null
  const draft = service.draft
  const providers = state.config.providers.map((item) => (item.id === draft.id ? clone(draft) : clone(item)))
  if (!providers.some((item) => item.id === draft.id)) providers.push(clone(draft))
  return { ...clone(state.config), providers }
}

function testDraftInput(): PublicConfigInput | undefined {
  const config = configWithDraft()
  return config ? toInput(config) : undefined
}

async function selectProvider(id: string): Promise<void> {
  if (id === service.selectedId && service.draft) return
  if (service.draft && draftDirty()) {
    const ok = await confirmDialog('当前供应商有未保存的修改，切换会丢弃这些修改。', '丢弃并切换')
    if (!ok) return
  }
  loadDraft(id)
  rerenderView()
}

async function addProvider(): Promise<void> {
  if (service.draft && draftDirty()) {
    const ok = await confirmDialog('当前供应商有未保存的修改，添加新供应商会丢弃这些修改。', '继续添加')
    if (!ok) return
  }
  const preset = await pickProviderPreset()
  if (!preset) return
  const used = [
    ...(state.config?.providers.map((item) => item.id) ?? []),
    ...(service.draft?.id ? [service.draft.id] : []),
  ]
  const id = uniqueProviderId(preset.slug, used)
  service.mode = 'workbench'
  service.selectedId = id
  service.draft = {
    id,
    name: preset.name,
    protocol: preset.protocol,
    base_url: preset.base_url,
    enabled: true,
    api_key_set: false,
    clear_key: false,
  }
  service.base = null
  service.isNew = true
  service.available = []
  service.availableFor = null
  service.modelSearch = ''
  syncPending()
  rerenderView()
}

async function saveProvider(options: { silent?: boolean } = {}): Promise<boolean> {
  const draft = service.draft
  if (!draft) return false
  const target = clone(draft)
  target.name = target.name.trim()
  target.base_url = target.base_url.trim()
  if (!target.name) {
    await toast('供应商名称不能为空', 'warning')
    return false
  }
  if (target.name.length > 60) {
    await toast('供应商名称最多 60 个字符', 'warning')
    return false
  }
  if (!target.base_url) {
    await toast('接口地址不能为空', 'warning')
    return false
  }

  const wasNew = service.isNew
  const before = service.base ? clone(service.base) : null
  const changedConnection =
    wasNew ||
    !before ||
    before.base_url !== target.base_url ||
    before.protocol !== target.protocol ||
    Boolean(target.api_key?.trim()) ||
    Boolean(target.clear_key)

  const ok = await updateConfig(
    (config) => {
      const index = config.providers.findIndex((item) => item.id === target.id)
      if (index >= 0) config.providers[index] = clone(target)
      else config.providers.push(clone(target))
    },
    { success: options.silent ? undefined : wasNew ? '供应商已添加' : '供应商设置已保存' },
  )
  if (!ok) return false

  const saved = state.config?.providers.find((item) => item.id === target.id)
  if (!saved) return false
  service.selectedId = saved.id
  service.draft = { ...clone(saved), clear_key: false }
  service.base = clone(service.draft)
  service.baseVersion = state.version
  service.isNew = false
  if (changedConnection) clearAvailable()
  syncPending()
  rerenderView()
  return true
}

async function ensureProviderSaved(): Promise<boolean> {
  if (!service.draft) {
    await toast('先添加一个供应商', 'warning')
    return false
  }
  if (!service.isNew && !draftDirty()) return true
  return saveProvider({ silent: true })
}

async function removeProvider(): Promise<void> {
  const draft = service.draft
  if (!draft) return
  if (service.isNew) {
    const ok = await confirmDialog(`放弃新建供应商「${draft.name || draft.id}」？`, '放弃')
    if (!ok) return
    const first = state.config?.providers[0]?.id ?? null
    loadDraft(first)
    rerenderView()
    return
  }
  const count = modelsOf(draft.id).length
  const ok = await confirmDialog(
    `删除供应商「${draft.name || draft.id}」${count ? `和它下面的 ${count} 个模型别名` : ''}？`,
    '删除',
  )
  if (!ok) return
  const id = draft.id
  const done = await updateConfig(
    (config) => {
      config.providers = config.providers.filter((item) => item.id !== id)
      const removed = new Set(config.models.filter((item) => item.provider === id).map((item) => item.alias))
      config.models = config.models.filter((item) => item.provider !== id)
      if (removed.has(config.default_model)) config.default_model = ''
    },
    { success: '供应商已删除' },
  )
  if (!done) return
  loadDraft(state.config?.providers[0]?.id ?? null)
  rerenderView()
}

async function testProvider(button: HTMLButtonElement): Promise<void> {
  const draft = service.draft
  if (!draft) return
  const draftConfig = testDraftInput()
  if (!draftConfig) return
  button.disabled = true
  button.textContent = '测试中…'
  try {
    const data = await api.test({ target: { provider: draft.id }, draft: draftConfig })
    showTestResult(data.result)
  } catch (err) {
    await toast(err instanceof Error ? err.message : String(err), 'error')
  } finally {
    button.disabled = false
    button.textContent = '测试'
  }
}

function resolutionFor(name: string, provider: ProviderDraft, catalog: ModelCatalog): MetadataResolution | undefined {
  return resolveModelMetadata(catalog, name, catalogProviderFor(provider, catalog))
}

interface BuiltModel {
  model: ModelConfig
  conflicts: MetadataField[]
}

function buildModel(provider: ProviderDraft, name: string, catalog: ModelCatalog | null, used: ModelConfig[]): BuiltModel {
  let model: ModelConfig = {
    alias: uniqueAlias(used, aliasBase(name)),
    provider: provider.id,
    model: name,
    enabled: true,
  }
  const conflicts: MetadataField[] = []
  if (catalog) {
    const resolution = resolutionFor(name, provider, catalog)
    if (resolution) {
      model = withMetadata(model, resolution.metadata, provider.protocol, false, !resolution.conflicts.includes('capabilities'))
      conflicts.push(...resolution.conflicts)
    }
  }
  return { model, conflicts }
}

function conflictText(conflicts: MetadataField[]): string {
  return conflicts.map((item) => FIELD_LABELS[item]).join('、')
}

async function fetchUpstreamModels(): Promise<void> {
  if (service.fetching || service.adding || !service.draft) return
  service.fetching = true
  rerenderView()
  try {
    if (!(await ensureProviderSaved())) return
    const provider = service.draft
    if (!provider) return
    const data = await api.models({ provider: providerInput(provider) })
    if (service.draft?.id !== provider.id) return
    const models = [...new Set(data.models.map((item) => item.trim()).filter(Boolean))]
    service.available = models
    service.availableFor = provider.id
    if (!models.length) await toast('上游没有返回模型列表', 'warning')
  } catch (err) {
    await toast(err instanceof Error ? err.message : String(err), 'error')
  } finally {
    service.fetching = false
    rerenderView()
  }
}

async function addAvailableModel(name: string, button?: HTMLButtonElement): Promise<void> {
  if (service.adding) return
  service.adding = true
  if (button) {
    button.disabled = true
    button.textContent = '添加中…'
  }
  try {
    if (!(await ensureProviderSaved())) return
    const provider = service.draft
    if (!provider) return
    const catalog = await loadModelCatalog().catch(() => null)
    if (service.draft?.id !== provider.id) return
    const built = buildModel(provider, name, catalog, state.config?.models ?? [])
    const ok = await updateConfig((config) => {
      config.models.push(clone(built.model))
      if (!config.default_model) config.default_model = built.model.alias
    })
    if (!ok) return
    if (built.conflicts.length) {
      await toast(
        `已添加 ${built.model.alias}；${conflictText(built.conflicts)}在目录里不一致，请编辑确认`,
        'warning',
      )
    } else if (!catalog) {
      await toast(`已添加 ${built.model.alias}；模型信息获取失败，可稍后编辑补充`, 'warning')
    } else {
      await toast(`已添加 ${built.model.alias}`, 'success')
    }
  } finally {
    service.adding = false
    if (button) {
      button.disabled = false
      button.textContent = '+'
    }
    rerenderView()
  }
}

async function addAllAvailable(): Promise<void> {
  if (service.adding || !service.draft) return
  const provider = service.draft
  const configured = new Set(modelsOf(provider.id).map((item) => item.model))
  const names = service.available.filter((name) => !configured.has(name))
  if (!names.length) {
    await toast('没有新的上游模型可添加', 'warning')
    return
  }
  const ok = await confirmDialog(`把 ${names.length} 个上游模型都添加为模型别名？`, '全部添加')
  if (!ok) return

  service.adding = true
  rerenderView()
  try {
    if (!(await ensureProviderSaved())) return
    const current = service.draft
    if (!current || current.id !== provider.id) return
    // 目录只是辅助数据：拿不到就退化成「只添加别名」，但要明确告诉用户，
    // 不能像以前那样静默吞掉失败，让用户以为上下文窗口/能力已经补全了。
    let catalog: ModelCatalog | null = null
    try {
      catalog = await loadModelCatalog()
    } catch {
      catalog = null
    }
    if (service.draft?.id !== provider.id) return
    if (!catalog) {
      const proceed = await confirmDialog(
        `模型元数据获取失败，将只添加 ${names.length} 个别名（上下文窗口和能力需要之后手动补充）。继续吗？`,
        '继续添加',
      )
      if (!proceed) return
    }
    const used = [...(state.config?.models ?? [])]
    const added: ModelConfig[] = []
    const conflicted: string[] = []
    const withoutMetadata: string[] = []
    for (const name of names) {
      const built = buildModel(current, name, catalog, used)
      used.push(built.model)
      added.push(built.model)
      if (built.conflicts.length) conflicted.push(name)
      else if (catalog && !resolutionFor(name, current, catalog)) withoutMetadata.push(name)
    }
    const saved = await updateConfig(
      (config) => {
        config.models.push(...added.map((item) => clone(item)))
        if (!config.default_model && added[0]) config.default_model = added[0].alias
      },
      { success: conflicted.length || withoutMetadata.length || !catalog ? undefined : `已添加 ${added.length} 个模型别名` },
    )
    if (!saved) return
    if (!catalog) {
      await toast(`已添加 ${added.length} 个别名；模型元数据获取失败，上下文窗口和能力需要手动补充`, 'warning')
      return
    }
    if (withoutMetadata.length) {
      const preview = withoutMetadata.slice(0, 3).join('、')
      await toast(
        `已添加 ${added.length} 个别名；${withoutMetadata.length} 个别名未获取到模型信息，可稍后编辑补充：${preview}${withoutMetadata.length > 3 ? ' 等' : ''}`,
        'warning',
      )
      return
    }
    if (conflicted.length) {
      const preview = conflicted.slice(0, 3).join('、')
      await toast(
        `已添加 ${added.length} 个别名；${conflicted.length} 个模型信息有冲突，请编辑确认：${preview}${conflicted.length > 3 ? ' 等' : ''}`,
        'warning',
      )
    }
  } finally {
    service.adding = false
    rerenderView()
  }
}

async function openAddModel(): Promise<void> {
  if (!(await ensureProviderSaved())) return
  openModelDialog({ providerId: service.draft?.id, onSaved: () => rerenderView() })
}

async function toggleModel(model: ModelConfig, next: boolean): Promise<void> {
  if (state.busy) return
  const ok = await updateConfig((config) => {
    const found = config.models.find((item) => item.alias === model.alias)
    if (found) found.enabled = next
  })
  if (ok) rerenderView()
}

async function deleteModel(model: ModelConfig): Promise<void> {
  const suffix = model.alias === state.config?.default_model ? ' 它也是当前默认模型。' : ''
  const ok = await confirmDialog(`删除模型别名「${model.alias || '未命名'}」？${suffix}`, '删除')
  if (!ok) return
  const done = await updateConfig(
    (config) => {
      config.models = config.models.filter((item) => item.alias !== model.alias)
      if (config.default_model === model.alias) config.default_model = ''
    },
    { success: '模型已删除' },
  )
  if (done) rerenderView()
}

async function testModel(model: ModelConfig, button: HTMLButtonElement): Promise<void> {
  if (!model.alias.trim()) {
    await toast('先填模型别名', 'warning')
    return
  }
  const draftConfig = testDraftInput() ?? (state.config ? toInput(state.config) : undefined)
  if (!draftConfig) return
  button.disabled = true
  button.textContent = '测试中…'
  try {
    const data = await api.test({ target: { alias: model.alias }, draft: draftConfig })
    showTestResult(data.result)
  } catch (err) {
    await toast(err instanceof Error ? err.message : String(err), 'error')
  } finally {
    button.disabled = false
    button.textContent = '测试'
  }
}

async function setDefault(alias: string): Promise<void> {
  const ok = await updateConfig(
    (config) => {
      config.default_model = alias
    },
    { success: '默认模型已更新' },
  )
  if (ok) rerenderView()
}

function switchInput(checked: boolean, onChange: (next: boolean) => void): HTMLElement {
  const box = h('input', { type: 'checkbox', checked })
  box.addEventListener('change', () => onChange(box.checked))
  return h('label', { class: 'switch' }, box, h('span', { class: 'switch-track' }))
}

function effectiveCapabilities(model: ModelConfig, protocol: ProtocolId): Capability[] {
  if (model.capabilities?.length) return model.capabilities
  return capabilitiesOf(protocol)
}

function capabilityBadges(model: ModelConfig, provider: ProviderDraft | undefined): HTMLElement {
  const caps = effectiveCapabilities(model, provider?.protocol ?? 'openai').filter((item) => item !== 'text')
  if (!caps.length) return h('span', { class: 'subtle small', text: '仅文本' })
  return h('div', { class: 'cap-list' }, ...caps.map((cap) => badge(LABELS[cap], '')))
}

function contextBadge(model: ModelConfig): HTMLElement {
  const title = model.max_output_tokens !== undefined ? `输出上限 ${formatTokenCount(model.max_output_tokens)}` : undefined
  return h('span', { class: 'badge', title, text: `上下文 ${formatTokenCount(model.context_window)}` })
}

/**
 * 窄屏的供应商选择器。**只在窄屏显示**（CSS 控制），宽屏用左侧列表。
 *
 * 对标 AstrBot 的 `provider-sources-mobile-select`
 * （`ProviderSourcesPanel.vue:9` + `@media (max-width: 960px)`）：
 * 它在窄屏把左侧整个列表 `display:none`，换成一个下拉框。
 *
 * 为什么必须换，而不是把两栏叠成一栏：侧栏里是一个**固定 220px 高、
 * 带内部滚动的列表**。手机上把它堆在内容上面，等于先占掉三分之一屏
 * 才能看到表单，而且那 220px 内部滚动会和页面的整页滚动打架 ——
 * 用户往下滑时不知道滑的是哪一层。这正是之前手机上难看的根源。
 */
function mobileProviderSelect(): HTMLElement | null {
  const config = state.config
  if (!config) return null

  const select = h('select', { class: 'qb-input provider-mobile-select' }) as HTMLSelectElement

  if (service.isNew && service.draft) {
    const option = h('option', {
      value: service.draft.id,
      text: `${service.draft.name || '新供应商'}（未保存）`,
      selected: true,
    })
    select.append(option)
  }

  for (const provider of config.providers) {
    const selected = provider.id === service.selectedId
    const count = config.models.filter((model) => model.provider === provider.id).length
    select.append(
      h('option', {
        value: provider.id,
        text: `${provider.name || provider.id}${count ? ` · ${count} 个别名` : ''}`,
        selected,
      }),
    )
  }

  select.addEventListener('change', () => {
    void selectProvider(select.value)
  })

  const add = h('button', { class: 'qb-btn qb-btn--sm', text: '添加', type: 'button' })
  add.addEventListener('click', () => {
    void addProvider()
  })

  return h('div', { class: 'provider-mobile-bar' }, select, add)
}

function serviceHead(): HTMLElement {
  const segments = h('div', { class: 'segmented', attrs: { role: 'tablist', 'aria-label': '模型服务视图' } })
  const modes: Array<{ id: Mode; label: string }> = [
    { id: 'workbench', label: '按供应商' },
    { id: 'aliases', label: '全部别名' },
  ]
  for (const item of modes) {
    const button = h('button', {
      class: `segment${service.mode === item.id ? ' active' : ''}`,
      type: 'button',
      text: item.label,
      aria: { selected: String(service.mode === item.id) },
    })
    button.addEventListener('click', () => {
      if (service.mode === item.id) return
      service.mode = item.id
      rerenderView()
    })
    segments.append(button)
  }
  return h(
    'div',
    { class: 'service-head' },
    h(
      'div',
      {},
      h('h2', { text: '模型服务' }),
      h('p', {
        class: 'hint',
        text:
          service.mode === 'aliases'
            ? '不区分供应商地检查全部别名和默认模型；模型改动会立即保存。'
            : '左边选择供应商；供应商设置需要单独保存，模型改动会立即保存。',
      }),
    ),
    segments,
  )
}

function providerList(): HTMLElement {
  const config = state.config
  const list = h('div', { class: 'provider-list' })
  if (!config) return list
  const keyword = service.providerSearch.trim().toLowerCase()
  activeSidebarName = null
  activeSidebarDirty = null
  activeSidebarMeta = null
  activeSidebarDot = null

  if (service.isNew && service.draft) {
    const draft = service.draft
    const active = service.selectedId === draft.id
    const matches = !keyword || [draft.name, draft.id, '新供应商'].some((value) => value.toLowerCase().includes(keyword))
    if (matches) {
      const nameEl = h('span', { class: 'provider-name', text: draft.name || '新供应商' })
      if (active) activeSidebarName = nameEl
      const item = h(
        'button',
        { class: `provider-item${active ? ' active' : ''}`, type: 'button' },
        h('span', { class: 'provider-item-main' }, h('span', { class: 'provider-status-dot' }), nameEl),
        h('span', { class: 'provider-meta', text: '还未保存' }),
      )
      item.addEventListener('click', () => {
        if (service.selectedId !== draft.id) void selectProvider(draft.id)
      })
      list.append(item)
    }
  }

  for (const provider of config.providers) {
    const active = provider.id === service.selectedId
    const displayName = active && service.draft ? service.draft.name : provider.name
    if (keyword && ![displayName, provider.id, protocolLabel(provider.protocol)].some((value) => value.toLowerCase().includes(keyword))) {
      continue
    }
    const count = modelsOf(provider.id).length
    const live = active && service.draft ? service.draft : provider
    const nameEl = h('span', { class: 'provider-name', text: displayName || provider.id })
    const dirtyMark = badge('未保存', 'warn')
    dirtyMark.style.display = active && draftDirty() ? '' : 'none'
    const dot = h('span', { class: `provider-status-dot${live.enabled ? '' : ' off'}` })
    const meta = h('span', { class: 'provider-meta', text: providerNotes(live, count) })
    if (active) {
      activeSidebarName = nameEl
      activeSidebarDirty = dirtyMark
      activeSidebarMeta = meta
      activeSidebarDot = dot
    }
    const item = h(
      'button',
      { class: `provider-item${active ? ' active' : ''}`, type: 'button' },
      h('span', { class: 'provider-item-main' }, dot, nameEl, dirtyMark),
      meta,
    )
    item.addEventListener('click', () => void selectProvider(provider.id))
    list.append(item)
  }

  if (!list.childElementCount) {
    list.append(h('p', { class: 'small subtle', text: keyword ? '没有匹配的供应商' : '还没有供应商' }))
  }
  return list
}

function sidebar(): HTMLElement {
  const config = state.config
  const count = (config?.providers.length ?? 0) + (service.isNew && service.draft ? 1 : 0)
  const search = h('input', { type: 'search', value: service.providerSearch, placeholder: '筛选供应商' })
  const listBox = h('div')
  const refreshList = () => listBox.replaceChildren(providerList())
  search.addEventListener('input', () => {
    service.providerSearch = search.value
    refreshList()
  })
  refreshList()

  const add = h('button', { class: 'qb-btn qb-btn--sm', text: '添加', type: 'button' })
  add.addEventListener('click', () => void addProvider())

  return h(
    'aside',
    { class: 'qb-card side-card' },
    h('div', { class: 'side-head' }, h('div', {}, h('h3', { text: '供应商' }), h('span', { class: 'small subtle', text: `${count} 个` })), add),
    count || service.isNew ? search : null,
    listBox,
    h('p', { class: 'side-note small subtle', text: '同一服务商可以添加多条，用于不同 Key 或中转地址。' }),
  )
}

function updateLocal(
  draft: ProviderDraft,
  refs: {
    save: HTMLButtonElement
    dirty: HTMLElement
    keyBadge: HTMLElement
    clearKey: HTMLButtonElement
    key: HTMLInputElement
    enabledBadge: HTMLElement
    title: HTMLElement
  },
): void {
  const dirty = draftDirty()
  refs.save.disabled = !dirty || state.busy
  refs.dirty.style.display = dirty ? '' : 'none'
  refs.title.textContent = draft.name.trim() || (service.isNew ? '新供应商' : draft.id)
  refs.enabledBadge.textContent = draft.enabled ? '已启用' : '已停用'
  refs.enabledBadge.className = `badge ${draft.enabled ? 'ok' : ''}`.trim()

  const typed = Boolean(draft.api_key?.trim())
  const clear = Boolean(draft.clear_key)
  refs.keyBadge.textContent = typed
    ? 'Key 已填写'
    : clear
      ? '保存后清除 Key'
      : draft.api_key_set
        ? 'Key 已设置'
        : '未设置 Key'
  refs.keyBadge.className = `badge ${typed || (draft.api_key_set && !clear) ? 'ok' : clear || !draft.api_key_set ? 'warn' : ''}`.trim()
  refs.clearKey.disabled = !draft.api_key_set && !typed && !clear
  refs.clearKey.textContent = clear ? '撤销清除' : '清除'
  refs.key.placeholder = draft.api_key_set && !clear ? '已设置，留空保持不变' : clear ? '保存后清除' : '未设置'
  if (activeSidebarName) activeSidebarName.textContent = draft.name.trim() || (service.isNew ? '新供应商' : draft.id)
  if (activeSidebarDirty) activeSidebarDirty.style.display = dirty ? '' : 'none'
  if (activeSidebarMeta) activeSidebarMeta.textContent = providerNotes(draft, modelsOf(draft.id).length)
  if (activeSidebarDot) activeSidebarDot.className = `provider-status-dot${draft.enabled ? '' : ' off'}`
}

function providerCard(): HTMLElement {
  const draft = service.draft
  if (!draft) return h('div')
  const meta = protocolMeta(draft.protocol)
  const title = h('h2', { text: draft.name.trim() || (service.isNew ? '新供应商' : draft.id) })
  const dirtyBadge = badge('未保存', 'warn')
  dirtyBadge.style.display = draftDirty() ? '' : 'none'
  const enabledBadge = badge(draft.enabled ? '已启用' : '已停用', draft.enabled ? 'ok' : '')
  const keyBadge = badge('', '')
  const subtitle = h('p', { class: 'hint', text: `${draft.id} · ${protocolLabel(draft.protocol)}` })

  const test = h('button', { class: 'qb-btn', text: '测试', type: 'button' })
  const save = h('button', { class: 'qb-btn qb-btn--primary', text: service.isNew ? '添加供应商' : '保存', type: 'button' })
  save.disabled = !draftDirty()

  const name = h('input', { value: draft.name, placeholder: '显示名称', attrs: { maxlength: '60' } })
  const protocol = h('select')
  for (const item of state.meta?.protocols ?? [
    { id: 'openai' as const, label: 'OpenAI 兼容', capabilities: [], default_base_url: '', base_url_hint: '' },
    { id: 'anthropic' as const, label: 'Anthropic Messages', capabilities: [], default_base_url: '', base_url_hint: '' },
  ]) {
    protocol.append(h('option', { value: item.id, text: item.label, selected: item.id === draft.protocol }))
  }
  const baseUrl = h('input', { value: draft.base_url, placeholder: 'https://api.example.com/v1' })
  const baseHint = h('span', { class: 'desc', text: meta?.base_url_hint ?? '' })
  const limits = timeoutLimits()
  const timeout = h('input', {
    type: 'number',
    attrs: { min: String(limits.min), max: String(limits.max), step: '1000' },
    value: draft.timeout_ms ?? '',
    placeholder: `默认 ${limits.defaultMs}`,
  })
  const key = h('input', {
    type: 'password',
    value: draft.api_key ?? '',
    placeholder: draft.api_key_set && !draft.clear_key ? '已设置，留空保持不变' : '未设置',
    attrs: { autocomplete: 'new-password' },
  })
  const clearKey = h('button', { class: 'qb-btn qb-btn--sm', text: draft.clear_key ? '撤销清除' : '清除', type: 'button' })
  clearKey.disabled = !draft.api_key_set && !draft.api_key && !draft.clear_key
  const headers = h('textarea', { rows: 3, value: formatHeaders(draft.headers), placeholder: 'X-Title: QFlareBot\nHTTP-Referer: https://example.com' })
  const headersHint = h('span', { class: 'desc', text: '每行 Key: Value。只放非密钥头；Authorization / x-api-key 由 API Key 自动生成。' })
  const headersBox = h(
    'details',
    { class: 'advanced' },
    h('summary', { text: '额外请求头' }),
    headers,
    headersHint,
  )
  if (draft.headers) headersBox.open = true

  /**
   * 服务端把受管头（Authorization / x-api-key / host / content-type …）当 error，
   * 保存会直接 400。这里提前在本地拦下来，并高亮输入框，不用等一次失败的 PUT。
   */
  const validateHeaders = (): boolean => {
    const issues = headerIssues(parseHeaders(headers.value))
    const errors = issues.filter((item) => item.level === 'error')
    const warnings = issues.filter((item) => item.level === 'warn')
    headers.classList.toggle('invalid', errors.length > 0)
    headers.setAttribute('aria-invalid', errors.length ? 'true' : 'false')
    if (errors.length) {
      headersHint.textContent = `${managedHeaderKeys(parseHeaders(headers.value)).join(' / ')} 由 API Key 自动生成，不要在这里填写`
      headersHint.className = 'desc danger-text'
      return false
    }
    if (warnings.length) {
      headersHint.textContent = `${warnings.map((item) => item.key).join(' / ')} 看起来像密钥；导出时会被剔除，建议改放到 API Key 字段`
      headersHint.className = 'desc warn-text'
      return true
    }
    headersHint.textContent = '每行 Key: Value。只放非密钥头；Authorization / x-api-key 由 API Key 自动生成。'
    headersHint.className = 'desc'
    return true
  }

  const enabled = h('input', { type: 'checkbox', checked: draft.enabled })
  const enabledLabel = h('label', { class: 'switch switch-label' }, enabled, h('span', { class: 'switch-track' }), h('span', { class: 'switch-text', text: '启用这个供应商' }))

  const refs = { save, dirty: dirtyBadge, keyBadge, clearKey, key, enabledBadge, title }
  const touch = () => {
    syncPending()
    updateLocal(draft, refs)
  }

  name.addEventListener('input', () => {
    draft.name = name.value
    touch()
  })
  protocol.addEventListener('change', () => {
    const previous = protocolMeta(draft.protocol)
    draft.protocol = protocol.value as ProtocolId
    const next = protocolMeta(draft.protocol)
    baseHint.textContent = next?.base_url_hint ?? ''
    if (!baseUrl.value.trim() || baseUrl.value === previous?.default_base_url) {
      const value = next?.default_base_url ?? ''
      draft.base_url = value
      baseUrl.value = value
    }
    clearAvailable()
    subtitle.textContent = `${draft.id} · ${protocolLabel(draft.protocol)}`
    touch()
  })
  baseUrl.addEventListener('input', () => {
    draft.base_url = baseUrl.value
    touch()
  })
  timeout.addEventListener('input', () => {
    draft.timeout_ms = timeout.value ? Number(timeout.value) : undefined
    touch()
  })
  key.addEventListener('input', () => {
    draft.api_key = key.value
    if (key.value) draft.clear_key = false
    touch()
  })
  clearKey.addEventListener('click', () => {
    draft.clear_key = !draft.clear_key
    if (draft.clear_key) {
      draft.api_key = undefined
      key.value = ''
    }
    touch()
  })
  headers.addEventListener('input', () => {
    draft.headers = parseHeaders(headers.value)
    validateHeaders()
    touch()
  })
  enabled.addEventListener('change', () => {
    draft.enabled = enabled.checked
    touch()
  })

  test.addEventListener('click', () => {
    if (test.disabled) return
    void testProvider(test)
  })
  save.addEventListener('click', () => {
    if (save.disabled) return
    if (!validateHeaders()) {
      void toast('Authorization / x-api-key 由 API Key 自动生成，不要在这里填写', 'warning')
      return
    }
    save.disabled = true
    save.textContent = '保存中…'
    void saveProvider().finally(() => {
      save.disabled = !draftDirty()
      save.textContent = service.isNew ? '添加供应商' : '保存'
    })
  })

  const remove = h('button', { class: 'qb-btn qb-btn--danger qb-btn--sm', text: service.isNew ? '取消新建' : '删除供应商', type: 'button' })
  remove.addEventListener('click', () => void removeProvider())

  updateLocal(draft, refs)
  validateHeaders()

  return h(
    'div',
    { class: 'qb-card provider-detail' },
    h(
      'div',
      { class: 'provider-head' },
      h(
        'div',
        { class: 'provider-head-main' },
        h('div', { class: 'provider-title-row' }, title, enabledBadge, keyBadge, dirtyBadge),
        subtitle,
      ),
      h('div', { class: 'actions' }, test, save),
    ),
    h(
      'div',
      { class: 'grid grid-3' },
      field('显示名称', name),
      field('协议', protocol),
      field('超时（毫秒）', timeout, `留空用默认值（${limits.defaultMs}）；${timeoutHint(limits)}`),
    ),
    h('div', { class: 'field provider-url' }, h('label', { text: '接口地址' }), baseUrl, baseHint),
    h(
      'div',
      { class: 'grid' },
      h(
        'div',
        { class: 'field' },
        h('label', { text: 'API Key' }),
        h('div', { class: 'key-row' }, key, clearKey),
        h('span', { class: 'desc', text: '只存在插件 KV 里，页面不回显；不需要认证的接口可以留空。' }),
      ),
      headersBox,
    ),
    h('div', { class: 'switch-row' }, enabledLabel),
    h(
      'div',
      { class: 'save-bar' },
      h('span', { class: 'small subtle', text: '供应商设置不会自动保存；模型改动会立即保存。' }),
      h('div', { class: 'actions' }, remove),
    ),
  )
}

function modelRow(model: ModelConfig): HTMLElement {
  const provider = state.config?.providers.find((item) => item.id === model.provider)
  const config = state.config
  const isDefault = config?.default_model === model.alias
  const toggle = switchInput(model.enabled, (next) => void toggleModel(model, next))
  const test = h('button', { class: 'qb-btn qb-btn--sm', text: '测试', type: 'button' })
  test.addEventListener('click', () => void testModel(model, test))
  const edit = h('button', { class: 'qb-btn qb-btn--sm', text: '编辑', type: 'button' })
  edit.addEventListener('click', () => openModelDialog({ model, providerId: model.provider, onSaved: () => rerenderView() }))
  const remove = h('button', { class: 'qb-btn qb-btn--danger qb-btn--sm', text: '删除', type: 'button' })
  remove.addEventListener('click', () => void deleteModel(model))

  // AstrBot 同款交互：行主体可点进入编辑（右侧操作区的按钮各自 stopPropagation 语义靠 DOM 层级天然隔离）
  const main = h(
    'div',
    { class: 'model-main clickable', attrs: { role: 'button', tabindex: '0', title: '编辑这个模型别名' } },
    h(
      'div',
      { class: 'model-title' },
      h('span', { class: 'model-alias mono', text: model.alias || '—' }),
      isDefault ? badge('默认', 'ok') : null,
      !model.enabled ? badge('已停用', '') : null,
    ),
    h(
      'div',
      { class: 'model-sub' },
      h('span', { class: 'mono small muted', text: model.model || '—' }),
      h('span', { class: 'model-sep', text: '·' }),
      contextBadge(model),
      capabilityBadges(model, provider),
    ),
  )
  main.addEventListener('click', () => openModelDialog({ model, providerId: model.provider, onSaved: () => rerenderView() }))
  main.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      openModelDialog({ model, providerId: model.provider, onSaved: () => rerenderView() })
    }
  })

  return h(
    'div',
    { class: 'model-row' },
    main,
    h('div', { class: 'model-actions' }, h('span', { class: 'small muted', text: model.enabled ? '启用' : '停用' }), toggle, test, edit, remove),
  )
}

function availableSection(): HTMLElement | null {
  const draft = service.draft
  if (!draft || service.availableFor !== draft.id) return null
  const configured = new Set(modelsOf(draft.id).map((item) => item.model))
  const keyword = service.modelSearch.trim().toLowerCase()
  const matches = service.available.filter((name) => !keyword || name.toLowerCase().includes(keyword))
  const candidates = matches.filter((name) => !configured.has(name))
  const shown = candidates.slice(0, AVAILABLE_LIMIT)

  const all = h('button', { class: 'qb-btn qb-btn--sm', text: '全部添加', type: 'button' })
  all.disabled = candidates.length === 0 || service.adding || service.fetching
  all.addEventListener('click', () => void addAllAvailable())

  const grid = h('div', { class: 'available-grid' })
  if (!shown.length) {
    grid.append(h('p', { class: 'small subtle', text: matches.length ? '搜索到的模型都已经添加。' : '上游列表里的模型都已经添加。' }))
  }
  for (const name of shown) {
    const add = h('button', { class: 'available-add', text: '+', type: 'button', title: `添加 ${name}` })
    add.disabled = service.adding
    add.addEventListener('click', () => void addAvailableModel(name, add))
    // AstrBot 同款交互：整条可用模型可点即添加，不只是右侧的 + 号
    const item = h(
      'div',
      {
        class: 'available-item clickable',
        attrs: { role: 'button', ...(service.adding ? {} : { tabindex: '0' }), title: `添加 ${name}` },
      },
      h('span', { class: 'available-name mono', text: name }),
      add,
    )
    const trigger = () => {
      if (service.adding) return
      void addAvailableModel(name, add)
    }
    item.addEventListener('click', (event) => {
      if (event.target === add) return // + 按钮自己的监听器会处理
      trigger()
    })
    item.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        trigger()
      }
    })
    grid.append(item)
  }

  return h(
    'div',
    { class: 'available-box' },
    h(
      'div',
      { class: 'available-head' },
      h(
        'div',
        {},
        h('h3', { text: '上游可用模型' }),
        h('p', { class: 'hint', text: `从接口的 /models 读取，共 ${candidates.length} 个未添加。` }),
      ),
      h('div', { class: 'actions' }, all),
    ),
    grid,
    candidates.length > AVAILABLE_LIMIT ? h('p', { class: 'small subtle', text: `只显示前 ${AVAILABLE_LIMIT} 个，使用搜索缩小范围。` }) : null,
  )
}

function modelsPanel(): HTMLElement {
  const draft = service.draft
  if (!draft) return h('div')
  const all = modelsOf(draft.id)

  // AstrBot 同款语义：供应商设置有未保存修改时，按钮明示「保存并拉取」，把隐式保存摆到台面上
  const dirty = service.isNew || draftDirty()
  const refresh = h('button', { class: 'qb-btn qb-btn--sm', text: service.fetching ? '拉取中…' : dirty ? '保存并拉取' : '刷新上游', type: 'button' })
  refresh.disabled = service.fetching || service.adding
  refresh.addEventListener('click', () => void fetchUpstreamModels())
  const add = h('button', { class: 'qb-btn qb-btn--primary qb-btn--sm', text: '添加模型', type: 'button' })
  add.disabled = service.adding
  add.addEventListener('click', () => void openAddModel())

  const search = h('input', { type: 'search', value: service.modelSearch, placeholder: '筛选别名、上游模型或能力' })
  const rowsBox = h('div')
  const availableBox = h('div')

  const updateLists = () => {
    const keyword = service.modelSearch.trim().toLowerCase()
    const shown = all.filter((model) => {
      if (!keyword) return true
      return [model.alias, model.model, ...(model.capabilities ?? [])].some((value) => value.toLowerCase().includes(keyword))
    })
    const rows = h('div', { class: 'model-list' })
    if (service.isNew || draftDirty()) {
      rows.append(h('div', { class: 'issue warn compact' }, '供应商设置还没保存；拉取上游或添加模型时会先自动保存当前设置（按钮上的「保存并拉取」就是这件事）。'))
    }
    if (!shown.length) {
      rows.append(
        h(
          'p',
          { class: 'small subtle model-empty', text: all.length ? '没有匹配的别名。' : '还没有模型别名。刷新上游列表，或手动添加。' },
        ),
      )
    }
    for (const model of shown) rows.append(modelRow(model))
    rowsBox.replaceChildren(rows)

    const available = availableSection()
    availableBox.replaceChildren(...(available ? [available] : []))
  }
  search.addEventListener('input', () => {
    service.modelSearch = search.value
    updateLists()
  })
  updateLists()

  return h(
    'div',
    { class: 'qb-card model-panel' },
    h(
      'div',
      { class: 'card-head' },
      h(
        'div',
        {},
        h('h3', { text: `模型别名（${all.length}）` }),
        h('p', { class: 'hint', text: '调用方只认别名；启停、编辑和删除会立即保存。' }),
      ),
      h('div', { class: 'actions' }, refresh, add),
    ),
    all.length || service.availableFor === draft.id ? search : null,
    rowsBox,
    availableBox,
  )
}

function emptyWorkbench(): HTMLElement {
  const add = h('button', { class: 'qb-btn qb-btn--primary', text: '从模板添加供应商', type: 'button' })
  add.addEventListener('click', () => void addProvider())
  return h(
    'div',
    { class: 'qb-card empty-workbench' },
    h('h2', { text: '先添加一个供应商' }),
    h('p', { class: 'muted', text: '选一个服务商模板，填上 API Key，保存后就能拉取模型并添加别名。' }),
    h('div', { class: 'actions' }, add),
  )
}

function renderAliases(container: HTMLElement): void {
  const config = state.config
  if (!config) return
  const add = h('button', { class: 'qb-btn qb-btn--primary', text: '添加模型', type: 'button' })
  add.addEventListener('click', () => {
    if (!config.providers.length) {
      void toast('先到「按供应商」里添加供应商', 'warning')
      return
    }
    openModelDialog({ providerId: config.providers[0]!.id, onSaved: () => rerenderView() })
  })

  const search = h('input', { type: 'search', value: service.aliasSearch, placeholder: '筛选别名、供应商或上游模型', class: 'table-search' })
  const tbody = h('tbody')

  const renderRows = () => {
    clear(tbody)
    const keyword = service.aliasSearch.trim().toLowerCase()
    const models = config.models.filter((model) => {
      if (!keyword) return true
      const provider = config.providers.find((item) => item.id === model.provider)
      return [model.alias, model.model, provider?.name, provider?.id]
        .filter((value): value is string => Boolean(value))
        .some((value) => value.toLowerCase().includes(keyword))
    })
    if (!models.length) {
      tbody.append(
        h(
          'tr',
          {},
          h('td', { attrs: { colspan: '8' } }, h('p', { class: 'small subtle', text: keyword ? '没有匹配的别名。' : '还没有模型别名。' })),
        ),
      )
      return
    }
    for (const model of models) {
      const provider = config.providers.find((item) => item.id === model.provider)
      const isDefault = config.default_model === model.alias
      const toggle = switchInput(model.enabled, (next) => void toggleModel(model, next))
      const test = h('button', { class: 'qb-btn qb-btn--sm', text: '测试', type: 'button' })
      test.addEventListener('click', () => void testModel(model, test))
      const edit = h('button', { class: 'qb-btn qb-btn--sm', text: '编辑', type: 'button' })
      edit.addEventListener('click', () => openModelDialog({ model, providerId: model.provider, onSaved: () => rerenderView() }))
      const remove = h('button', { class: 'qb-btn qb-btn--danger qb-btn--sm', text: '删除', type: 'button' })
      remove.addEventListener('click', () => void deleteModel(model))
      const makeDefault = h('button', { class: 'qb-btn qb-btn--ghost qb-btn--sm', text: '设为默认', type: 'button' })
      makeDefault.addEventListener('click', () => void setDefault(model.alias))

      tbody.append(
        h(
          'tr',
          {},
          h('td', {}, h('div', { class: 'model-title' }, h('span', { class: 'mono', text: model.alias || '—' }), !model.enabled ? badge('已停用', '') : null)),
          h('td', {}, isDefault ? badge('默认', 'ok') : makeDefault),
          h('td', {}, h('span', { text: provider?.name || model.provider || '—' }), provider && !provider.enabled ? badge('停用', 'warn') : null),
          h('td', {}, h('span', { class: 'mono small', text: model.model || '—' })),
          h('td', {}, contextBadge(model)),
          h('td', {}, capabilityBadges(model, provider)),
          h('td', {}, toggle),
          h('td', {}, h('div', { class: 'row-actions' }, test, edit, remove)),
        ),
      )
    }
  }
  search.addEventListener('input', () => {
    service.aliasSearch = search.value
    renderRows()
  })
  renderRows()

  const table = h(
    'table',
    {},
    h(
      'thead',
      {},
      h(
        'tr',
        {},
        h('th', { text: '别名' }),
        h('th', { text: '默认' }),
        h('th', { text: '供应商' }),
        h('th', { text: '上游模型' }),
        h('th', { text: '上下文' }),
        h('th', { text: '能力' }),
        h('th', { text: '启用' }),
        h('th', { text: '操作', style: 'text-align:right' }),
      ),
    ),
    tbody,
  )

  container.append(
    h(
      'div',
      { class: 'qb-card' },
      h(
        'div',
        { class: 'card-head' },
        h(
          'div',
          {},
          h('h2', { text: '全部模型别名' }),
          h('p', { class: 'hint', text: '不区分供应商，方便检查全局唯一别名和默认模型。模型操作会立即保存。' }),
        ),
        h('div', { class: 'actions' }, add),
      ),
      config.models.length ? search : null,
      config.models.length
        ? h('div', { class: 'table-wrap', style: 'margin-top:12px' }, table)
        : h('div', { class: 'empty', text: '还没有模型别名。添加一个，再把它设成默认模型。' }),
    ),
  )
}

export function renderService(container: HTMLElement, rerender: () => void): void {
  rerenderView = rerender
  const config = state.config
  if (!config) return

  if (service.selectedId && !service.isNew && !config.providers.some((item) => item.id === service.selectedId)) {
    service.draft = null
    service.base = null
    service.selectedId = null
  }
  if (service.draft && !service.isNew && !draftDirty() && service.baseVersion !== state.version) {
    loadDraft(service.draft.id)
  }
  if (!service.draft && !service.isNew) {
    const target = service.selectedId && config.providers.some((item) => item.id === service.selectedId)
      ? service.selectedId
      : config.providers[0]?.id ?? null
    loadDraft(target)
  }

  container.append(serviceHead())
  if (service.mode === 'aliases') {
    renderAliases(container)
    return
  }
  // 窄屏用下拉选择器代替侧栏（对标 AstrBot 的 provider-sources-mobile-select）
  const mobile = mobileProviderSelect()
  if (mobile) container.append(mobile)
  const workspace = h('div', { class: 'workbench' }, sidebar())
  const main = h('div', { class: 'workbench-main' })
  if (service.draft) {
    main.append(providerCard())
    main.append(modelsPanel())
  } else {
    main.append(emptyWorkbench())
  }
  workspace.append(main)
  container.append(workspace)
}
