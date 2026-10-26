import type { Route, RouteInput } from '@qqbot/sdk'
import type { ApiError, ConfigGetResponse, ConfigPutResponse, MetaResponse, ModelsResponse, TestResponse } from './apiTypes.js'
import { hasErrors, LIMITS, mergeSecrets, normalizeProvider, toPublicConfig, validateConfig } from './config/index.js'
import type { ConfigIssue, PublicConfigInput, StoredConfig } from './config/types.js'
import { LLMError, errorMessage } from './errors.js'
import { createAbortHandle, HttpError, json, readJson, readJsonLimited, readTextLimited, redact, truncate } from './http.js'
import { isRecord } from './json.js'
import { adapterFor, protocolMeta } from './protocols/registry.js'
import { LLM } from './service.js'
import { createConfigStore, fixedStore } from './store.js'
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

function configInput(value: unknown): PublicConfigInput {
  if (!isRecord(value)) throw new HttpError(400, 'config 必须是对象')
  if (!Array.isArray(value['providers']) || !Array.isArray(value['models'])) {
    throw new HttpError(400, 'config.providers / config.models 必须是数组')
  }
  return value as unknown as PublicConfigInput
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
          limits: { ...LIMITS },
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
        await store.write(next)
        const data: ConfigPutResponse = { ok: true, config: toPublicConfig(next), issues }
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

        let store = createConfigStore(ctx)
        if (body['draft'] !== undefined) {
          const current = await store.read()
          store = fixedStore(storedFromDraft(configInput(body['draft']), current.config))
        }

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
        const provider = normalizeProvider(raw, 0)
        if (!provider.id) throw new HttpError(400, 'provider.id 必填')
        if (!provider.base_url) throw new HttpError(400, 'provider.base_url 必填')

        const current = await createConfigStore(ctx).read()
        const existing = current.config.providers.find((item) => item.id === provider.id)
        const cleared = raw['api_key'] === null
        if (!cleared && !provider.api_key && existing?.api_key) provider.api_key = existing.api_key

        const adapter = adapterFor(provider.protocol)
        const built = adapter.buildListModels(provider)
        const handleAbort = createAbortHandle(20000)
        try {
          let response: Response
          try {
            response = await fetch(built.url, { ...built.init, signal: handleAbort.signal })
          } catch (err) {
            if (handleAbort.timedOut()) throw new HttpError(504, '拉取模型超时（20 秒）')
            throw new HttpError(502, `连接上游失败：${truncate(errorMessage(err), 200)}`)
          }
          if (!response.ok) {
            const text = await readTextLimited(response, 4096).catch(() => '')
            throw new HttpError(502, `拉取模型失败（HTTP ${response.status}）${text ? `：${truncate(redact(text, provider.api_key), 200)}` : ''}`)
          }
          let jsonBody: unknown
          try {
            jsonBody = await readJsonLimited(response, 2 * 1024 * 1024)
          } catch (err) {
            throw new HttpError(502, `解析模型列表失败：${truncate(errorMessage(err), 200)}`)
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
