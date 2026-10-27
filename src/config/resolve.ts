import type { ModelInfo, ResolvedModel } from '../contract.js'
import { LLMError } from '../errors.js'
import { capabilitiesOf, type ModelConfig, type ProviderConfig, type StoredConfig } from './types.js'

export interface ResolvedTarget {
  provider: ProviderConfig
  model: ModelConfig
  info: ModelInfo
}

export function modelInfo(provider: ProviderConfig, model: ModelConfig): ModelInfo {
  const configured = model.capabilities?.length ? model.capabilities : capabilitiesOf(provider.protocol)
  const capabilities = configured.includes('text') ? configured : (['text', ...configured] as ModelInfo['capabilities'])
  return {
    alias: model.alias,
    provider: provider.id,
    model: model.model,
    capabilities,
    ...(model.context_window !== undefined ? { context_window: model.context_window } : {}),
    ...(model.max_output_tokens !== undefined ? { max_output_tokens: model.max_output_tokens } : {}),
    ...(model.max_tokens !== undefined ? { max_tokens: model.max_tokens } : {}),
    ...(model.temperature !== undefined ? { temperature: model.temperature } : {}),
  }
}

/** 别名是调用方唯一入口；解析失败时把供应商/别名一起放进错误，日志里好查 */
export function resolveTarget(config: StoredConfig, alias?: string): ResolvedTarget {
  const requested = (alias?.trim() || config.default_model).trim()
  if (!requested) {
    throw new LLMError('config', '未设置默认模型别名；请在「LLM 接口」页面配置')
  }
  const matches = config.models.filter((model) => model.alias === requested)
  if (matches.length === 0) {
    throw new LLMError('unknown_model', `模型别名 ${requested} 不存在或未配置`, { alias: requested })
  }
  if (matches.length > 1) {
    throw new LLMError('config', `模型别名 ${requested} 重复；请在配置页删掉多余的一项`, { alias: requested })
  }
  const model = matches[0]!
  if (!model.enabled) {
    throw new LLMError('config', `模型别名 ${requested} 已停用`, { alias: requested })
  }
  const provider = config.providers.find((item) => item.id === model.provider)
  if (!provider) {
    throw new LLMError('config', `模型别名 ${requested} 指向的供应商 ${model.provider} 不存在`, { alias: requested })
  }
  if (!provider.enabled) {
    throw new LLMError('config', `供应商 ${provider.name} 已停用`, { alias: requested, provider: provider.id })
  }
  return { provider, model, info: modelInfo(provider, model) }
}

/** 按供应商取第一个可用的模型，给页面「测试供应商」用 */
export function resolveProvider(config: StoredConfig, providerId: string): ResolvedTarget {
  const provider = config.providers.find((item) => item.id === providerId)
  if (!provider) throw new LLMError('config', `供应商 ${providerId} 不存在`, { provider: providerId })
  if (!provider.enabled) throw new LLMError('config', `供应商 ${provider.name} 已停用`, { provider: providerId })
  const model = config.models.find((item) => item.provider === providerId && item.enabled)
  if (!model) throw new LLMError('config', `供应商 ${provider.name} 还没有可用的模型别名`, { provider: providerId })
  return { provider, model, info: modelInfo(provider, model) }
}

export function listModels(config: StoredConfig): ModelInfo[] {
  // 一次建索引，避免 O(n²)：供应商多、别名多时这段在热路径上（调用方每次 listModels 都会走）
  const providers = new Map(config.providers.map((provider) => [provider.id, provider]))
  const out: ModelInfo[] = []
  for (const model of config.models) {
    if (!model.enabled) continue
    const provider = providers.get(model.provider)
    if (!provider?.enabled) continue
    out.push(modelInfo(provider, model))
  }
  return out
}

export function toResolvedModel(target: ResolvedTarget): ResolvedModel {
  return { ...target.info, provider_name: target.provider.name }
}
