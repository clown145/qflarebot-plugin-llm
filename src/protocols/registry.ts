import type { ProtocolId, ProtocolMeta } from '../config/types.js'
import { LLMError } from '../errors.js'
import { anthropic } from './anthropic.js'
import { gemini } from './gemini.js'
import { openai } from './openai.js'
import type { ProtocolAdapter } from './types.js'

const ADAPTERS: Record<ProtocolId, ProtocolAdapter> = {
  openai,
  anthropic,
  gemini,
}

export function adapterFor(protocol: ProtocolId): ProtocolAdapter {
  const adapter = ADAPTERS[protocol]
  if (!adapter) throw new LLMError('config', `不支持的协议：${String(protocol)}`)
  return adapter
}

export function protocolMeta(): ProtocolMeta[] {
  return Object.values(ADAPTERS).map((adapter) => ({
    id: adapter.id,
    label: adapter.label,
    capabilities: adapter.capabilities,
    default_base_url: adapter.defaultBaseUrl,
    base_url_hint: adapter.baseUrlHint,
  }))
}
