import type { ProtocolId } from '../src/config/types.js'
import type { ProviderDraft } from './types.js'

export interface ProviderPreset {
  slug: string
  name: string
  protocol: ProtocolId
  base_url: string
  description: string
}

/** 常用的 OpenAI 兼容 / Anthropic 服务；只做预填，不限制用户改成自己的中转地址。 */
export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    slug: 'openai',
    name: 'OpenAI',
    protocol: 'openai',
    base_url: 'https://api.openai.com/v1',
    description: 'GPT 系列，也可以填兼容 Chat Completions 的中转地址',
  },
  {
    slug: 'anthropic',
    name: 'Anthropic',
    protocol: 'anthropic',
    base_url: 'https://api.anthropic.com/v1',
    description: 'Claude 系列，Messages API',
  },
  {
    slug: 'gemini',
    name: 'Google Gemini',
    protocol: 'gemini',
    base_url: 'https://generativelanguage.googleapis.com/v1beta',
    description: 'Gemini 系列，原生 generateContent 协议（思考内容、多模态、工具）',
  },
  {
    slug: 'deepseek',
    name: 'DeepSeek',
    protocol: 'openai',
    base_url: 'https://api.deepseek.com/v1',
    description: 'DeepSeek Chat / Reasoner',
  },
  {
    slug: 'openrouter',
    name: 'OpenRouter',
    protocol: 'openai',
    base_url: 'https://openrouter.ai/api/v1',
    description: '聚合多家模型，可额外配置 HTTP-Referer / X-Title',
  },
  {
    slug: 'moonshot',
    name: 'Moonshot',
    protocol: 'openai',
    base_url: 'https://api.moonshot.cn/v1',
    description: 'Kimi 系列',
  },
  {
    slug: 'zhipu',
    name: '智谱 GLM',
    protocol: 'openai',
    base_url: 'https://open.bigmodel.cn/api/paas/v4',
    description: 'GLM 系列，OpenAI 兼容接口',
  },
  {
    slug: 'dashscope',
    name: '阿里云百炼',
    protocol: 'openai',
    base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    description: '通义千问系列，兼容模式',
  },
  {
    slug: 'siliconflow',
    name: '硅基流动',
    protocol: 'openai',
    base_url: 'https://api.siliconflow.cn/v1',
    description: 'SiliconFlow 模型广场',
  },
  {
    slug: 'custom',
    name: '自定义 OpenAI 兼容',
    protocol: 'openai',
    base_url: '',
    description: '自建服务、局域网网关或其他兼容接口',
  },
  {
    slug: 'custom-anthropic',
    name: '自定义 Anthropic',
    protocol: 'anthropic',
    base_url: '',
    description: '自建 Claude Messages 兼容接口',
  },
]

export function uniqueProviderId(base: string, used: Iterable<string>): string {
  const taken = new Set(used)
  const clean =
    base
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^[^a-z0-9]+/, '')
      .replace(/[-_]+$/, '')
      .slice(0, 28) || 'provider'
  if (!taken.has(clean)) return clean
  for (let i = 2; ; i += 1) {
    const candidate = `${clean}-${i}`.slice(0, 32)
    if (!taken.has(candidate)) return candidate
  }
}

/** 上游模型名可能带 /，转成后端允许的别名起点。 */
export function aliasBase(name: string): string {
  return (
    name
      .replace(/[^A-Za-z0-9._:-]+/g, '-')
      .replace(/^[^A-Za-z0-9]+/, '')
      .slice(0, 36)
      .replace(/[-._:]+$/, '') || 'model'
  )
}

/** 只比较用户能改的字段；空 Key 当没填，避免输入框聚焦后误报脏。 */
export function providerFingerprint(provider: ProviderDraft): string {
  const headers = Object.entries(provider.headers ?? {}).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
  return JSON.stringify({
    name: provider.name,
    protocol: provider.protocol,
    base_url: provider.base_url,
    timeout_ms: provider.timeout_ms ?? null,
    enabled: provider.enabled,
    headers,
    api_key: provider.api_key?.trim() || null,
    clear_key: Boolean(provider.clear_key),
    allow_http: provider.allow_http === true,
  })
}

export function isProviderDraftDirty(draft: ProviderDraft, base: ProviderDraft | null, isNew: boolean): boolean {
  return isNew || !base || providerFingerprint(draft) !== providerFingerprint(base)
}
