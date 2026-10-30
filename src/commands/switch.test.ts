import { describe, expect, it } from 'vitest'
import type { ModelInfo } from '../contract.js'
import type { StoredConfig } from '../config/types.js'
import { createDefaultConfig } from '../config/defaults.js'
import { formatModelList, resolveModelChoice, withDefaultModel } from './switch.js'

/**
 * `/llm use` 的纯逻辑。
 *
 * 对标 AstrBot 的 `/provider <idx>`，但接受**序号和别名两种写法** ——
 * 序号短但会随配置变动错位，别名稳定但要多打几个字，两样都给。
 */

function model(alias: string, provider = 'openai-a', name = 'gpt-4o'): ModelInfo {
  return { alias, provider, model: name, capabilities: ['text'] }
}

const models = [model('chat'), model('code', 'openai-a', 'gpt-4o-mini'), model('fast', 'anthropic-a', 'claude-haiku')]

describe('formatModelList', () => {
  it('列出所有模型，带序号、别名、模型名、供应商', () => {
    const lines = formatModelList(models, 'chat')
    const text = lines.join('\n')
    expect(text).toContain('1. chat')
    expect(text).toContain('2. code')
    expect(text).toContain('3. fast')
    expect(text).toContain('gpt-4o')
    expect(text).toContain('anthropic-a')
  })

  it('标出当前使用的那一个', () => {
    const text = formatModelList(models, 'code').join('\n')
    // 只有 code 那行有标记
    const marked = text.split('\n').filter((line) => line.includes('👈'))
    expect(marked).toHaveLength(1)
    expect(marked[0]).toContain('code')
  })

  it('没有模型时给出可操作的提示，而不是空白', () => {
    const text = formatModelList([], '').join('\n')
    expect(text).toContain('还没有配置任何模型')
    // 要告诉用户去哪里配，否则他不知道下一步做什么
    expect(text).toContain('LLM 接口')
  })

  it('当前默认不在可用列表里时明确说出来', () => {
    // 比如模型被删了、或被停用了，但 default_model 还指着它
    const text = formatModelList(models, 'gone').join('\n')
    expect(text).toContain('不在可用列表里')
  })

  it('带上切换用法的提示', () => {
    expect(formatModelList(models, 'chat').join('\n')).toContain('/llm use')
  })
})

describe('resolveModelChoice：序号', () => {
  it('有效序号 → 切换到对应别名', () => {
    expect(resolveModelChoice('2', models, 'chat')).toEqual({ kind: 'switch', alias: 'code' })
  })

  it('切到当前已经在用的模型 → noop（不写 KV）', () => {
    expect(resolveModelChoice('1', models, 'chat')).toEqual({ kind: 'noop', alias: 'chat' })
  })

  it('序号越界 → 报错并给出范围', () => {
    const plan = resolveModelChoice('9', models, 'chat')
    expect(plan.kind).toBe('error')
    expect(plan.kind === 'error' && plan.message).toContain('1–3')
  })

  it('序号 0 也越界（不是从 0 开始）', () => {
    expect(resolveModelChoice('0', models, 'chat').kind).toBe('error')
  })

  it('负数不被当成序号，而是走别名匹配（然后失败）', () => {
    const plan = resolveModelChoice('-1', models, 'chat')
    expect(plan.kind).toBe('error')
  })
})

describe('resolveModelChoice：别名', () => {
  it('精确匹配', () => {
    expect(resolveModelChoice('code', models, 'chat')).toEqual({ kind: 'switch', alias: 'code' })
  })

  it('忽略大小写匹配（用户可能记不清）', () => {
    expect(resolveModelChoice('CODE', models, 'chat')).toEqual({ kind: 'switch', alias: 'code' })
  })

  it('别名不存在时列出可用清单（打错字时最需要看到正确拼写）', () => {
    const plan = resolveModelChoice('gpt4', models, 'chat')
    expect(plan.kind).toBe('error')
    expect(plan.kind === 'error' && plan.message).toContain('chat、code、fast')
  })

  it('切到当前别名的不同大小写 → noop', () => {
    expect(resolveModelChoice('CHAT', models, 'chat')).toEqual({ kind: 'noop', alias: 'chat' })
  })

  it('空输入给出用法', () => {
    const plan = resolveModelChoice('   ', models, 'chat')
    expect(plan.kind).toBe('error')
    expect(plan.kind === 'error' && plan.message).toContain('用法')
  })

  it('没有任何模型时提示去配置（而不是只说「没找到」）', () => {
    const plan = resolveModelChoice('x', [], '')
    expect(plan.kind).toBe('error')
    expect(plan.kind === 'error' && plan.message).toContain('LLM 接口')
  })
})

describe('withDefaultModel', () => {
  const base: StoredConfig = {
    ...createDefaultConfig(new Date('2026-01-01T00:00:00Z')),
    providers: [{ id: 'openai-a', name: 'A', protocol: 'openai', base_url: 'https://x', enabled: true }],
    models: [{ alias: 'chat', provider: 'openai-a', model: 'gpt-4o', enabled: true }],
    default_model: 'chat',
    version: 5,
  }

  it('只改 default_model，不动其他字段', () => {
    const next = withDefaultModel(base, 'code')
    expect(next.default_model).toBe('code')
    // 供应商与模型列表必须原样带过来，否则等于把用户的配置清空了
    expect(next.providers).toEqual(base.providers)
    expect(next.models).toEqual(base.models)
    expect(next.request_timeout_ms).toBe(base.request_timeout_ms)
    expect(next.schema_version).toBe(base.schema_version)
  })

  it('version 必须 +1（页面用它对乐观并发做校验）', () => {
    // 不升版本的话：页面下一次保存会带着旧版本号，被误判成冲突，
    // 或者更糟 —— 直接覆盖掉这次切换
    expect(withDefaultModel(base, 'code').version).toBe(6)
  })

  it('更新 updated_at，便于排障时看出配置被动过', () => {
    const next = withDefaultModel(base, 'code', new Date('2026-02-02T00:00:00Z'))
    expect(next.updated_at).toBe('2026-02-02T00:00:00.000Z')
  })

  it('不修改传入的对象（纯函数）', () => {
    withDefaultModel(base, 'code')
    expect(base.default_model).toBe('chat')
    expect(base.version).toBe(5)
  })
})
