import type { Logger } from '@qqbot/sdk'
import type {
  ChatRequest,
  ChatResult,
  FinishReason,
  LLMService,
  ModelInfo,
  PingResult,
  ResolvedModel,
  StreamEvent,
  ToolCall,
  Usage,
} from './contract.js'
import type { ModelConfig, ProviderConfig, StoredConfig } from './config/types.js'
import { LIMITS } from './config/types.js'
import { listModels as listConfiguredModels, resolveProvider, resolveTarget, toResolvedModel } from './config/resolve.js'
import { LLMError, errorFields, errorMessage, isAbortError } from './errors.js'
import { mergeUsage } from './protocols/shared.js'
import { adapterFor } from './protocols/registry.js'
import type { BuiltRequest, ParsedResponse, ProtocolAdapter } from './protocols/types.js'
import { validateChatRequest } from './request.js'
import { CONFIG_READ_FAILED, type ConfigStore, type LoadedConfig } from './store.js'
import { fetchJson, openStream, type TransportOptions } from './transport.js'
import { fetchError, type UpstreamContext } from './upstream.js'

const streamEncoder = new TextEncoder()

export interface LLMOptions {
  store: ConfigStore
  logger: Logger
  fetch?: typeof fetch
}

interface Prepared {
  config: StoredConfig
  provider: ProviderConfig
  model: ModelConfig
  adapter: ProtocolAdapter
  request: ChatRequest
  timeoutMs: number
  maxRetries: number
}

/** 提供 llm 服务：解析别名、拼协议请求、处理超时/重试/流式；不执行工具、不存会话 */
export class LLM implements LLMService {
  readonly contractVersion: 1 = 1
  private readonly store: ConfigStore
  private readonly logger: Logger
  private readonly fetchImpl: typeof fetch
  private configPromise?: Promise<LoadedConfig>

  constructor(options: LLMOptions) {
    this.store = options.store
    this.logger = options.logger
    this.fetchImpl = options.fetch ?? globalThis.fetch
  }

  async listModels(): Promise<ModelInfo[]> {
    const loaded = await this.load()
    if (loaded.readFailed) throw new LLMError('config', CONFIG_READ_FAILED)
    // 配置损坏时和 chat/resolve 保持一致：抛 config，而不是让调用方以为「没有模型」
    if (loaded.corrupt) throw new LLMError('config', '配置损坏；请打开面板的「LLM 接口」页面重新保存')
    return listConfiguredModels(loaded.config)
  }

  async resolve(alias?: string): Promise<ResolvedModel> {
    return toResolvedModel(resolveTarget(await this.requireConfig(), alias))
  }

  async chat(request: ChatRequest): Promise<ChatResult> {
    const prepared = await this.prepare(request)
    const startedAt = Date.now()
    const built = this.build(prepared, false)

    let json: unknown
    try {
      json = await fetchJson(built, this.transport(prepared))
    } catch (err) {
      this.logError('llm.chat', prepared, startedAt, err)
      throw err
    }

    let parsed: ParsedResponse
    try {
      parsed = prepared.adapter.parseResponse(json)
    } catch (err) {
      const error = new LLMError('bad_response', `解析上游响应失败：${errorMessage(err)}`, {
        provider: prepared.provider.id,
        alias: prepared.model.alias,
        cause: err,
      })
      this.logError('llm.chat', prepared, startedAt, error)
      throw error
    }

    if (!parsed.text && !parsed.toolCalls?.length && !parsed.reasoning && !parsed.finishReason) {
      const error = new LLMError('bad_response', '上游没有返回内容', {
        provider: prepared.provider.id,
        alias: prepared.model.alias,
      })
      this.logError('llm.chat', prepared, startedAt, error)
      throw error
    }

    const result = this.result(prepared, parsed, startedAt)
    this.logSuccess('llm.chat', prepared, result)
    return result
  }

