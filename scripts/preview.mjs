#!/usr/bin/env node
/**
 * 本地预览配置页：起一个静态服务器，用假的 /bridge.js 和内存配置，
 * 不连机器人、不读 KV。只用于看页面和点交互；真实路由以插件构建产物为准。
 *
 * 预览尽量贴近真实运行时，好让安全边界与错误路径也能点出来：
 * - `auth: 'admin'` 的页面带 `Content-Security-Policy: sandbox`，与线上一样是 opaque origin；
 * - 路由挂在 `/p/llm/api/*` 下（与线上 `/p/<插件名>/` 前缀一致），`/api/*` 只是别名；
 * - `?fail=409` / `?fail=503` / `?corrupt=1` 可以复现保存冲突、KV 读失败、配置损坏三条路径。
 */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const port = Number(process.env.PORT ?? 4173)

const generated = await readFile(path.join(root, 'src/page.generated.ts'), 'utf8')
const page = JSON.parse(generated.slice(generated.indexOf('=') + 1))

/** 与 packages/runtime/src/routes.ts 的 ADMIN_PAGE_CSP 一致 */
const ADMIN_PAGE_CSP = 'sandbox allow-scripts allow-forms allow-popups allow-downloads'

async function readTokens() {
  const explicit = process.env.TOKENS_CSS
  if (explicit) return await readFile(explicit, 'utf8')
  for (const dir of ['../QFlareBot', '../qqbot-workers']) {
    try {
      return await readFile(path.resolve(root, dir, 'packages/ui-bridge/src/tokens.css'), 'utf8')
    } catch {
      // 换下一个常见的同级目录名
    }
  }
  throw new Error('找不到 QFlareBot 的 tokens.css：把框架仓库放在本仓库旁边的 QFlareBot 或 qqbot-workers，或设置 TOKENS_CSS')
}
const tokens = await readTokens()

