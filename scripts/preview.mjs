#!/usr/bin/env node
/**
 * 本地预览配置页：起一个静态服务器，用假的 /bridge.js 和内存配置，
 * 不连机器人、不读 KV。只用于看页面和点交互；真实路由以插件构建产物为准。
 */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const port = Number(process.env.PORT ?? 4173)

const generated = await readFile(path.join(root, 'src/page.generated.ts'), 'utf8')
const page = JSON.parse(generated.slice(generated.indexOf('=') + 1))

async function readTokens() {
  for (const dir of ['../QFlareBot', '../qqbot-workers']) {
    try {
      return await readFile(path.resolve(root, dir, 'packages/ui-bridge/src/tokens.css'), 'utf8')
    } catch {
      // 换下一个常见的同级目录名
    }
  }
  throw new Error('找不到 QFlareBot 的 tokens.css：把框架仓库放在本仓库旁边的 QFlareBot 或 qqbot-workers')
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
    { alias: 'chat', provider: 'deepseek', model: 'deepseek-chat', max_tokens: 2048, temperature: 0.7, enabled: true },
    { alias: 'reasoner', provider: 'deepseek', model: 'deepseek-reasoner', enabled: true }
  ],
  default_model: 'chat',
  request_timeout_ms: 25000,
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
  const theme = new URLSearchParams(location.search).get('theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
  document.documentElement.dataset.theme = theme
  return {
    embedded: false,
    plugin: 'llm',
    base: '/p/llm',
    theme,
    async fetch(input, init) {
      const path = new URL(input, location.origin).pathname
      if (path.endsWith('/api/meta')) {
        return json({
          ok: true,
          plugin: { name: 'llm', version: '0.1.0' },
          service: { name: 'llm', contractVersion: 1 },
          protocols: [
            { id: 'openai', label: 'OpenAI 兼容', capabilities: ['tools', 'json'], default_base_url: 'https://api.openai.com/v1', base_url_hint: '以 /v1 结尾，例如 https://api.deepseek.com/v1' },
            { id: 'anthropic', label: 'Anthropic Messages', capabilities: ['tools'], default_base_url: 'https://api.anthropic.com/v1', base_url_hint: '以 /v1 结尾，例如 https://api.anthropic.com/v1' }
          ],
          limits: { timeout_min: 1000, timeout_max: 28000, max_retries: 2, max_tokens_max: 131072, body_max_bytes: 262144 }
        })
      }
      if (path.endsWith('/api/config')) {
        if (init?.method === 'PUT') {
          const body = JSON.parse(init.body)
          const next = JSON.parse(JSON.stringify(body.config))
          next.schema_version = 1
          next.version = config.version + 1
          next.updated_at = new Date().toISOString()
          next.providers = next.providers.map((p) => {
            const key = p.api_key
            const previous = config.providers.find((item) => item.id === p.id)
            delete p.api_key
            p.api_key_set = Boolean(key) || Boolean(previous?.api_key_set) || Boolean(p.api_key_set)
            return p
          })
          config = next
          return json({ ok: true, config, issues: [] })
        }
        return json({ ok: true, config, issues: [], corrupt: false })
      }
      if (path.endsWith('/api/test')) {
        const body = JSON.parse(init.body)
        const alias = body?.target?.alias || config.default_model || 'chat'
        return json({ ok: true, result: { ok: true, latency_ms: 168, provider: 'deepseek', model: 'deepseek-chat', alias, text: 'pong', usage: { input_tokens: 12, output_tokens: 2 } } })
      }
      if (path.endsWith('/api/upstream-models')) {
        return json({ ok: true, models: ['deepseek-chat', 'deepseek-reasoner', 'deepseek-coder'] })
      }
      return json({ ok: false, error: 'preview 未实现该接口' }, 404)
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
  if (url.pathname === '/bridge.js') {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
    res.end(bridge)
    return
  }
  if (url.pathname === '/tokens.css') {
    res.writeHead(200, { 'content-type': 'text/css; charset=utf-8' })
    res.end(tokens)
    return
  }
  if (url.pathname === '/favicon.ico') {
    res.writeHead(204)
    res.end()
    return
  }
  if (url.pathname === '/p/llm/ui/' || url.pathname === '/p/llm/ui') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(page)
    return
  }
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
  res.end('Not Found')
})

server.listen(port, '127.0.0.1', () => {
  console.log(`预览：http://127.0.0.1:${port}/p/llm/ui/`)
})
