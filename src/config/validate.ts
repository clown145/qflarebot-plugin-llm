import { looksLikeSecret } from '../redact.js'
import { CAPABILITY_VALUES, LIMITS, type ConfigIssue, type StoredConfig } from './types.js'

const PROVIDER_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/
const MODEL_ALIAS = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,39}$/
/** 由适配器按 api_key 生成的鉴权头；用户再写一份只会产生冲突值（实测会拼成 "Bearer a, Bearer b"） */
const MANAGED_HEADERS = new Set(['authorization', 'proxy-authorization', 'x-api-key', 'api-key', 'host', 'content-length', 'content-type'])
/** 私网 / 回环 / 元数据地址：密钥不该发到这些地方 */
const PRIVATE_HOST = /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[::1\]|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|169\.254\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+)$/i
const MAX_CONTEXT_WINDOW = 10_000_000
const MAX_OUTPUT_TOKENS = 1_000_000

function issue(level: ConfigIssue['level'], path: string, message: string): ConfigIssue {
  return { level, path, message }
}

function checkTimeout(value: number, path: string, issues: ConfigIssue[]): void {
  if (!Number.isInteger(value) || value < LIMITS.timeout_min || value > LIMITS.timeout_max) {
    issues.push(issue('error', path, `超时应在 ${LIMITS.timeout_min}–${LIMITS.timeout_max} 毫秒之间`))
    return
  }
  if (value > LIMITS.call_timeout_max) {
    // 老配置里存过 25000/28000 照常能用，但实际发请求时会被压到这个上限
    issues.push(issue('warn', path, `超过单次调用实际上限 ${LIMITS.call_timeout_max} 毫秒，会被压到这个值`))
  }
}

function checkBaseUrl(value: string, path: string, issues: ConfigIssue[]): void {
  if (!value) {
    issues.push(issue('error', path, '必填'))
    return
  }
  if (/\s/.test(value)) {
    issues.push(issue('error', path, '不能包含空白字符'))
    return
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    issues.push(issue('error', path, '不是合法的 URL'))
    return
  }
  if (url.protocol !== 'https:') {
    // API Key 走 Authorization 头，明文 HTTP 会在链路上暴露
    issues.push(issue('error', path, '只支持 https 地址；用 http 会把 API Key 明文发出去'))
    return
  }
  if (url.username || url.password) {
    issues.push(issue('error', path, '不要在接口地址里写用户名/密码；密钥请放到 API Key 字段'))
  }
  if (PRIVATE_HOST.test(url.hostname)) {
    issues.push(issue('error', path, '不能是回环或内网地址；API Key 会被发到内网服务'))
  }
}

