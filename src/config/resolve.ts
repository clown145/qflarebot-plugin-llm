import type { ModelInfo, ResolvedModel } from '../contract.js'
import { LLMError } from '../errors.js'
import { capabilitiesOf, type ModelConfig, type ProviderConfig, type StoredConfig } from './types.js'

export interface ResolvedTarget {
  provider: ProviderConfig
  model: ModelConfig
  info: ModelInfo
}

export function modelInfo(provider: ProviderConfig, model: ModelConfig): ModelInfo {
  return {
    alias: model.alias,
    provider: provider.id,
    model: model.model,
    capabilities: capabilitiesOf(provider.protocol),
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
  return config.models
    .filter((model) => {
      if (!model.enabled) return false
      const provider = config.providers.find((item) => item.id === model.provider)
      return Boolean(provider?.enabled)
    })
    .map((model) => modelInfo(config.providers.find((item) => item.id === model.provider)!, model))
}

export function toResolvedModel(target: ResolvedTarget): ResolvedModel {
  return { ...target.info, provider_name: target.provider.name }
}
