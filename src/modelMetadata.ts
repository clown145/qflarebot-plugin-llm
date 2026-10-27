/** 模型目录（models.dev）到模型配置的纯映射，不依赖网络，方便单测。 */

import type { Capability } from './contract.js'
import { CAPABILITY_VALUES, capabilitiesOf, type ModelConfig, type ProtocolId } from './config/types.js'

export interface ModelMetadata {
  id: string
  reasoning?: boolean
  tool_call?: boolean
  modalities?: {
    input?: string[]
    output?: string[]
  }
  limit?: {
    context?: number
    output?: number
  }
}

export interface CatalogEntry {
  provider: string
  metadata: ModelMetadata
}

/** models.dev 的目录结构：供应商 -> 模型；同名模型保留全部候选，不再后写覆盖 */
export interface ModelCatalog {
  providers: ReadonlyMap<string, ReadonlyMap<string, ModelMetadata>>
  models: ReadonlyMap<string, readonly CatalogEntry[]>
}

export type MetadataField = 'context_window' | 'max_output_tokens' | 'capabilities'

export interface MetadataResolution {
  metadata: ModelMetadata
  /** 同名候选之间不一致、未自动填充的字段 */
  conflicts: MetadataField[]
  /** 实际命中的供应商 id */
  sources: string[]
}

/** 目录数据只作为默认值：metadata 缺失时沿用协议默认能力 */
export function capabilitiesFromMetadata(metadata: ModelMetadata, protocol: ProtocolId): Capability[] {
  const caps = new Set<Capability>(['text'])
  const inputs = metadata.modalities?.input ?? []
  if (inputs.includes('image')) caps.add('image')
  if (inputs.includes('audio')) caps.add('audio')

  const tools = metadata.tool_call ?? capabilitiesOf(protocol).includes('tools')
  if (tools) caps.add('tools')
  if (metadata.reasoning) caps.add('reasoning')
  if (capabilitiesOf(protocol).includes('json')) caps.add('json')

  return CAPABILITY_VALUES.filter((item) => caps.has(item))
}

/** 只填空白字段；overwrite=true 时用目录值覆盖，供“刷新元数据”使用 */
export function withMetadata(
  model: ModelConfig,
  metadata: ModelMetadata,
  protocol: ProtocolId,
  overwrite = false,
  fillCapabilities = true,
): ModelConfig {
  const next: ModelConfig = { ...model }
  const context = metadata.limit?.context
  const output = metadata.limit?.output
  if (context !== undefined && context > 0 && (overwrite || next.context_window === undefined)) {
    next.context_window = context
  }
  if (output !== undefined && output > 0 && (overwrite || next.max_output_tokens === undefined)) {
    next.max_output_tokens = output
  }
  if (fillCapabilities && (overwrite || !next.capabilities?.length)) {
    next.capabilities = capabilitiesFromMetadata(metadata, protocol)
  }
  return next
}

function lastSegment(id: string): string | undefined {
  const at = id.lastIndexOf('/')
  return at >= 0 ? id.slice(at + 1) : undefined
}

function scopedMetadata(
  catalog: ModelCatalog,
  provider: string,
  modelId: string,
): ModelMetadata | undefined {
  const models = catalog.providers.get(provider)
  if (!models) return undefined
  const direct = models.get(modelId)
  if (direct) return direct
  const tail = lastSegment(modelId)
  return tail ? models.get(tail) : undefined
}

function candidatesFor(catalog: ModelCatalog, modelId: string): readonly CatalogEntry[] {
  const direct = catalog.models.get(modelId)
  if (direct?.length) return direct
  const tail = lastSegment(modelId)
  return tail ? catalog.models.get(tail) ?? [] : []
}

function uniqueCandidates(candidates: readonly CatalogEntry[]): CatalogEntry[] {
  const seen = new Set<string>()
  const out: CatalogEntry[] = []
  for (const candidate of candidates) {
    const key = `${candidate.provider}\u0000${candidate.metadata.id}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(candidate)
  }
  return out
}

function equal<T>(values: readonly T[]): boolean {
  return values.every((value) => value === values[0])
}

function modalitiesKey(metadata: ModelMetadata): string {
  const input = [...(metadata.modalities?.input ?? [])].sort()
  const output = [...(metadata.modalities?.output ?? [])].sort()
  return `${input.join(',')}\u0000${output.join(',')}`
}

function mergeCandidates(candidates: readonly CatalogEntry[]): MetadataResolution {
  const unique = uniqueCandidates(candidates)
  const sources = [...new Set(unique.map((item) => item.provider))]
  const conflicts: MetadataField[] = []
  const metadata: ModelMetadata = { id: unique[0]!.metadata.id }

  const contexts = unique.map((item) => item.metadata.limit?.context)
  const context = contexts[0]
  if (!equal(contexts)) conflicts.push('context_window')
  else if (context !== undefined) metadata.limit = { context }

  const outputs = unique.map((item) => item.metadata.limit?.output)
  const output = outputs[0]
  if (!equal(outputs)) conflicts.push('max_output_tokens')
  else if (output !== undefined) metadata.limit = { ...(metadata.limit ?? {}), output }

  const reasonings = unique.map((item) => item.metadata.reasoning)
  const toolCalls = unique.map((item) => item.metadata.tool_call)
  const modalities = unique.map((item) => modalitiesKey(item.metadata))
  if (!equal(reasonings) || !equal(toolCalls) || !equal(modalities)) {
    conflicts.push('capabilities')
  } else {
    const reasoning = reasonings[0]
    const toolCall = toolCalls[0]
    const first = unique[0]!.metadata.modalities
    if (reasoning !== undefined) metadata.reasoning = reasoning
    if (toolCall !== undefined) metadata.tool_call = toolCall
    if (first && (first.input?.length || first.output?.length)) metadata.modalities = first
  }

  return { metadata, conflicts, sources }
}

/**
 * 查找模型元数据。给定 provider 时只认该供应商；否则把同名候选放在一起，
 * 只保留完全一致的字段，冲突字段留空由页面提示用户确认。
 */
export function resolveModelMetadata(
  catalog: ModelCatalog,
  modelId: string,
  provider?: string,
): MetadataResolution | undefined {
  const id = modelId.trim()
  if (!id) return undefined

  if (provider) {
    const metadata = scopedMetadata(catalog, provider, id)
    if (metadata) return { metadata, conflicts: [], sources: [provider] }
  }

  const candidates = candidatesFor(catalog, id)
  if (candidates.length === 0) return undefined
  if (candidates.length === 1) {
    const only = candidates[0]!
    return { metadata: only.metadata, conflicts: [], sources: [only.provider] }
  }
  return mergeCandidates(candidates)
}
