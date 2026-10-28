import type { Capability } from '../src/contract.js'
import type { ModelConfig, ProtocolId } from '../src/config/types.js'
import { CAPABILITY_VALUES, capabilitiesOf } from '../src/config/types.js'
import type { MetadataField, MetadataResolution, ModelCatalog } from '../src/modelMetadata.js'
import { resolveModelMetadata, withMetadata } from '../src/modelMetadata.js'
import { toast } from './api.js'
import { field, h } from './dom.js'
import { catalogProviderFor, loadModelCatalog } from './modelCatalog.js'
import { aliasBase } from './providerDraft.js'
import { updateConfig } from './save.js'
import { state } from './state.js'
import type { AppConfigDraft } from './types.js'
import { clone, uniqueAlias } from './types.js'

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

const ALIAS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,39}$/

export interface ModelDialogOptions {
  model?: ModelConfig
  providerId?: string
  onSaved?: () => void
}

function readNumber(input: HTMLInputElement, allowZero: boolean, integer: boolean): number | undefined | null {
  if (!input.value.trim()) return undefined
  const value = Number(input.value)
  if (!Number.isFinite(value) || value < 0) return null
  if (!allowZero && value === 0) return null
  if (integer && !Number.isInteger(value)) return null
  return value
}

function switchControl(checked: boolean): HTMLInputElement {
  return h('input', { type: 'checkbox', checked })
}

function switchLabel(box: HTMLInputElement, text: string): HTMLElement {
  return h('label', { class: 'switch' }, box, h('span', { class: 'switch-track' }), h('span', { class: 'switch-text', text }))
}

