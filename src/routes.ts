import type { Route, RouteInput } from '@qqbot/sdk'
import type { ApiError, ConfigGetResponse, ConfigPutResponse, MetaResponse, ModelsResponse, TestResponse } from './apiTypes.js'
import { hasErrors, LIMITS, mergeSecrets, normalizeProvider, toPublicConfig, validateConfig, checkBaseUrl, droppedSecrets } from './config/index.js'
import type { ConfigIssue, PublicConfigInput, StoredConfig } from './config/types.js'
import { LLMError, errorMessage } from './errors.js'
import { createAbortHandle, HttpError, json, readJson, readJsonLimited, readTextLimited, safeDetail, urlSecrets } from './http.js'
import { isRecord } from './json.js'
import { adapterFor, protocolMeta } from './protocols/registry.js'
import { LLM } from './service.js'
import { CONFIG_READ_FAILED, createConfigStore, fixedStore } from './store.js'
import { PAGE_HTML } from './page.generated.js'

function statusFor(err: LLMError): number {
  if (err.code === 'rate_limit') return 429
  if (err.code === 'timeout') return 504
  if (err.code === 'config' || err.code === 'unknown_model' || err.code === 'bad_request' || err.code === 'unsupported') return 400
  return 502
}

function handle(fn: (input: RouteInput<unknown>) => Promise<Response>): (input: RouteInput<unknown>) => Promise<Response> {
  return async (input) => {
    try {
      return await fn(input)
    } catch (err) {
      if (err instanceof HttpError) {
        return json(err.payload ?? ({ ok: false, error: err.message } satisfies ApiError), err.status)
      }
      if (err instanceof LLMError) {
        return json({ ok: false, error: err.message, code: err.code } satisfies ApiError, statusFor(err))
      }
      input.ctx.logger.error('llm.route', { error: errorMessage(err) })
      return json({ ok: false, error: '服务器内部错误' } satisfies ApiError, 500)
    }
  }
}

function bodyRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new HttpError(400, '请求体必须是 JSON 对象')
  return value
}

/**
 * 校验提交的配置形状。
 *
 * `providers` 里的每一项都必须是对象：旧实现只对 `isRecord` 的项做协议校验，`[null]` 会一路走到
 * `mergeSecrets` 里 `item.id` 抛 TypeError → 500。这里提前挡成 400。
 */
function configInput(value: unknown): PublicConfigInput {
  if (!isRecord(value)) throw new HttpError(400, 'config 必须是对象')
  if (!Array.isArray(value['providers']) || !Array.isArray(value['models'])) {
    throw new HttpError(400, 'config.providers / config.models 必须是数组')
  }
  value['providers'].forEach((provider, index) => {
    if (!isRecord(provider)) throw new HttpError(400, `第 ${index + 1} 个供应商必须是对象`)
    ensureProtocol(provider, `第 ${index + 1} 个供应商`)
  })
  value['models'].forEach((model, index) => {
    if (!isRecord(model)) throw new HttpError(400, `第 ${index + 1} 个模型必须是对象`)
  })
  return value as unknown as PublicConfigInput
}

function ensureProtocol(provider: Record<string, unknown>, label: string): void {
  const protocol = provider['protocol']
  if (protocol !== undefined && protocol !== 'openai' && protocol !== 'anthropic' && protocol !== 'gemini') {
    throw new HttpError(400, `${label}的协议不支持：${String(protocol)}`)
  }
}

function versionOf(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) throw new HttpError(400, 'version 必须是非负整数')
  return value
}

function issuesWithCorrupt(issues: ConfigIssue[], corrupt: boolean): ConfigIssue[] {
  if (!corrupt) return issues
  return [{ level: 'error', path: '', message: '存储里的配置损坏；重新保存会覆盖它' }, ...issues]
}

function storedFromDraft(draft: PublicConfigInput, current: StoredConfig): StoredConfig {
  const next = mergeSecrets(draft, current)
  const issues = validateConfig(next)
  if (hasErrors(issues)) throw new HttpError(400, '配置有误', { ok: false, error: '配置有误', errors: issues } satisfies ApiError)
  return next
}

/**
 * 取已存供应商的密钥，但**只在接口地址与协议都没变时**。
 *
 * 这是 P0 修复的核心：`/api/upstream-models` 与 `/api/test` 都接受请求体里的 provider，
 * 旧实现按 `id` 无条件回填 KV 里的 key，于是「请求体里写任意 base_url + 已知 id」
 * 就能把本机密钥作为 Authorization 头发到任意第三方地址。现在地址或协议一变就不复用。
 */
