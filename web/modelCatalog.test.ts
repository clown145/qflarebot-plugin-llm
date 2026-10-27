import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveModelMetadata } from '../src/modelMetadata.js'
import {
  CATALOG_TIMEOUT_MS,
  CATALOG_TOTAL_BUDGET_MS,
  buildCatalog,
  catalogProviderFor,
  loadModelCatalog,
} from './modelCatalog.js'

describe('buildCatalog', () => {
  it('保留同名模型在不同供应商下的全部候选', () => {
    const catalog = buildCatalog({
      openai: { id: 'openai', models: { 'gpt-x': { id: 'gpt-x', limit: { context: 128000 } } } },
      other: { id: 'other', models: { 'gpt-x': { id: 'gpt-x', limit: { context: 64000 } } } },
    })
    const resolution = resolveModelMetadata(catalog, 'gpt-x')
    expect(resolution?.sources).toEqual(['openai', 'other'])
    expect(resolution?.conflicts).toContain('context_window')
  })

  it('供应商同时用顶层 key 和对象 id 索引', () => {
    const catalog = buildCatalog({ alias: { id: 'real', models: { m: { id: 'm' } } } })
    expect(catalog.providers.get('alias')?.get('m')?.id).toBe('m')
    expect(catalog.providers.get('real')?.get('m')?.id).toBe('m')
    expect(resolveModelMetadata(catalog, 'm', 'alias')?.sources).toEqual(['alias'])
  })

  it('模型对象 key 与 id 不同时两个名字都能查', () => {
    const catalog = buildCatalog({ p: { models: { 'alias-model': { id: 'vendor-model' } } } })
    expect(catalog.models.get('vendor-model')).toHaveLength(1)
    expect(catalog.models.get('alias-model')).toHaveLength(1)
    expect(resolveModelMetadata(catalog, 'alias-model')?.metadata.id).toBe('vendor-model')
  })

  it('忽略缺少 models 的供应商，非法输入直接报错', () => {
    const catalog = buildCatalog({ empty: { id: 'empty' }, p: { models: { m: { id: 'm' } } } })
    expect(catalog.providers.has('empty')).toBe(false)
    expect(resolveModelMetadata(catalog, 'm')?.sources).toEqual(['p'])
    expect(() => buildCatalog('nope')).toThrow()
  })
})

describe('catalogProviderFor', () => {
  const catalog = buildCatalog({
    deepseek: { id: 'deepseek', models: { 'deepseek-chat': { id: 'deepseek-chat' } } },
    openai: { id: 'openai', models: { 'gpt-x': { id: 'gpt-x' } } },
  })

  it('优先使用与配置相同的供应商 id', () => {
    expect(catalogProviderFor({ id: 'deepseek', base_url: 'https://proxy.example/v1' }, catalog)).toBe('deepseek')
  })

  it('按常见接口域名推断目录供应商', () => {
    expect(catalogProviderFor({ id: 'my-ds', base_url: 'https://api.deepseek.com/v1' }, catalog)).toBe('deepseek')
    expect(catalogProviderFor({ id: 'relay', base_url: 'https://relay.api.openai.com/v1' }, catalog)).toBe('openai')
  })

  it('无法推断或地址非法时返回 undefined', () => {
    expect(catalogProviderFor({ id: 'custom', base_url: 'https://llm.example.com/v1' }, catalog)).toBeUndefined()
    expect(catalogProviderFor({ id: 'custom', base_url: 'not a url' }, catalog)).toBeUndefined()
  })
})