  async *stream(request: ChatRequest): AsyncGenerator<StreamEvent> {
    const prepared = await this.prepare(request)
    const startedAt = Date.now()
    const built = this.build(prepared, true)

    let opened: Awaited<ReturnType<typeof openStream>>
    try {
      opened = await openStream(built, this.transport(prepared))
    } catch (err) {
      this.logError('llm.stream', prepared, startedAt, err)
      throw err
    }

    const { response, handle } = opened
    const body = response.body
    if (!body) {
      handle.cleanup()
      const error = new LLMError('bad_response', '上游没有返回响应体', {
        provider: prepared.provider.id,
        alias: prepared.model.alias,
      })
      this.logError('llm.stream', prepared, startedAt, error)
      throw error
    }

    let text = ''
    let reasoning = ''
    const calls: (ToolCall | undefined)[] = []
    let usage: Usage | undefined
    let finishReason: FinishReason | undefined
    let streamedBytes = 0

    const count = (value: string | undefined): void => {
      if (!value) return
      streamedBytes += streamEncoder.encode(value).byteLength
      if (streamedBytes > LIMITS.stream_max_bytes) {
        throw new LLMError('bad_response', `上游流式内容超过 ${LIMITS.stream_max_bytes / 1024 / 1024} MB 上限`, {
          provider: prepared.provider.id,
          alias: prepared.model.alias,
        })
      }
    }

    try {
      // 把凭据传给适配器：流内 error 事件的 message 需要脱敏。
      // 自定义请求头里可能放凭据（如 Azure 的 api-key），与非流式路径的 upstreamContext 同标准
      const headerSecrets = Object.values(prepared.provider.headers ?? {}).filter((value): value is string => typeof value === 'string' && value.length > 0)
      for await (const event of prepared.adapter.parseStream(body, {
        ...(prepared.provider.api_key ? { apiKey: prepared.provider.api_key } : {}),
        ...(headerSecrets.length ? { secrets: headerSecrets } : {}),
      })) {
        if (event.type === 'text_delta') {
          count(event.text)
          text += event.text
          yield { type: 'text_delta', text: event.text }
        } else if (event.type === 'reasoning_delta') {
          count(event.text)
          reasoning += event.text
          yield { type: 'reasoning_delta', text: event.text }
        } else if (event.type === 'tool_call_delta') {
          if (event.index < 0 || event.index > 63) {
            throw new LLMError('bad_response', `工具调用索引 ${event.index} 超出支持范围（0–63）`, {
              provider: prepared.provider.id,
              alias: prepared.model.alias,
            })
          }
          count(event.id)
          count(event.name)
          count(event.argumentsDelta)
          const current = calls[event.index] ?? { id: '', name: '', arguments: '' }
          if (event.id) current.id = event.id
          if (event.name) current.name = event.name
          if (event.argumentsDelta) current.arguments += event.argumentsDelta
          calls[event.index] = current
          yield {
            type: 'tool_call_delta',
            index: event.index,
            ...(event.id ? { id: event.id } : {}),
            ...(event.name ? { name: event.name } : {}),
            ...(event.argumentsDelta ? { arguments_delta: event.argumentsDelta } : {}),
          }
        } else if (event.type === 'usage') {
          usage = mergeUsage(usage, event.usage)
        } else if (event.type === 'finish') {
          finishReason = event.reason
        }
      }
    } catch (err) {
      let error: LLMError
      if (err instanceof LLMError) {
        error = err.provider && err.alias
          ? err
          : new LLMError(err.code, err.message, {
              provider: err.provider ?? prepared.provider.id,
              alias: err.alias ?? prepared.model.alias,
              ...(err.status !== undefined ? { status: err.status } : {}),
              ...(err.detail ? { detail: err.detail } : {}),
            })
      } else if (isAbortError(err)) {
        error = fetchError(err, this.upstreamContext(prepared), handle.timedOut(), handle.parentAborted())
      } else {
        error = new LLMError('bad_response', `读取上游流失败：${errorMessage(err)}`, {
          provider: prepared.provider.id,
          alias: prepared.model.alias,
          cause: err,
        })
      }
      this.logError('llm.stream', prepared, startedAt, error)
      throw error
    } finally {
      handle.cleanup()
      handle.abort()
      await body.cancel().catch(() => {})
    }

    const toolCalls = calls.flatMap((call, index) => {
      if (!call?.name) return []
      return [{ id: call.id || `call_${index}`, name: call.name, arguments: call.arguments || '{}' }]
    })
    if (!text && !toolCalls.length && !reasoning && !finishReason) {
      const error = new LLMError('bad_response', '上游没有返回内容', {
        provider: prepared.provider.id,
        alias: prepared.model.alias,
      })
      this.logError('llm.stream', prepared, startedAt, error)
      throw error
    }

    const result = this.result(
      prepared,
      {
        text,
        ...(reasoning ? { reasoning } : {}),
        ...(toolCalls.length ? { toolCalls } : {}),
        ...(finishReason ? { finishReason } : {}),
        ...(usage ? { usage } : {}),
      },
      startedAt,
    )
    this.logSuccess('llm.stream', prepared, result)
    yield { type: 'done', result }
  }