export function openModelDialog(options: ModelDialogOptions): void {
  const current = state.config
  if (!current) return
  const config: AppConfigDraft = current
  if (config.providers.length === 0) {
    void toast('先添加一个供应商', 'warning')
    return
  }

  const existing = options.model
  /**
   * 打开弹窗时的定位键：保存时用它精确 findIndex。
   * 不能用输入框里的值定位——用户可能同时改了别名和供应商，那样就找不到原记录，
   * 只能退化成 push，结果一个模型变成两条。
   */
  const originalAlias = existing?.alias
  const originalProvider = existing?.provider
  const preferred = options.providerId && config.providers.some((item) => item.id === options.providerId)
    ? options.providerId
    : config.providers[0]!.id
  const draft: ModelConfig = existing
    ? clone(existing)
    : { alias: '', provider: preferred, model: '', enabled: true }

  const protocolOf = (): ProtocolId => config.providers.find((item) => item.id === draft.provider)?.protocol ?? 'openai'
  let caps = new Set<Capability>(draft.capabilities?.length ? draft.capabilities : capabilitiesOf(protocolOf()))
  caps.add('text')
  let aliasTouched = Boolean(existing)

  const provider = h('select')
  if (draft.provider && !config.providers.some((item) => item.id === draft.provider)) {
    provider.append(h('option', { value: draft.provider, text: `${draft.provider}（不存在）`, selected: true }))
  }
  for (const item of config.providers) {
    provider.append(h('option', { value: item.id, text: item.name || item.id, selected: item.id === draft.provider }))
  }

  const upstream = h('input', { value: draft.model, placeholder: '例如 deepseek-chat' })
  const alias = h('input', { value: draft.alias, placeholder: '留空会自动生成' })
  const contextWindow = h('input', { type: 'number', attrs: { min: '1', max: '10000000', step: '1' }, value: draft.context_window ?? '', placeholder: '如 128000' })
  const maxOutput = h('input', { type: 'number', attrs: { min: '1', max: '1000000', step: '1' }, value: draft.max_output_tokens ?? '', placeholder: '如 8192' })
  const maxTokens = h('input', { type: 'number', attrs: { min: '1', max: '131072', step: '1' }, value: draft.max_tokens ?? '', placeholder: '默认' })
  const temperature = h('input', { type: 'number', attrs: { min: '0', max: '2', step: '0.1' }, value: draft.temperature ?? '', placeholder: '默认' })
  const enabled = switchControl(draft.enabled)
  const capBox = h('div', { class: 'chip-row' })

  const metaText = h('div', { class: 'small muted' })
  const metaActions = h('div', { class: 'metadata-actions' })
  const metaBox = h('div', { class: 'metadata-hint', style: 'display:none' }, metaText, metaActions)

  let lookupTimer: number | undefined
  let lookupSeq = 0

  function renderCaps(): void {
    const protocol = protocolOf()
    if (protocol !== 'openai') caps.delete('json')
    caps.add('text')
    capBox.replaceChildren()
    for (const capability of CAPABILITY_VALUES) {
      const disabled = capability === 'text' || (capability === 'json' && protocol !== 'openai')
      const chip = h('button', {
        class: `chip${caps.has(capability) ? ' active' : ''}`,
        type: 'button',
        text: LABELS[capability],
        disabled,
        title: capability === 'json' && protocol !== 'openai' ? '仅 OpenAI 兼容协议可用' : undefined,
      })
      if (!disabled) {
        chip.addEventListener('click', () => {
          if (caps.has(capability)) caps.delete(capability)
          else caps.add(capability)
          draft.capabilities = CAPABILITY_VALUES.filter((item) => caps.has(item))
          renderCaps()
        })
      }
      capBox.append(chip)
    }
  }

  function applyResolution(resolution: MetadataResolution, overwrite: boolean): void {
    const fillCapabilities = overwrite || !draft.capabilities?.length
    const next = withMetadata(draft, resolution.metadata, protocolOf(), overwrite, fillCapabilities)
    draft.context_window = next.context_window
    draft.max_output_tokens = next.max_output_tokens
    contextWindow.value = next.context_window !== undefined ? String(next.context_window) : ''
    maxOutput.value = next.max_output_tokens !== undefined ? String(next.max_output_tokens) : ''
    if (fillCapabilities) {
      caps = new Set(next.capabilities?.length ? next.capabilities : capabilitiesOf(protocolOf()))
      caps.add('text')
      renderCaps()
    }
  }

  function scopeOf(catalog: ModelCatalog): string | undefined {
    const selected = config.providers.find((item) => item.id === draft.provider)
    return selected ? catalogProviderFor(selected, catalog) : undefined
  }

  function sourceControls(catalog: ModelCatalog, resolution: MetadataResolution, modelId: string): void {
    metaActions.replaceChildren()
    const retry = h('button', { class: 'btn ghost small', text: '重新获取', type: 'button' })
    retry.addEventListener('click', () => {
      window.clearTimeout(lookupTimer)
      lookupSeq += 1
      void lookup(modelId, lookupSeq, true)
    })
    metaActions.append(retry)
    if (resolution.sources.length <= 1) return

    const source = h('select')
    source.append(h('option', { value: '', text: '选择来源' }))
    for (const item of resolution.sources) source.append(h('option', { value: item, text: item }))
    const apply = h('button', { class: 'btn small', text: '按来源填充', type: 'button' })
    apply.addEventListener('click', () => {
      if (!source.value) {
        void toast('先选择一个来源', 'warning')
        return
      }
      const scoped = resolveModelMetadata(catalog, modelId, source.value)
      if (!scoped) {
        void toast(`目录里找不到 ${source.value} 下的这个模型`, 'warning')
        return
      }
      // 用户选来源就是为了覆盖冲突字段：来源缺失的字段清空，而不是残留其他来源的旧值
      draft.context_window = undefined
      draft.max_output_tokens = undefined
      contextWindow.value = ''
      maxOutput.value = ''
      applyResolution(scoped, true)
      const filled: string[] = []
      if (draft.context_window !== undefined) filled.push('上下文')
      if (draft.max_output_tokens !== undefined) filled.push('输出上限')
      filled.push('能力')
      metaText.textContent = `已按 ${source.value} 覆盖${filled.join('、')}；该来源没有的字段已清空，可继续手动调整。`
    })
    metaActions.append(source, apply)
  }

  function showResolution(catalog: ModelCatalog, resolution: MetadataResolution, modelId: string): void {
    applyResolution(resolution, false)
    metaBox.style.display = ''
    const conflicts = resolution.conflicts.map((item) => FIELD_LABELS[item]).join('、')
    if (resolution.sources.length > 1) {
      metaText.textContent = conflicts
        ? `同名模型匹配到 ${resolution.sources.length} 个来源，${conflicts}不一致，未自动填入；可手动填写或选一个来源。`
        : `同名模型匹配到 ${resolution.sources.length} 个来源，信息一致，已自动填入。`
    } else {
      metaText.textContent = conflicts
        ? `来源 ${resolution.sources[0] ?? '目录'} 的${conflicts}不完整，未自动填入，请手动填写。`
        : `已从 ${resolution.sources[0] ?? '目录'} 读取模型信息；已有值不会被覆盖。`
    }
    sourceControls(catalog, resolution, modelId)
  }

  async function lookup(modelId: string, seq: number, manual: boolean): Promise<void> {
    const id = modelId.trim()
    if (!id) return
    metaBox.style.display = ''
    metaText.textContent = '正在查询 models.dev…'
    metaActions.replaceChildren()
    try {
      const catalog = await loadModelCatalog()
      if (seq !== lookupSeq) return
      const resolution = resolveModelMetadata(catalog, id, scopeOf(catalog))
      if (!resolution) {
        metaText.textContent = 'models.dev 里没有这个模型，可以手动填写；保存时会按协议默认能力处理。'
        sourceControls(catalog, { metadata: { id }, conflicts: [], sources: [] }, id)
        if (manual) await toast('模型目录里没有这个模型', 'warning')
        return
      }
      showResolution(catalog, resolution, id)
      if (manual) {
        await toast(resolution.conflicts.length ? '已填入一致的信息，冲突字段请确认' : '已更新模型信息', 'success')
      }
    } catch (err) {
      if (seq !== lookupSeq) return
      metaText.textContent = '模型目录获取失败，可以手动填写。'
      sourceControls(catalogPlaceholder(), { metadata: { id }, conflicts: [], sources: [] }, id)
      if (manual) await toast(`获取模型信息失败：${err instanceof Error ? err.message : String(err)}`, 'error')
    }
  }

  function scheduleLookup(): void {
    window.clearTimeout(lookupTimer)
    lookupSeq += 1
    metaBox.style.display = 'none'
    metaText.textContent = ''
    metaActions.replaceChildren()
    const id = upstream.value.trim()
    if (!id) return
    const seq = lookupSeq
    metaBox.style.display = ''
    metaText.textContent = '正在查询 models.dev…'
    lookupTimer = window.setTimeout(() => void lookup(id, seq, false), 450)
  }

  function syncAlias(): void {
    if (aliasTouched || existing) return
    const id = upstream.value.trim()
    if (!id) return
    alias.value = uniqueAlias(config.models, aliasBase(id))
  }

  upstream.addEventListener('input', () => {
    syncAlias()
    scheduleLookup()
  })
  alias.addEventListener('input', () => {
    aliasTouched = true
  })
  provider.addEventListener('change', () => {
    draft.provider = provider.value
    renderCaps()
    scheduleLookup()
  })
  contextWindow.addEventListener('input', () => {
    const value = readNumber(contextWindow, false, true)
    draft.context_window = typeof value === 'number' ? value : undefined
  })
  maxOutput.addEventListener('input', () => {
    const value = readNumber(maxOutput, false, true)
    draft.max_output_tokens = typeof value === 'number' ? value : undefined
  })

  renderCaps()

  /**
   * 保存状态机：保存开始后锁住所有关闭路径（取消按钮、右上角关闭、Esc 的 cancel 事件），
   * 直到 PUT 结束。否则用户能在请求飞行中关掉弹窗，再打开一次改同一个模型，
   * 后到的响应把两次编辑按旧版本号写回，或者让「已保存」提示落在已销毁的弹窗上。
   */
  let saving = false

  const closeButton = h('button', { class: 'btn ghost small', text: '关闭', type: 'button' })
  const cancelButton = h('button', { class: 'btn', text: '取消', type: 'button' })
  const setSaving = (next: boolean): void => {
    saving = next
    closeButton.disabled = next
    cancelButton.disabled = next
  }

  const dialog = h(
    'dialog',
    { class: 'model-dialog' },
    h(
      'div',
      { class: 'dialog-body' },
      h(
        'div',
        { class: 'dialog-head' },
        h('div', {}, h('h2', { text: existing ? '编辑模型' : '添加模型' }), h('p', { class: 'hint', text: '保存后立即同步给其他插件。' })),
        closeButton,
      ),
      h(
        'div',
        { class: 'grid grid-3' },
        field('供应商', provider),
        field('上游模型', upstream),
        field('别名', alias, '调用方使用的名字，全局唯一'),
      ),
      metaBox,
      h(
        'div',
        { class: 'grid', style: 'margin-top:12px' },
        field('上下文窗口', contextWindow, 'tokens；未知可留空'),
        field('模型输出上限', maxOutput, 'tokens；未知可留空'),
      ),
      h(
        'div',
        { class: 'field', style: 'margin-top:12px' },
        h('label', { text: '能力' }),
        capBox,
        h('span', { class: 'desc', text: '点击切换；JSON 仅 OpenAI 兼容协议可用。' }),
      ),
      h(
        'details',
        { class: 'advanced' },
        h('summary', { text: '请求默认值' }),
        h(
          'div',
          { class: 'grid' },
          field('默认 max_tokens', maxTokens, '调用方不传时使用，可被覆盖'),
          field('默认温度', temperature, '0–2，留空用上游默认'),
        ),
      ),
      h('div', { class: 'switch-row' }, switchLabel(enabled, '启用这个别名')),
    ),
    h(
      'div',
      { class: 'dialog-actions' },
      h('span', { class: 'small subtle', text: '模型改动会自动保存' }),
      h('div', { style: 'flex:1' }),
      cancelButton,
      (() => {
        const save = h('button', { class: 'btn primary', text: '保存并应用', type: 'button' })
        save.addEventListener('click', async () => {
          if (saving) return
          let nextAlias = alias.value.trim()
          const nextModel = upstream.value.trim()
          // README 承诺「留空会按模型名自动生成」：手动清空后保存同样回填，
          // 而不是只在输入上游模型名时实时同步（syncAlias 只在 aliasTouched=false 时跑）
          if (!nextAlias && nextModel) {
            nextAlias = uniqueAlias(config.models, aliasBase(nextModel))
            alias.value = nextAlias
          }
          if (!nextAlias) {
            await toast('模型别名不能为空：请填写别名或上游模型名', 'warning')
            return
          }
          if (!ALIAS_PATTERN.test(nextAlias)) {
            await toast('别名只能用字母、数字、.、_、:、-，且以字母或数字开头', 'warning')
            return
          }
          if (config.models.some((item) => item.alias === nextAlias && item !== existing)) {
            await toast(`模型别名 ${nextAlias} 已存在`, 'warning')
            return
          }
          if (!nextModel) {
            await toast('上游模型名不能为空', 'warning')
            return
          }
          if (!config.providers.some((item) => item.id === draft.provider)) {
            await toast('供应商不存在，请重新选择', 'warning')
            return
          }
          const tokens = readNumber(maxTokens, false, true)
          const temp = readNumber(temperature, true, false)
          const context = readNumber(contextWindow, false, true)
          const output = readNumber(maxOutput, false, true)
          if (tokens === null || temp === null || context === null || output === null) {
            await toast('数值不合法', 'warning')
            return
          }
          if (tokens !== undefined && tokens > (state.meta?.limits.max_tokens_max ?? 131072)) {
            await toast('默认 max_tokens 超出上限', 'warning')
            return
          }
          if (temp !== undefined && temp > 2) {
            await toast('温度应在 0–2 之间', 'warning')
            return
          }
          if (context !== undefined && context > 10_000_000) {
            await toast('上下文窗口超出上限', 'warning')
            return
          }
          if (output !== undefined && output > 1_000_000) {
            await toast('模型输出上限超出上限', 'warning')
            return
          }

          const next: ModelConfig = {
            alias: nextAlias,
            provider: draft.provider,
            model: nextModel,
            enabled: enabled.checked,
            capabilities: CAPABILITY_VALUES.filter((item) => caps.has(item)),
          }
          if (tokens !== undefined) next.max_tokens = tokens
          if (temp !== undefined) next.temperature = temp
          if (context !== undefined) next.context_window = context
          if (output !== undefined) next.max_output_tokens = output

          // 打开弹窗时的记录还在不在？不在说明别处已经删掉/改掉了这个模型，
          // 此时再 push 会凭空多出一条，所以提示用户刷新。
          const stillThere =
            !existing ||
            (originalAlias !== undefined &&
              state.config?.models.some(
                (item) => item.alias === originalAlias && item.provider === originalProvider,
              ) === true)
          if (!stillThere) {
            await toast('这个模型已被别处修改，请刷新后重试', 'error')
            dialog.close()
            return
          }

          setSaving(true)
          save.disabled = true
          save.textContent = '保存中…'
          let stale = false
          let ok = false
          try {
            ok = await updateConfig(
              (target) => {
                if (existing) {
                  // 用打开弹窗时记录的原始 alias + provider 定位；输入框里的值可能已经被改过
                  const index = target.models.findIndex(
                    (item) => item.alias === originalAlias && item.provider === originalProvider,
                  )
                  if (index < 0) {
                    stale = true
                    return
                  }
                  target.models[index] = clone(next)
                  if (target.default_model === originalAlias && originalAlias !== next.alias) target.default_model = next.alias
                } else {
                  target.models.push(clone(next))
                  if (!target.default_model) target.default_model = next.alias
                }
              },
              { success: existing ? '模型已更新' : '模型已添加' },
            )
          } finally {
            setSaving(false)
            save.disabled = false
            save.textContent = '保存并应用'
          }
          if (stale) {
            await toast('这个模型已被别处修改，请刷新后重试', 'error')
            dialog.close()
            return
          }
          if (!ok) return
          // 先关弹窗再回调：回调会触发整页重渲染，弹窗先关掉避免闪一下
          dialog.close()
          options.onSaved?.()
        })
        return save
      })(),
    ),
  )

  closeButton.addEventListener('click', () => {
    if (saving) return
    dialog.close()
  })
  cancelButton.addEventListener('click', () => {
    if (saving) return
    dialog.close()
  })
  // Esc / 浏览器默认关闭走 cancel 事件；保存中拦掉，避免请求飞行中弹窗消失
  dialog.addEventListener('cancel', (event) => {
    if (!saving) return
    event.preventDefault()
  })
  dialog.addEventListener('close', () => {
    window.clearTimeout(lookupTimer)
    dialog.remove()
  })
  document.body.append(dialog)
  dialog.showModal()
  scheduleLookup()
}

function catalogPlaceholder(): ModelCatalog {
  return { providers: new Map(), models: new Map() }
}