/** 只做结构和取值检查，不联网、不读存储；PUT 保存前与页面加载后都用它 */
export function validateConfig(config: StoredConfig): ConfigIssue[] {
  const issues: ConfigIssue[] = []

  checkTimeout(config.request_timeout_ms, 'request_timeout_ms', issues)
  if (!Number.isInteger(config.max_retries) || config.max_retries < 0 || config.max_retries > LIMITS.max_retries) {
    issues.push(issue('error', 'max_retries', `重试次数应在 0–${LIMITS.max_retries} 之间`))
  }
  if (config.providers.length === 0) issues.push(issue('warn', 'providers', '还没有供应商'))

  const providerIds = new Map<string, number>()
  config.providers.forEach((provider, index) => {
    const base = `providers.${index}`
    if (!provider.id) {
      issues.push(issue('error', `${base}.id`, '必填'))
    } else if (!PROVIDER_ID.test(provider.id)) {
      issues.push(issue('error', `${base}.id`, '只能用小写字母、数字、-、_，且以字母或数字开头'))
    } else if (providerIds.has(provider.id)) {
      issues.push(issue('error', `${base}.id`, `与第 ${providerIds.get(provider.id)! + 1} 个供应商重复`))
    } else {
      providerIds.set(provider.id, index)
    }

    if (!provider.name.trim()) issues.push(issue('error', `${base}.name`, '必填'))
    else if (provider.name.length > 60) issues.push(issue('error', `${base}.name`, '最多 60 个字符'))

    if (provider.protocol !== 'openai' && provider.protocol !== 'anthropic') {
      issues.push(issue('error', `${base}.protocol`, '不支持的协议'))
    }
    checkBaseUrl(provider.base_url, `${base}.base_url`, issues)

    if (provider.timeout_ms !== undefined) checkTimeout(provider.timeout_ms, `${base}.timeout_ms`, issues)
    if (!provider.api_key) issues.push(issue('warn', `${base}.api_key`, '未设置 API Key；上游要求认证时会调用失败'))

    for (const [key, value] of Object.entries(provider.headers ?? {})) {
      const lower = key.toLowerCase()
      if (MANAGED_HEADERS.has(lower)) {
        // 适配器会用 api_key 覆盖同名头，两处都写会拼出坏值（实测 "Bearer a, Bearer b"）
        issues.push(issue('error', `${base}.headers`, `${key} 由适配器按 API Key 生成，不要在这里重复设置`))
        continue
      }
      if (looksLikeSecret(value)) {
        issues.push(issue('warn', `${base}.headers`, `${key} 看起来像密钥；导出时会被剔除，建议改放到 API Key 字段`))
      }
    }

    const models = config.models.filter((model) => model.provider === provider.id)
    if (models.length === 0) issues.push(issue('warn', `${base}.id`, '这个供应商还没有模型别名'))
    if (!provider.enabled && models.some((model) => model.enabled)) {
      issues.push(issue('warn', `${base}.enabled`, '供应商已停用，下面的模型都不会生效'))
    }
  })

  const aliases = new Map<string, number>()
  config.models.forEach((model, index) => {
    const base = `models.${index}`
    if (!model.alias) {
      issues.push(issue('error', `${base}.alias`, '必填'))
    } else if (!MODEL_ALIAS.test(model.alias)) {
      issues.push(issue('error', `${base}.alias`, '只能用字母、数字、.、_、:、-，且以字母或数字开头'))
    } else if (aliases.has(model.alias)) {
      issues.push(issue('error', `${base}.alias`, `与第 ${aliases.get(model.alias)! + 1} 个模型别名重复`))
    } else {
      aliases.set(model.alias, index)
    }

    const provider = model.provider ? config.providers.find((item) => item.id === model.provider) : undefined
    if (!model.provider) {
      issues.push(issue('error', `${base}.provider`, '必填'))
    } else if (!provider) {
      issues.push(issue('error', `${base}.provider`, `供应商 ${model.provider} 不存在`))
    } else if (!provider.enabled) {
      issues.push(issue('warn', `${base}.provider`, `供应商 ${model.provider} 已停用`))
    }

    if (!model.model) issues.push(issue('error', `${base}.model`, '必填'))
    else if (model.model.length > 200) issues.push(issue('error', `${base}.model`, '最多 200 个字符'))

    if (model.max_tokens !== undefined && (!Number.isInteger(model.max_tokens) || model.max_tokens < 1 || model.max_tokens > LIMITS.max_tokens_max)) {
      issues.push(issue('error', `${base}.max_tokens`, `应在 1–${LIMITS.max_tokens_max} 之间`))
    }
    if (model.context_window !== undefined && (!Number.isInteger(model.context_window) || model.context_window < 1 || model.context_window > MAX_CONTEXT_WINDOW)) {
      issues.push(issue('error', `${base}.context_window`, `应在 1–${MAX_CONTEXT_WINDOW} 之间`))
    }
    if (model.max_output_tokens !== undefined && (!Number.isInteger(model.max_output_tokens) || model.max_output_tokens < 1 || model.max_output_tokens > MAX_OUTPUT_TOKENS)) {
      issues.push(issue('error', `${base}.max_output_tokens`, `应在 1–${MAX_OUTPUT_TOKENS} 之间`))
    }
    if (model.max_tokens !== undefined && model.max_output_tokens !== undefined && model.max_tokens > model.max_output_tokens) {
      issues.push(issue('warn', `${base}.max_tokens`, '默认输出上限大于模型输出上限'))
    }
    if (model.capabilities !== undefined) {
      const allowed = new Set<string>(CAPABILITY_VALUES)
      const unknown = model.capabilities.filter((item) => !allowed.has(item))
      if (unknown.length) issues.push(issue('error', `${base}.capabilities`, `不支持的能力：${unknown.join('、')}`))
      if (provider?.protocol === 'anthropic' && model.capabilities.includes('json')) {
        issues.push(issue('warn', `${base}.capabilities`, 'Anthropic 协议不支持 JSON 输出'))
      }
      if (provider?.protocol === 'anthropic' && model.capabilities.includes('audio')) {
        issues.push(issue('warn', `${base}.capabilities`, 'Anthropic 协议不支持音频输入'))
      }
    }
    if (model.temperature !== undefined && (typeof model.temperature !== 'number' || model.temperature < 0 || model.temperature > 2)) {
      issues.push(issue('error', `${base}.temperature`, '应在 0–2 之间'))
    }
  })

  if (!config.default_model) {
    issues.push(issue('warn', 'default_model', '未设置默认模型；调用方不传 model 时会报错'))
  } else {
    const model = config.models.find((item) => item.alias === config.default_model)
    if (!model) {
      issues.push(issue('error', 'default_model', `模型别名 ${config.default_model} 不存在`))
    } else {
      const provider = config.providers.find((item) => item.id === model.provider)
      if (!model.enabled) issues.push(issue('warn', 'default_model', '默认模型已停用'))
      else if (provider && !provider.enabled) issues.push(issue('warn', 'default_model', '默认模型的供应商已停用'))
    }
  }

  const usable = config.models.some((model) => {
    if (!model.enabled) return false
    const provider = config.providers.find((item) => item.id === model.provider)
    return Boolean(provider?.enabled)
  })
  if (!usable) issues.push(issue('warn', 'models', '没有可用的模型别名'))

  return issues
}

export function hasErrors(issues: ConfigIssue[]): boolean {
  return issues.some((item) => item.level === 'error')
}