  async ping(options: { alias?: string; provider?: string } = {}): Promise<PingResult> {
    let alias = options.alias?.trim() ?? ''
    let providerId = options.provider?.trim() ?? ''
    try {
      const config = await this.requireConfig()
      if (!alias && providerId) {
        alias = resolveProvider(config, providerId).model.alias
      } else if (!alias) {
        alias = config.default_model
      }
      if (!alias) return { ok: false, latency_ms: 0, ...(providerId ? { provider: providerId } : {}), error: '没有可测试的模型别名' }

      const target = resolveTarget(config, alias)
      providerId = target.provider.id
      const configured = target.provider.timeout_ms ?? config.request_timeout_ms
      // 健康检查只需要极小的一次往返；上限再收一档，别让它吃掉事件预算
      const timeout = Math.min(configured, 10000)
      const result = await this.chat({
        model: alias,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 16,
        temperature: 0,
        timeout_ms: timeout,
      })
      return {
        ok: true,
        latency_ms: result.latency_ms,
        alias,
        provider: result.provider,
        model: result.model,
        ...(result.text ? { text: result.text } : {}),
        ...(result.usage ? { usage: result.usage } : {}),
      }
    } catch (err) {
      return {
        ok: false,
        latency_ms: 0,
        ...(alias ? { alias } : {}),
        // 只有解析出供应商时才带上；早期错误（配置读失败）没有供应商
        ...(providerId ? { provider: providerId } : {}),
        error: errorMessage(err),
      }
    }
  }

  private load(): Promise<LoadedConfig> {
    this.configPromise ??= this.store.read()
    return this.configPromise
  }

  private async requireConfig(): Promise<StoredConfig> {
    const loaded = await this.load()
    if (loaded.readFailed) throw new LLMError('config', CONFIG_READ_FAILED)
    if (loaded.corrupt) {
      throw new LLMError('config', '配置损坏；请打开面板的「LLM 接口」页面重新保存')
    }
    return loaded.config
  }

  private async prepare(request: ChatRequest): Promise<Prepared> {
    validateChatRequest(request)
    const config = await this.requireConfig()
    const target = resolveTarget(config, request.model)
    const adapter = adapterFor(target.provider.protocol)

    if (request.tools?.length && !adapter.capabilities.includes('tools')) {
      throw new LLMError('unsupported', `${adapter.label} 不支持工具调用`, {
        provider: target.provider.id,
        alias: target.model.alias,
      })
    }
    if (request.json && !adapter.capabilities.includes('json')) {
      throw new LLMError('unsupported', `${adapter.label} 不支持 JSON 输出`, {
        provider: target.provider.id,
        alias: target.model.alias,
      })
    }

    const configured = request.timeout_ms ?? target.provider.timeout_ms ?? config.request_timeout_ms
    // 单次调用压到 call_timeout_max：一次事件所有插件合计 30 秒，28 秒会把预算吃光
    const timeoutMs = Math.min(
      Math.max(Number.isFinite(configured) ? configured : 15000, LIMITS.timeout_min),
      LIMITS.call_timeout_max,
    )
    const retries = Number.isFinite(config.max_retries) ? config.max_retries : 1
    const maxRetries = Math.min(Math.max(Math.trunc(retries), 0), LIMITS.max_retries)

    const effective: ChatRequest = { ...request, model: target.model.alias }
    const temperature = target.model.temperature
    if (effective.temperature === undefined && temperature !== undefined && temperature >= 0 && temperature <= 2) {
      effective.temperature = temperature
    }
    const maxTokens = target.model.max_tokens
    if (effective.max_tokens === undefined && maxTokens !== undefined && Number.isInteger(maxTokens) && maxTokens > 0) {
      effective.max_tokens = maxTokens
    }

    return {
      config,
      provider: target.provider,
      model: target.model,
      adapter,
      request: effective,
      timeoutMs,
      maxRetries,
    }
  }

