import { createMockContext } from '@qqbot/sdk/testing'
import { describe, expect, it } from 'vitest'
import plugin from './index.js'
import { LLM } from './service.js'
import { createDefaultConfig } from './config/defaults.js'
import type { StoredConfig } from './config/types.js'

describe('插件定义', () => {
  it('导出 llm 服务、管理页与路由，不走 configSchema', () => {
    expect(plugin.name).toBe('llm')
    expect(plugin.apiVersion).toBe(1)
    expect(plugin.configSchema).toBeUndefined()
    expect(Object.keys(plugin.services ?? {})).toEqual(['llm'])
    expect(plugin.ui?.path).toBe('/ui/')
    expect(plugin.routes?.map((item) => `${item.method} ${item.path}`)).toEqual([
      'GET /ui/*',
      'GET /api/meta',
      'GET /api/config',
      'PUT /api/config',
      'POST /api/test',
      'POST /api/upstream-models',
    ])
  })

  it('服务工厂返回 LLM 实例', () => {
    const ctx = createMockContext(plugin)
    const service = plugin.services!.llm!(ctx)
    expect(service).toBeInstanceOf(LLM)
  })
})

/**
 * `/llm` 命令：查看与切换默认模型。
 *
 * 对标 AstrBot 的 `/provider`。这里是**接线测试** —— 纯逻辑在
 * `commands/switch.test.ts` 里测过了，这一层验证「命令真的取到了服务、
 * 真的写进了配置、真的会回复用户」。
 *
 * 这类测试在本项目里是必须的：单测能证明函数对，证明不了它被调用。
 */
describe('/llm 命令', () => {
  /** 命令定义可能是函数或对象，统一取出 handler */
  function commandHandler() {
    const command = plugin.commands!.llm
    const spec = command as { handler: (input: { ctx: unknown; argText: string }) => Promise<string> }
    return spec.handler
  }

  /** 造一个带两个模型的上下文，返回命令 handler 和 KV 写入计数 */
  function setup(config?: Partial<StoredConfig>) {
    const stored: StoredConfig = {
      ...createDefaultConfig(),
      providers: [
        { id: 'openai-a', name: 'A', protocol: 'openai', base_url: 'https://x', enabled: true },
        { id: 'anthropic-a', name: 'B', protocol: 'anthropic', base_url: 'https://y', enabled: true },
      ],
      models: [
        { alias: 'chat', provider: 'openai-a', model: 'gpt-4o', enabled: true },
        { alias: 'fast', provider: 'anthropic-a', model: 'claude-haiku', enabled: true },
      ],
      default_model: 'chat',
      ...config,
    }

    let writes = 0
    // ctx.kv 是只读属性，用 Object.assign 替换整块存储
    const kv = {
      async get() {
        return JSON.stringify(stored)
      },
      async getJSON() {
        return null
      },
      async put() {
        writes += 1
        return undefined
      },
      async delete() {
        return undefined
      },
      async list() {
        return new Map()
      },
    }
    // 先把 kv 装好，再用同一个 ctx 造服务，最后把服务注入命令用的 ctx
    const seed = createMockContext(plugin)
    Object.assign(seed, { kv })
    const ctx = createMockContext(plugin, { services: { llm: plugin.services!.llm!(seed) } })
    const handler = commandHandler()

    return {
      run: (argText: string) => handler({ ctx, argText }),
      writes: () => writes,
      stored,
    }
  }

  it('不带参数时列出模型并标出当前使用的', async () => {
    const { run } = setup()
    const out = await run('')
    expect(out).toContain('chat')
    expect(out).toContain('fast')
    // 当前的是 chat
    const marked = out.split('\n').find((line) => line.includes('👈'))
    expect(marked).toContain('chat')
  })

  it('/llm use <别名> 切换并写配置', async () => {
    const { run, writes } = setup()
    const out = await run('use fast')
    expect(out).toContain('已切换到')
    expect(out).toContain('fast')
    expect(writes()).toBe(1)
  })

  it('/llm use <序号> 也能切', async () => {
    const { run } = setup()
    const out = await run('use 2')
    expect(out).toContain('fast')
  })

  it('已经是用着的模型时不写 KV（额度只有 1,000 次/天）', async () => {
    const { run, writes } = setup()
    const out = await run('use chat')
    expect(out).toContain('已经在用')
    expect(writes()).toBe(0)
  })

  it('模型不存在时给出可读错误，不写配置', async () => {
    const { run, writes } = setup()
    const out = await run('use nope')
    expect(out).toContain('没有名为')
    expect(out).toContain('chat、fast')
    expect(writes()).toBe(0)
  })

  it('没有任何模型时提示去面板配置', async () => {
    const { run } = setup({ models: [], default_model: '' })
    const out = await run('')
    expect(out).toContain('还没有配置任何模型')
    expect(out).toContain('LLM 接口')
  })

  it('配置损坏时给出可操作的错误（不是抛异常）', async () => {
    const seed = createMockContext(plugin)
    Object.assign(seed, {
      kv: {
        async get() {
          return 'not json'
        },
        async getJSON() {
          return null
        },
        async put() {
          return undefined
        },
        async delete() {
          return undefined
        },
        async list() {
          return new Map()
        },
      },
    })
    const ctx = createMockContext(plugin, { services: { llm: plugin.services!.llm!(seed) } })

    const out = await commandHandler()({ ctx, argText: '' })
    expect(out).toContain('操作失败')
  })

  it('切换后的提示明确说明「全局生效」（避免用户以为只影响当前会话）', async () => {
    const { run } = setup()
    const out = await run('use fast')
    expect(out).toContain('全局')
  })

  it('有中文别名 /llm 模型', () => {
    const spec = plugin.commands!.llm as { aliases?: string[] }
    expect(spec.aliases).toContain('llm 模型')
  })
})
