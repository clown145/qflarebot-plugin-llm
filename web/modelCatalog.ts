/** 浏览器侧拉取 models.dev 目录；不经过 Worker，避免解析 5.9 MB JSON 的 CPU。 */

import { isRecord } from '../src/json.js'
import type { CatalogEntry, ModelCatalog, ModelMetadata } from '../src/modelMetadata.js'

const URLS = ['https://models.dev/api.json', 'https://models.opencode.ai/api.json']
/**
 * 目录只用来补全上下文窗口 / 能力，是「有更好、没有也能保存」的辅助数据。
 * 以前两个地址各 20 秒，最坏要等 40 秒才失败；现在总共只有 10 秒预算，
 * 每个地址最多 5 秒，前一个失败立刻试下一个，整体不会超过总预算。
 */
export const CATALOG_TIMEOUT_MS = 5000
export const CATALOG_TOTAL_BUDGET_MS = 10000

let cache: Promise<ModelCatalog> | undefined

export function loadModelCatalog(): Promise<ModelCatalog> {
  cache ??= fetchCatalog().catch((err: unknown) => {
    cache = undefined
    throw err
  })
  return cache
}

async function fetchCatalog(): Promise<ModelCatalog> {
  const deadline = Date.now() + CATALOG_TOTAL_BUDGET_MS
  let last: unknown
  for (const url of URLS) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      last = new Error('模型目录获取超时')
      break
    }
    try {
      return await fetchOne(url, Math.min(CATALOG_TIMEOUT_MS, remaining))
    } catch (err) {
      last = err
    }
  }
  throw last instanceof Error ? last : new Error('模型目录获取失败')
}

async function fetchOne(url: string, timeoutMs: number): Promise<ModelCatalog> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    })
    if (!response.ok) throw new Error(`模型目录返回 HTTP ${response.status}`)
    return buildCatalog(await response.json())
  } finally {
    clearTimeout(timer)
  }
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out = value.filter((item): item is string => typeof item === 'string')
  return out.length ? out : undefined
}

function positive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

function toMetadata(id: string, value: Record<string, unknown>): ModelMetadata {
  const metadata: ModelMetadata = { id }
  if (typeof value['reasoning'] === 'boolean') metadata.reasoning = value['reasoning']
  if (typeof value['tool_call'] === 'boolean') metadata.tool_call = value['tool_call']

  const modalities = value['modalities']
  if (isRecord(modalities)) {
    const input = stringList(modalities['input'])
    const output = stringList(modalities['output'])
    if (input || output) {
      metadata.modalities = {
        ...(input ? { input } : {}),
        ...(output ? { output } : {}),
      }
    }
  }

  const limit = value['limit']
  if (isRecord(limit)) {
    const context = positive(limit['context'])
    const output = positive(limit['output'])
    if (context !== undefined || output !== undefined) {
      metadata.limit = {
        ...(context !== undefined ? { context } : {}),
        ...(output !== undefined ? { output } : {}),
      }
    }
  }

  return metadata
}

/** 保留供应商维度；同一个模型 id 在不同供应商下会留下多个候选 */
const HOST_PROVIDERS: ReadonlyArray<readonly [string, string]> = [
  ['api.openai.com', 'openai'],
  ['api.anthropic.com', 'anthropic'],
  ['generativelanguage.googleapis.com', 'google'],
  ['api.deepseek.com', 'deepseek'],
  ['openrouter.ai', 'openrouter'],
  ['api.moonshot.cn', 'moonshotai'],
  ['api.moonshot.ai', 'moonshotai'],
  ['open.bigmodel.cn', 'zhipuai'],
  ['api.z.ai', 'zai'],
  ['dashscope.aliyuncs.com', 'alibaba'],
  ['dashscope-intl.aliyuncs.com', 'alibaba'],
  ['api.siliconflow.cn', 'siliconflow'],
  ['api.siliconflow.com', 'siliconflow'],
  ['api.mistral.ai', 'mistral'],
  ['api.groq.com', 'groq'],
  ['api.x.ai', 'xai'],
  ['api.together.xyz', 'togetherai'],
  ['api.fireworks.ai', 'fireworks-ai'],
  ['api.perplexity.ai', 'perplexity'],
]

/**
 * 配置里的供应商 id 是用户自己起的，models.dev 用固定 id。
 * 先认同名 id，再按常见接口域名推断；推断不到就让调用方退回全局同名候选。
 */
export function catalogProviderFor(provider: { id: string; base_url: string }, catalog: ModelCatalog): string | undefined {
  if (catalog.providers.has(provider.id)) return provider.id
  let host = ''
  try {
    host = new URL(provider.base_url).hostname.toLowerCase()
  } catch {
    return undefined
  }
  for (const [domain, id] of HOST_PROVIDERS) {
    if (host === domain || host.endsWith(`.${domain}`)) return id
  }
  return undefined
}

export function buildCatalog(data: unknown): ModelCatalog {
  if (!isRecord(data)) throw new Error('模型目录格式不正确')

  const providers = new Map<string, Map<string, ModelMetadata>>()
  const models = new Map<string, CatalogEntry[]>()

  const addModel = (key: string, entry: CatalogEntry): void => {
    const list = models.get(key)
    if (!list) {
      models.set(key, [entry])
      return
    }
    if (list.some((item) => item.provider === entry.provider && item.metadata.id === entry.metadata.id)) return
    list.push(entry)
  }

  for (const [key, provider] of Object.entries(data)) {
    if (!isRecord(provider) || !isRecord(provider['models'])) continue
    const providerId = typeof provider['id'] === 'string' && provider['id'] ? provider['id'] : key
    const providerModels = new Map<string, ModelMetadata>()

    for (const [modelKey, value] of Object.entries(provider['models'])) {
      if (!isRecord(value)) continue
      const id = typeof value['id'] === 'string' && value['id'] ? value['id'] : modelKey
      if (!id) continue

      const metadata = toMetadata(id, value)
      providerModels.set(id, metadata)
      if (modelKey !== id) providerModels.set(modelKey, metadata)

      const entry: CatalogEntry = { provider: providerId, metadata }
      addModel(id, entry)
      if (modelKey !== id) addModel(modelKey, entry)
    }

    providers.set(key, providerModels)
    if (providerId !== key) providers.set(providerId, providerModels)
  }

  return { providers, models }
}
