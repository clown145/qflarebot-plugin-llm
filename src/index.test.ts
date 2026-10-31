import { createMockContext } from '@qqbot/sdk/testing'
import type { PluginContext } from '@qqbot/sdk'
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

  it('清单里不声明 depends（自己提供的服务不能声明成依赖）', () => {
    // `depends: { llm: '*' }` 会让全新安装在依赖检查阶段被判成 dependencies_missing（400），
    // 这是修复 `/llm` 命令时最容易走错的那条路。这里锁住 manifest 的形状。
    expect(plugin.depends).toBeUndefined()
  })
})

/**
 * `/llm` 命令：查看与切换默认模型。
 *
 * ## 这组测试为什么必须让 `ctx.service()` 抛错
 *
 * 命令曾经写成 `ctx.service<LLM>('llm')`。本插件 manifest 里 `depends: {}`，
 * 而框架的 `ctx.service()` 对**没在 depends 里声明的服务是硬拒绝**：
 *
 * ```
 * 插件 llm 没有在 depends 中声明服务 llm
 * ```
 *
 * 于是 `/llm` 在真实运行时 100% 不可用。旧测试用 `createMockContext(plugin, { services })`
 * 手工把服务注入进去，恰好绕过了那道门禁——365 个测试全绿，命令一次都跑不通。
 *
 * 所以这里**故意让 `service()` 抛错**：命令只要还依赖它，测试立刻失败。
 */
describe('/llm 命令', () => {
  /** 命令定义可能是函数或对象，统一取出 handler */
  function commandHandler() {
    const command = plugin.commands!.llm
    const spec = command as { handler: (input: { ctx: unknown; argText: string }) => Promise<string> }
    return spec.handler
  }

  function sampleConfig(overrides: Partial<StoredConfig> = {}): StoredConfig {
    return {
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
      ...overrides,
    }
  }

  /**
   * 造一个「像真实运行时一样」的上下文：
   * - KV 里放着配置；
   * - `service()` 抛框架的原话，任何代码路径走它都会炸。
   */
  function setup(overrides: Partial<StoredConfig> = {}): {
    ctx: PluginContext<unknown>
    run: (argText: string) => Promise<string>
    writes: () => number
    kv: { get: (key?: string) => Promise<string | null> }
  } {
    const stored = sampleConfig(overrides)
    let writes = 0
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
    const base = createMockContext(plugin)
    const ctx = {
      ...base,
      kv: { ...base.kv, ...kv },
      // 框架的真实行为：没在 depends 声明就抛错
      service<T>(): T {
        throw new Error('插件 llm 没有在 depends 中声明服务 llm')
      },
    } as unknown as PluginContext<unknown>
    const handler = commandHandler()
    return {
      ctx,
      run: (argText: string) => handler({ ctx, argText }),
      writes: () => writes,
      kv,
    }
  }

  it('ctx.service() 会抛错，命令仍然能列出模型（P0 回归）', async () => {
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
    const base = createMockContext(plugin)
    const ctx = {
      ...base,
      kv: {
        ...base.kv,
        async get() {
          return 'not json'
        },
      },
      service<T>(): T {
        throw new Error('插件 llm 没有在 depends 中声明服务 llm')
      },
    } as unknown as PluginContext<unknown>

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