  private upstreamContext(prepared: Prepared): UpstreamContext {
    // 自定义请求头里可能放凭据（如 Azure 的 api-key）；一并加入脱敏列表，避免上游回显时泄漏
    const headerSecrets = Object.entries(prepared.provider.headers ?? {}).map(([, value]) => value).filter((v): v is string => typeof v === 'string' && v.length > 0)
    return {
      provider: prepared.provider.id,
      alias: prepared.model.alias,
      timeoutMs: prepared.timeoutMs,
      ...(prepared.provider.api_key ? { apiKey: prepared.provider.api_key } : {}),
      ...(headerSecrets.length ? { secrets: headerSecrets } : {}),
    }
  }

  private transport(prepared: Prepared): TransportOptions {
    return {
      fetch: this.fetchImpl,
      logger: this.logger,
      context: this.upstreamContext(prepared),
      timeoutMs: prepared.timeoutMs,
      maxRetries: prepared.maxRetries,
      ...(prepared.request.signal ? { signal: prepared.request.signal } : {}),
    }
  }

  private build(prepared: Prepared, stream: boolean): BuiltRequest {
    try {
      return prepared.adapter.buildChat({ provider: prepared.provider, model: prepared.model }, prepared.request, stream)
    } catch (err) {
      if (err instanceof LLMError) throw err
      throw new LLMError('bad_request', `构造上游请求失败：${errorMessage(err)}`, {
        provider: prepared.provider.id,
        alias: prepared.model.alias,
        cause: err,
      })
    }
  }

  private result(prepared: Prepared, parsed: ParsedResponse, startedAt: number): ChatResult {
    const toolCalls = parsed.toolCalls?.length ? parsed.toolCalls : undefined
    const finish = parsed.finishReason ?? (toolCalls ? 'tool_calls' : undefined)
    return {
      text: parsed.text,
      ...(parsed.reasoning ? { reasoning: parsed.reasoning } : {}),
      ...(toolCalls ? { tool_calls: toolCalls } : {}),
      ...(finish ? { finish_reason: finish } : {}),
      alias: prepared.model.alias,
      provider: prepared.provider.id,
      model: prepared.model.model,
      ...(parsed.usage ? { usage: parsed.usage } : {}),
      latency_ms: Date.now() - startedAt,
    }
  }

  private logSuccess(event: string, prepared: Prepared, result: ChatResult): void {
    this.logger.info(event, {
      provider: result.provider,
      alias: result.alias,
      model: result.model,
      ms: result.latency_ms,
      ...(result.finish_reason ? { finish: result.finish_reason } : {}),
      ...(result.usage?.input_tokens !== undefined ? { input_tokens: result.usage.input_tokens } : {}),
      ...(result.usage?.output_tokens !== undefined ? { output_tokens: result.usage.output_tokens } : {}),
    })
  }

  private logError(event: string, prepared: Prepared, startedAt: number, err: unknown): void {
    this.logger.warn(event, {
      provider: prepared.provider.id,
      alias: prepared.model.alias,
      model: prepared.model.model,
      ms: Date.now() - startedAt,
      ...errorFields(err),
    })
  }
}