const bridge = String.raw`
let config = {
  schema_version: 1,
  version: 1,
  providers: [
    { id: 'deepseek', name: 'DeepSeek', protocol: 'openai', base_url: 'https://api.deepseek.com/v1', headers: {}, timeout_ms: 25000, enabled: true, api_key_set: true },
    { id: 'anthropic', name: 'Anthropic', protocol: 'anthropic', base_url: 'https://api.anthropic.com/v1', headers: {}, timeout_ms: 25000, enabled: true, api_key_set: false }
  ],
  models: [
    {
      alias: 'chat', provider: 'deepseek', model: 'deepseek-chat', max_tokens: 2048, temperature: 0.7, enabled: true,
      context_window: 128000, max_output_tokens: 8192, capabilities: ['text', 'tools', 'json']
    },
    {
      alias: 'reasoner', provider: 'deepseek', model: 'deepseek-reasoner', enabled: true,
      context_window: 128000, max_output_tokens: 64000, capabilities: ['text', 'tools', 'json', 'reasoning']
    },
    {
      alias: 'claude', provider: 'anthropic', model: 'claude-sonnet-4-5', enabled: true,
      context_window: 200000, max_output_tokens: 64000, capabilities: ['text', 'image', 'tools', 'reasoning']
    }
  ],
  default_model: 'chat',
  request_timeout_ms: 15000,
  max_retries: 1,
  updated_at: new Date().toISOString()
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })
}

function toast(message) {
  const el = document.createElement('div')
  el.textContent = message
  el.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:var(--qb-surface);color:var(--qb-fg);border:1px solid var(--qb-border);border-radius:999px;padding:8px 16px;box-shadow:var(--qb-shadow);z-index:99;font-size:13px'
  document.body.append(el)
  setTimeout(() => el.remove(), 2200)
}

export async function createBridge() {
  const params = new URLSearchParams(location.search)
  const theme = params.get('theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
  const fail = params.get('fail') || ''
  const corrupt = params.get('corrupt') === '1'
  document.documentElement.dataset.theme = theme
  let version = config.version
  return {
    embedded: false,
    plugin: 'llm',
    base: '/p/llm',
    theme,
    async fetch(input, init) {
      // 与真实 @qqbot/ui-bridge 一致：相对路径按插件路由根解析（/api/x → /p/llm/api/x）
      const raw = String(input)
      const path = raw.startsWith('/api/') ? '/p/llm' + raw : new URL(raw, location.origin).pathname
      if (fail === '503') {
        return json({ ok: false, error: '读取配置失败，请稍后重试' }, 503)
      }
      if (path.endsWith('/api/meta')) {
        return json({
          ok: true,
          plugin: { name: 'llm', version: '0.1.0' },
          service: { name: 'llm', contractVersion: 1 },
          protocols: [
            { id: 'openai', label: 'OpenAI 兼容', capabilities: ['tools', 'json'], default_base_url: 'https://api.openai.com/v1', base_url_hint: '以 /v1 结尾，例如 https://api.deepseek.com/v1' },
            { id: 'anthropic', label: 'Anthropic Messages', capabilities: ['tools'], default_base_url: 'https://api.anthropic.com/v1', base_url_hint: '以 /v1 结尾，例如 https://api.anthropic.com/v1' }
          ],
          limits: { timeout_min: 1000, timeout_max: 28000, call_timeout_max: 20000, max_retries: 2, max_tokens_max: 131072, body_max_bytes: 262144, response_max_bytes: 2097152, stream_max_bytes: 8388608 }
        })
      }
      if (path.endsWith('/api/config')) {
        if (init?.method === 'PUT') {
          if (fail === '409') {
            return json({ ok: false, error: '配置已经被修改，请刷新页面后再保存', config }, 409)
          }
          const body = JSON.parse(init.body)
          if (body.version !== version) {
            return json({ ok: false, error: '配置已经被修改，请刷新页面后再保存', config }, 409)
          }
          const next = JSON.parse(JSON.stringify(body.config))
          next.schema_version = 1
          version += 1
          next.version = version
          next.updated_at = new Date().toISOString()
          next.providers = next.providers.map((p) => {
            const key = p.api_key
            const previous = config.providers.find((item) => item.id === p.id)
            delete p.api_key
            p.api_key_set = key === null ? false : typeof key === 'string' && key.trim() ? true : Boolean(previous?.api_key_set)
            return p
          })
          config = next
          return json({ ok: true, config, issues: [], dropped_secrets: [] })
        }
        return json({ ok: true, config, issues: [], corrupt })
      }
      if (path.endsWith('/api/test')) {
        const body = JSON.parse(init.body)
        const alias = body?.target?.alias || config.default_model || 'chat'
        return json({ ok: true, result: { ok: true, latency_ms: 168, provider: 'deepseek', model: 'deepseek-chat', alias, text: 'pong', usage: { input_tokens: 12, output_tokens: 2 } } })
      }
      if (path.endsWith('/api/upstream-models')) {
        return json({ ok: true, models: ['deepseek-chat', 'deepseek-reasoner', 'deepseek-coder'] })
      }
      return json({ ok: false, error: 'preview 未实现 ' + path }, 404)
    },
    onTheme() { return () => {} },
    toast,
    navigate() {},
    setTitle(title) { document.title = title },
    resize() {}
  }
}
`

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${port}`)

  // 与线上一致：插件路由挂在 /p/<插件名>/ 下；/api/* 保留为便捷别名。
  // 页面里的 bridge.fetch('/api/...') 会被解析成 /p/llm/api/...，两条都要能走。
  let pathname = url.pathname
  if (pathname.startsWith('/p/llm/')) pathname = pathname.slice('/p/llm'.length)
  else if (pathname === '/p/llm') pathname = '/'

  if (pathname === '/bridge.js') {
    // 页面带 CSP sandbox 是 opaque origin，跨源加载 ES 模块需要 ACAO（与线上 runtime 返回 ACAO:* 一致）
    res.writeHead(200, {
      'content-type': 'text/javascript; charset=utf-8',
      'access-control-allow-origin': '*',
    })
    res.end(bridge)
    return
  }
  if (pathname === '/tokens.css') {
    res.writeHead(200, {
      'content-type': 'text/css; charset=utf-8',
      'access-control-allow-origin': '*',
    })
    res.end(tokens)
    return
  }
  if (pathname === '/favicon.ico') {
    res.writeHead(204)
    res.end()
    return
  }
  if (pathname === '/ui/' || pathname === '/ui') {
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      // 线上 auth:'admin' 的 HTML 带这条 CSP；不加的话预览是同源页面，测不出 opaque origin 的问题
      'content-security-policy': ADMIN_PAGE_CSP,
    })
    res.end(page)
    return
  }

  // API 由页面里的假 bridge 直接处理（它不经过这个静态服务器），走到这里说明是未知路径
  if (pathname.startsWith('/api/')) {
    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: false, error: 'preview 未实现 ' + pathname }))
    return
  }

  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
  res.end('Not Found')
})

server.listen(port, '127.0.0.1', () => {
  console.log(`预览：http://127.0.0.1:${port}/p/llm/ui/`)
  console.log('场景：?fail=409（保存冲突）、?fail=503（KV 读失败）、?corrupt=1（配置损坏）')
})
