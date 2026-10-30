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
  ThoughtSignature,
  ToolCall,
  Usage,
} from './contract.js'
import type { ModelConfig, ProviderConfig, StoredConfig } from './config/types.js'
import { LIMITS } from './config/types.js'
import { listModels as listConfiguredModels, resolveProvider, resolveTarget, toResolvedModel } from './config/resolve.js'
import { withDefaultModel } from './commands/switch.js'
import { LLMError, errorFields, errorMessage, isAbortError } from './errors.js'
import { mergeUsage } from './protocols/shared.js'
import { adapterFor } from './protocols/registry.js'
import type { BuiltRequest, ParsedResponse, ProtocolAdapter } from './protocols/types.js'
import { validateChatRequest } from './request.js'
import { isMetadataHost } from './config/validate.js'
import { mapHistoryToolNames, mapRequestToolNames, mapResultToolNames, toolNameMapFor, type ToolNameMap } from './toolNames.js'
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
  /** 内部工具名 ↔ 上游 wire 名；单次调用有效 */
  toolNames: ToolNameMap
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
    /** Gemini 思考签名集合（文本与工具调用 part）；调用方要保存并在下一轮回传 */
    const thoughtSignatures: ThoughtSignature[] = []
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
          // 上游给的是 wire 名，对外一律换成内部名：调用方拿它去自己的工具表里查，
          // 拿到 `time_now` 会查不到（插件定义的是 `time.now`）。
          const internalName = event.name ? prepared.toolNames.toInternal(event.name) : undefined
          const current: ToolCall = calls[event.index] ?? { id: '', name: '', arguments: '' }
          if (event.id) current.id = event.id
          if (internalName) current.name = internalName
          if (event.argumentsDelta) current.arguments += event.argumentsDelta
          calls[event.index] = current
          yield {
            type: 'tool_call_delta',
            index: event.index,
            ...(event.id ? { id: event.id } : {}),
            ...(internalName ? { name: internalName } : {}),
            ...(event.argumentsDelta ? { arguments_delta: event.argumentsDelta } : {}),
          }
        } else if (event.type === 'thought_signature') {
          const { type: _type, ...signature } = event
          count(signature.signature)
          // 签名里若带 tool_name，那是上游名；对外统一用内部名，
          // 这样调用方保存后下一轮回传时与非流式路径的字段口径一致
          const mappedSignature =
            signature.tool_name === undefined
              ? signature
              : { ...signature, tool_name: prepared.toolNames.toInternal(signature.tool_name) }
          thoughtSignatures.push(mappedSignature)
          yield { type: 'thought_signature', ...mappedSignature }
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
        ...(thoughtSignatures.length ? { thoughtSignatures } : {}),
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

  /**
   * 当前默认模型的别名。
   *
   * 单独一个方法而不是让调用方去读配置：`default_model` 可能在配置里为空
   * （还没设置过），那时 `resolveTarget` 会退回「第一个可用模型」。
   * 命令层要显示「当前用的是哪个」，必须和 `chat()` 的实际行为一致，
   * 所以这里复用同样的解析逻辑。
   */
  async currentModel(): Promise<string> {
    const config = await this.requireConfig()
    const models = listConfiguredModels(config)
    if (models.length === 0) return ''
    // 显式配了就用它；没配就是调用时会被选中的那个（第一个可用模型）
    return config.default_model || models[0]!.alias
  }

  /**
   * 切换默认模型。
   *
   * 只改 `default_model`，不动供应商与模型列表。
   *
   * **写后必须清掉配置缓存**：`load()` 用 `configPromise` 缓存了一次读，
   * 不清的话本次请求后续的 `chat()` 还会用旧配置 —— 用户切了模型却感觉没生效。
   */
  async setDefaultModel(alias: string): Promise<void> {
    const config = await this.requireConfig()
    const models = listConfiguredModels(config)
    if (!models.some((model) => model.alias === alias)) {
      throw new LLMError('config', `没有名为 ${alias} 的可用模型`)
    }

    const next = withDefaultModel(config, alias)
    await this.store.write(next)
    // 缓存失效：下次 load() 重新读
    this.configPromise = undefined
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

    // 工具名合法化：插件用 `time.now` 这种可读名字，而上游只收 `[a-zA-Z0-9_-]`
    // （OpenAI 兼容含 DeepSeek 会直接 400）。映射按本次请求出现的名字建立，
    // 覆盖要发的工具与历史里出现过的调用名（后者用于多轮回填）。
    const toolNames = toolNameMapFor(effective, target.provider.protocol)

    return {
      config,
      provider: target.provider,
      model: target.model,
      adapter,
      request: effective,
      toolNames,
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
      // 发出去之前再过一道元数据地址检查。
      //
      // 保存时已经校验过（`checkBaseUrl`），这里是纵深防御：配置可能来自导入、
      // 手工改 KV、或未来某条绕过校验的新路径。元数据地址能拿到实例凭证，
      // 值得在真正发请求前再拦一次——**即使这个供应商开着 allow_http**。
      assertNotMetadataHost(prepared.provider.base_url, prepared.provider.id)
      // 发出去的名字必须是 wire 名：tools 列表、tool_choice、以及历史里回填的 tool_calls。
      // 三者都用同一个映射，保证「这一轮发的名字」与「上一轮回填的名字」对得上。
      const wireRequest = mapHistoryToolNames(mapRequestToolNames(prepared.request, prepared.toolNames), prepared.toolNames)
      return prepared.adapter.buildChat({ provider: prepared.provider, model: prepared.model }, wireRequest, stream)
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
    // 上游给的是 wire 名，调用方只认自己定义的名字：这里换回去（含 Gemini 签名里的 tool_name）
    const mapped = mapResultToolNames(parsed.toolCalls, parsed.thoughtSignatures, prepared.toolNames)
    const toolCalls = mapped.toolCalls?.length ? mapped.toolCalls : undefined
    const finish = parsed.finishReason ?? (toolCalls ? 'tool_calls' : undefined)
    return {
      text: parsed.text,
      ...(parsed.reasoning ? { reasoning: parsed.reasoning } : {}),
      ...(mapped.thoughtSignatures?.length ? { thought_signatures: mapped.thoughtSignatures } : {}),
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

/**
 * 发请求前的元数据地址兜底检查（纵深防御）。
 *
 * 保存路径的 `checkBaseUrl` 已经拦过，但配置也可能来自导入或手工改 KV。
 * 这里再判一次，避免任何一条路径把请求送到云元数据服务上——
 * 那个地址能换到实例凭证，`allow_http` 也不该放行它。
 */
function assertNotMetadataHost(baseUrl: string, providerId: string): void {
  let hostname: string
  try {
    hostname = new URL(baseUrl).hostname
  } catch {
    return // 地址本身非法会在 buildChat 里报出来，这里不重复处理
  }
  if (isMetadataHost(hostname)) {
    throw new LLMError('bad_request', `供应商 ${providerId} 的接口地址指向云元数据服务，已拒绝`, {
      provider: providerId,
    })
  }
}
