import { describe, expect, it } from 'vitest'
import { createDefaultConfig } from './config/defaults.js'
import type { ModelConfig } from './config/types.js'
import type { CatalogEntry, ModelCatalog, ModelMetadata } from './modelMetadata.js'
import { capabilitiesFromMetadata, resolveModelMetadata, withMetadata } from './modelMetadata.js'

const vision: ModelMetadata = {
  id: 'vision-model',
  reasoning: true,
  tool_call: true,
  modalities: { input: ['text', 'image', 'audio'], output: ['text'] },
  limit: { context: 200000, output: 8192 },
}

function model(): ModelConfig {
  return {
    alias: 'chat',
    provider: 'p',
    model: 'vision-model',
    enabled: true,
  }
}

function catalogOf(entries: Record<string, Record<string, ModelMetadata>>): ModelCatalog {
  const providers = new Map<string, Map<string, ModelMetadata>>()
  const models = new Map<string, CatalogEntry[]>()
  for (const [provider, modelMap] of Object.entries(entries)) {
    const scoped = new Map<string, ModelMetadata>()
    for (const [id, metadata] of Object.entries(modelMap)) {
      scoped.set(id, metadata)
      const list = models.get(id)
      if (!list) models.set(id, [{ provider, metadata }])
      else if (!list.some((item) => item.provider === provider && item.metadata.id === metadata.id)) {
        list.push({ provider, metadata })
      }
    }
    providers.set(provider, scoped)
  }
  return { providers, models }
}

describe('capabilitiesFromMetadata', () => {
  it('把 modalities / tool_call / reasoning 映射成能力', () => {
    expect(capabilitiesFromMetadata(vision, 'openai')).toEqual(['text', 'image', 'audio', 'tools', 'json', 'reasoning'])
  })

  it('Anthropic 默认没有 json', () => {
    expect(capabilitiesFromMetadata({ ...vision, tool_call: true }, 'anthropic')).toEqual(['text', 'image', 'audio', 'tools', 'reasoning'])
  })

  it('tool_call 缺失时沿用协议默认，明确为 false 时不加 tools', () => {
    expect(capabilitiesFromMetadata({ id: 'm' }, 'openai')).toContain('tools')
    expect(capabilitiesFromMetadata({ id: 'm', tool_call: false }, 'openai')).not.toContain('tools')
  })
})

describe('withMetadata', () => {
  it('只填空字段', () => {
    const next = withMetadata({ ...model(), context_window: 1000 }, vision, 'openai')
    expect(next.context_window).toBe(1000)
    expect(next.max_output_tokens).toBe(8192)
    expect(next.capabilities).toContain('image')
  })

  it('overwrite 时覆盖已有值', () => {
    const next = withMetadata({ ...model(), context_window: 1000, max_output_tokens: 100 }, vision, 'openai', true)
    expect(next.context_window).toBe(200000)
    expect(next.max_output_tokens).toBe(8192)
  })

  it('没有目录值时保留原字段', () => {
    const next = withMetadata(model(), { id: 'm' }, 'openai')
    expect(next.context_window).toBeUndefined()
    expect(next.max_output_tokens).toBeUndefined()
    expect(next.capabilities).toEqual(['text', 'tools', 'json'])
  })

  it('fillCapabilities=false 时不写能力', () => {
    const next = withMetadata(model(), vision, 'openai', false, false)
    expect(next.capabilities).toBeUndefined()
    expect(next.context_window).toBe(200000)
  })
})

describe('resolveModelMetadata', () => {
  it('没有候选时返回 undefined', () => {
    expect(resolveModelMetadata(catalogOf({}), 'nope')).toBeUndefined()
  })

  it('精确匹配，并兼容 provider/model 前缀', () => {
    const catalog = catalogOf({ openrouter: { 'vision-model': vision } })
    expect(resolveModelMetadata(catalog, 'vision-model')).toEqual({ metadata: vision, conflicts: [], sources: ['openrouter'] })
    expect(resolveModelMetadata(catalog, 'openrouter/vision-model')).toEqual({ metadata: vision, conflicts: [], sources: ['openrouter'] })
  })

  it('指定供应商时优先用该供应商的数据，不受同名冲突影响', () => {
    const other: ModelMetadata = { ...vision, limit: { context: 1000, output: 100 }, reasoning: false }
    const catalog = catalogOf({ openai: { 'vision-model': vision }, other: { 'vision-model': other } })
    const resolution = resolveModelMetadata(catalog, 'vision-model', 'openai')
    expect(resolution).toEqual({ metadata: vision, conflicts: [], sources: ['openai'] })
  })

  it('指定的供应商不存在时退回全局候选', () => {
    const catalog = catalogOf({ openai: { 'vision-model': vision } })
    expect(resolveModelMetadata(catalog, 'vision-model', 'provider-1')).toEqual({ metadata: vision, conflicts: [], sources: ['openai'] })
  })

  it('同名候选完全一致时合并并填入全部字段', () => {
    const catalog = catalogOf({ openai: { 'vision-model': vision }, openrouter: { 'vision-model': { ...vision } } })
    const resolution = resolveModelMetadata(catalog, 'vision-model')
    expect(resolution?.conflicts).toEqual([])
    expect(resolution?.sources).toEqual(['openai', 'openrouter'])
    expect(resolution?.metadata.limit).toEqual({ context: 200000, output: 8192 })
    expect(resolution?.metadata.reasoning).toBe(true)
  })

  it('同名候选冲突时只保留一致字段，并标记冲突', () => {
    const other: ModelMetadata = {
      id: 'vision-model',
      reasoning: false,
      tool_call: true,
      modalities: { input: ['text', 'image'], output: ['text'] },
      limit: { context: 100000, output: 8192 },
    }
    const catalog = catalogOf({ openai: { 'vision-model': vision }, other: { 'vision-model': other } })
    const resolution = resolveModelMetadata(catalog, 'vision-model')
    expect(resolution?.conflicts).toEqual(['context_window', 'capabilities'])
    expect(resolution?.sources).toEqual(['openai', 'other'])
    expect(resolution?.metadata.limit).toEqual({ output: 8192 })
    expect(resolution?.metadata.reasoning).toBeUndefined()
    expect(resolution?.metadata.modalities).toBeUndefined()
  })

  it('一个候选缺少上限、另一个有时也算冲突', () => {
    const catalog = catalogOf({
      a: { m: { id: 'm', limit: { context: 1000 } } },
      b: { m: { id: 'm' } },
    })
    expect(resolveModelMetadata(catalog, 'm')?.conflicts).toEqual(['context_window'])
  })

  it('默认配置不受影响', () => {
    expect(createDefaultConfig().models).toEqual([])
  })
})