function reusableKey(
  submitted: { id: string; protocol: string; base_url: string },
  existing: StoredConfig['providers'][number] | undefined,
): string | undefined {
  if (!existing?.api_key) return undefined
  const sameProtocol = submitted.protocol === existing.protocol
  const sameUrl = submitted.base_url.trim().replace(/\/+$/, '').toLowerCase() ===
    existing.base_url.trim().replace(/\/+$/, '').toLowerCase()
  return sameProtocol && sameUrl ? existing.api_key : undefined
}

export function createRoutes(): Route[] {
  return [
    {
      method: 'GET',
      path: '/ui/*',
      auth: 'admin',
      handler: async () =>
        new Response(PAGE_HTML, {
          headers: {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store',
          },
        }),
    },
    {
      method: 'GET',
      path: '/api/meta',
      auth: 'admin',
      handler: handle(async ({ ctx }) => {
        const data: MetaResponse = {
          ok: true,
          plugin: { name: ctx.plugin.name, version: ctx.plugin.version },
          service: { name: 'llm', contractVersion: 1 },
          protocols: protocolMeta(),
          limits: {
            timeout_min: LIMITS.timeout_min,
            timeout_max: LIMITS.timeout_max,
            call_timeout_max: LIMITS.call_timeout_max,
            max_retries: LIMITS.max_retries,
            max_tokens_max: LIMITS.max_tokens_max,
            body_max_bytes: LIMITS.body_max_bytes,
            response_max_bytes: LIMITS.response_max_bytes,
            stream_max_bytes: LIMITS.stream_max_bytes,
          },
        }
        return json(data)
      }),
    },
    {
      method: 'GET',
      path: '/api/config',
      auth: 'admin',
      handler: handle(async ({ ctx }) => {
        const store = createConfigStore(ctx)
        const loaded = await store.read()
        if (loaded.readFailed) {
          return json({ ok: false, error: CONFIG_READ_FAILED } satisfies ApiError, 503)
        }
        const data: ConfigGetResponse = {
          ok: true,
          config: toPublicConfig(loaded.config),
          issues: issuesWithCorrupt(validateConfig(loaded.config), loaded.corrupt),
          corrupt: loaded.corrupt,
        }
        return json(data)
      }),
    },
    {
      method: 'PUT',
      path: '/api/config',
      auth: 'admin',
      handler: handle(async ({ ctx, request }) => {
        const body = bodyRecord(await readJson(request, LIMITS.body_max_bytes))
        const version = versionOf(body['version'])
        const draft = configInput(body['config'])
        const store = createConfigStore(ctx)
        const loaded = await store.read()
        if (loaded.readFailed) {
          return json({ ok: false, error: CONFIG_READ_FAILED } satisfies ApiError, 503)
        }
        if (loaded.config.version !== version) {
          return json({
            ok: false,
            error: '配置已经被修改，请刷新页面后再保存',
            config: toPublicConfig(loaded.config),
          } satisfies ApiError, 409)
        }
        const next = mergeSecrets(draft, loaded.config)
        const issues = validateConfig(next)
        if (hasErrors(issues)) {
          return json({ ok: false, error: '配置有误', errors: issues } satisfies ApiError, 400)
        }
        // 写前再比一次版本：两个并发 PUT 都通过上面的乐观检查时，后写的会覆盖先写的。
        // 这里把「读到 version → 写入」的窗口压到一次 KV 读，冲突时按 409 让页面刷新。
        // 读失败是 503（README 承诺），不能误导成「配置被修改」让用户刷新丢编辑。
        // 老版本 store 没有 compareAndWrite（测试替身可能没实现）时退回直接写。
        const outcome = store.compareAndWrite
          ? await store.compareAndWrite(next, version)
          : (await store.write(next), 'written' as const)
        if (outcome === 'read-failed') {
          return json({ ok: false, error: CONFIG_READ_FAILED } satisfies ApiError, 503)
        }
        if (outcome !== 'written') {
          const latest = await store.read()
          return json({
            ok: false,
            error: '配置已经被修改，请刷新页面后再保存',
            ...(latest.config ? { config: toPublicConfig(latest.config) } : {}),
          } satisfies ApiError, 409)
        }
        const data: ConfigPutResponse = {
          ok: true,
          config: toPublicConfig(next),
          issues,
          dropped_secrets: droppedSecrets(draft, loaded.config),
        }
        return json(data)
      }),
    },
    {
      method: 'POST',
      path: '/api/test',
      auth: 'admin',
      handler: handle(async ({ ctx, request }) => {
        const body = bodyRecord(await readJson(request, LIMITS.body_max_bytes))
        const target = isRecord(body['target']) ? body['target'] : {}
        const alias = typeof target['alias'] === 'string' ? target['alias'] : undefined
        const provider = typeof target['provider'] === 'string' ? target['provider'] : undefined

        const current = await createConfigStore(ctx).read()
        if (current.readFailed) throw new HttpError(503, CONFIG_READ_FAILED)
        if (body['draft'] === undefined && current.corrupt) {
          throw new HttpError(400, '配置损坏；请重新保存')
        }
        // 草稿里的供应商可能改了 base_url：mergeSecrets 现在只在地点/协议一致时才沿用密钥
        const store = body['draft'] !== undefined
          ? fixedStore(storedFromDraft(configInput(body['draft']), current.config))
          : fixedStore(current.config)

        const llm = new LLM({ store, logger: ctx.logger })
        const result = await llm.ping({ ...(alias ? { alias } : {}), ...(provider ? { provider } : {}) })
        const data: TestResponse = { ok: true, result }
        return json(data)
      }),
    },
    {
      method: 'POST',
      path: '/api/upstream-models',
      auth: 'admin',
      handler: handle(async ({ ctx, request }) => {
        const body = bodyRecord(await readJson(request, LIMITS.body_max_bytes))
        const raw = body['provider']
        if (!isRecord(raw)) throw new HttpError(400, 'provider 必须是对象')
        ensureProtocol(raw, '供应商')
        const provider = normalizeProvider(raw, 0)
        if (!provider.id) throw new HttpError(400, 'provider.id 必填')
        if (!provider.base_url) throw new HttpError(400, 'provider.base_url 必填')
        // 与保存路径同一道防线：拒绝 http / 回环 / 内网，避免把密钥发进内网或明文外发。
        // allow_http 由这个供应商自己的配置决定（用户显式打开才能走明文）
        {
          const issues: ConfigIssue[] = []
          checkBaseUrl(provider.base_url, 'provider.base_url', issues, { allowHttp: provider.allow_http === true })
          if (hasErrors(issues)) throw new HttpError(400, issues[0]!.message)
        }

        const current = await createConfigStore(ctx).read()
        if (current.readFailed) throw new HttpError(503, CONFIG_READ_FAILED)
        const existing = current.config.providers.find((item) => item.id === provider.id)
        const cleared = raw['api_key'] === null
        if (!cleared && !provider.api_key) {
          // 只在地址与协议都没变时复用；否则请求体里的任意 base_url 就能把密钥发出去
          const reused = reusableKey(provider, existing)
          if (reused) provider.api_key = reused
        }

        const adapter = adapterFor(provider.protocol)
        const built = adapter.buildListModels(provider)
        const handleAbort = createAbortHandle(15000, request.signal)
        // 失败分支统一走这一组脱敏材料：api_key、自定义头里的值、base_url 查询串/片段。
        // 过去连接失败分支只做 truncate，`?key=…` 形式的密钥原样回给页面（实测泄漏）。
        const secretValues = [
          provider.api_key,
          ...Object.values(provider.headers ?? {}),
          ...urlSecrets(provider.base_url),
        ]
        try {
          let response: Response
          try {
            response = await fetch(built.url, { ...built.init, signal: handleAbort.signal, redirect: 'manual' })
          } catch (err) {
            if (handleAbort.timedOut()) throw new HttpError(504, '拉取模型超时（15 秒）')
            throw new HttpError(502, `连接上游失败：${safeDetail(errorMessage(err), secretValues, 200)}`)
          }
          if (!response.ok) {
            const text = await readTextLimited(response, 4096).catch(() => '')
            throw new HttpError(502, `拉取模型失败（HTTP ${response.status}）${text ? `：${safeDetail(text, secretValues, 200)}` : ''}`)
          }
          let jsonBody: unknown
          try {
            jsonBody = await readJsonLimited(response, LIMITS.models_response_max_bytes)
          } catch (err) {
            throw new HttpError(502, `解析模型列表失败：${safeDetail(errorMessage(err), secretValues, 200)}`)
          }
          const data: ModelsResponse = { ok: true, models: adapter.parseListModels(jsonBody) }
          return json(data)
        } finally {
          handleAbort.cleanup()
        }
      }),
    },
  ]
}
