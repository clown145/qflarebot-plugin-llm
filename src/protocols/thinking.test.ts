import { describe, expect, it } from 'vitest'
import type { ChatRequest } from '../contract.js'
import { anthropic } from './anthropic.js'
import { gemini } from './gemini.js'
import { openai } from './openai.js'
import type { BuiltRequest, Target } from './types.js'
import { ANTHROPIC_MIN_BUDGET, isGemini3 } from './thinking.js'

const target = (overrides: Partial<Target['model']> = {}, protocol: Target['provider']['protocol'] = 'openai'): Target => ({
  provider: { id: 'p', name: 'p', protocol, base_url: 'https://api.example.com/v1', enabled: true },
  model: { alias: 'a', provider: 'p', model: 'm', enabled: true, ...overrides },
})

const request = (extra: Partial<ChatRequest> = {}): ChatRequest => ({
  messages: [{ role: 'user', content: 'hi' }],
  ...extra,
})

function bodyOf(built: BuiltRequest): Record<string, unknown> {
  return JSON.parse(String(built.init.body)) as Record<string, unknown>
}

describe('思考等级 → OpenAI 兼容的 reasoning_effort', () => {
  it('模型配了等级就发 reasoning_effort', () => {
    const body = bodyOf(openai.buildChat(target({ reasoning_effort: 'high' }), request(), false))
    expect(body['reasoning_effort']).toBe('high')
  })

  it('没配等级时**完全不出现**该字段（对不认它的网关零影响）', () => {
    const body = bodyOf(openai.buildChat(target(), request(), false))
    expect('reasoning_effort' in body).toBe(false)
  })

  it('请求里显式传的等级覆盖模型默认值', () => {
    const body = bodyOf(
      openai.buildChat(target({ reasoning_effort: 'low' }), request({ reasoning_effort: 'high' }), false),
    )
    expect(body['reasoning_effort']).toBe('high')
  })

  it('调用方通过 extra_body 自己写的 reasoning_effort 优先', () => {
    const body = bodyOf(
      openai.buildChat(
        target({ reasoning_effort: 'low' }),
        request({ extra_body: { reasoning_effort: 'medium' } }),
        false,
      ),
    )
    expect(body['reasoning_effort']).toBe('medium')
  })

  it('四个等级都原样透传', () => {
    for (const effort of ['minimal', 'low', 'medium', 'high'] as const) {
      const body = bodyOf(openai.buildChat(target({ reasoning_effort: effort }), request(), false))
      expect(body['reasoning_effort']).toBe(effort)
    }
  })
})

describe('思考等级 → Anthropic 的 thinking', () => {
  it('low/medium/high 产出 budget_tokens，且随等级递增', () => {
    const budgets = (['low', 'medium', 'high'] as const).map((effort) => {
      const body = bodyOf(anthropic.buildChat(target({ reasoning_effort: effort }, 'anthropic'), request(), false))
      const thinking = body['thinking'] as { type: string; budget_tokens: number }
      expect(thinking.type).toBe('enabled')
      return thinking.budget_tokens
    })
    expect(budgets[0]).toBeGreaterThanOrEqual(ANTHROPIC_MIN_BUDGET)
    expect(budgets[1]).toBeGreaterThan(budgets[0]!)
    expect(budgets[2]).toBeGreaterThan(budgets[1]!)
  })

  it('minimal 不发 thinking 字段（Anthropic 没有「想一点点」这一档）', () => {
    const body = bodyOf(anthropic.buildChat(target({ reasoning_effort: 'minimal' }, 'anthropic'), request(), false))
    expect('thinking' in body).toBe(false)
  })

  it('没配等级时不发 thinking', () => {
    const body = bodyOf(anthropic.buildChat(target({}, 'anthropic'), request(), false))
    expect('thinking' in body).toBe(false)
  })

  it('开启思考时 max_tokens 必须严格大于预算，并给正文留出余量', () => {
    const body = bodyOf(anthropic.buildChat(target({ reasoning_effort: 'high' }, 'anthropic'), request(), false))
    const thinking = body['thinking'] as { budget_tokens: number }
    const maxTokens = body['max_tokens'] as number
    expect(maxTokens).toBeGreaterThan(thinking.budget_tokens)
    // 以前断言「抬到预算的两倍」——那正是把 max_tokens 抬到 16384、撞上
    // claude-3-5-sonnet 8192 输出上限的 bug（P2-10）。契约只要求严格大于 + 有余量。
    // 这里写死 1024（不引用实现里的常量），避免「改常量就把测试一起改绿」。
    expect(maxTokens - thinking.budget_tokens).toBeGreaterThanOrEqual(1024)
  })

  it('模型的 max_output_tokens 是硬上限：预算 + 余量超了要压回上限以内（P2-10 回归）', () => {
    // claude-3-5-sonnet 这类模型输出上限 8192；high 的预算 8192 必须被压到 8192-余量，
    // 而不是像旧实现那样抬成 16384（上游直接 400）
    const body = bodyOf(
      anthropic.buildChat(
        target({ reasoning_effort: 'high', max_output_tokens: 8192 }, 'anthropic'),
        request(),
        false,
      ),
    )
    const thinking = body['thinking'] as { budget_tokens: number }
    const maxTokens = body['max_tokens'] as number
    expect(maxTokens).toBeLessThanOrEqual(8192)
    expect(maxTokens).toBeGreaterThan(thinking.budget_tokens)
    expect(thinking.budget_tokens).toBeLessThanOrEqual(8192 - 1024)
  })

  it('输出上限小到放不下思考时，宁可不开思考也不发必 400 的组合', () => {
    const body = bodyOf(
      anthropic.buildChat(
        target({ reasoning_effort: 'high', max_output_tokens: 1600 }, 'anthropic'),
        request(),
        false,
      ),
    )
    expect('thinking' in body).toBe(false)
    expect(body['max_tokens']).toBe(1600)
  })

  it('调用方传了更大的 max_tokens 时尊重它，只保证严格大于预算', () => {
    // 注意：模型配置里的 max_tokens 由 service.prepare 转成 request.max_tokens
    // 后才到达 buildChat，所以这里直接测请求层（服务层的默认值应用另有测试）
    const body = bodyOf(
      anthropic.buildChat(
        target({ reasoning_effort: 'low' }, 'anthropic'),
        request({ max_tokens: 32000 }),
        false,
      ),
    )
    expect(body['max_tokens']).toBe(32000)
  })
})

describe('思考等级 → Gemini 的 thinkingConfig', () => {
  it('2.5 系列用 thinkingBudget（token 数）', () => {
    const body = bodyOf(
      gemini.buildChat(
        target({ reasoning_effort: 'high', model: 'gemini-2.5-pro' }),
        request(),
        false,
      ),
    )
    const config = body['generationConfig'] as Record<string, unknown>
    expect((config['thinkingConfig'] as Record<string, unknown>)['thinkingBudget']).toBe(8192)
    expect((config['thinkingConfig'] as Record<string, unknown>)['thinkingLevel']).toBeUndefined()
  })

  it('2.5 系列的 minimal 是 thinkingBudget: 0（关闭思考）', () => {
    const body = bodyOf(
      gemini.buildChat(
        target({ reasoning_effort: 'minimal', model: 'gemini-2.5-flash' }),
        request(),
        false,
      ),
    )
    const config = body['generationConfig'] as Record<string, unknown>
    expect((config['thinkingConfig'] as Record<string, unknown>)['thinkingBudget']).toBe(0)
  })

  it('3.x 系列改用 thinkingLevel，且不能同时带 thinkingBudget', () => {
    for (const name of ['gemini-3-pro-preview', 'gemini-3.0-flash']) {
      const body = bodyOf(
        gemini.buildChat(
          target({ reasoning_effort: 'medium', model: name }),
          request(),
          false,
        ),
      )
      const config = body['generationConfig'] as Record<string, unknown>
      const thinking = config['thinkingConfig'] as Record<string, unknown>
      expect(thinking['thinkingLevel']).toBe('MEDIUM')
      expect(thinking['thinkingBudget']).toBeUndefined()
    }
  })

  it('没配等级时不发 thinkingConfig', () => {
    const body = bodyOf(gemini.buildChat(target(), request(), false))
    const config = body['generationConfig'] as Record<string, unknown>
    expect('thinkingConfig' in config).toBe(false)
  })

  it('调用方通过 extra_body 传的 thinkingConfig 优先', () => {
    const body = bodyOf(
      gemini.buildChat(
        target({ reasoning_effort: 'high', model: 'gemini-2.5-pro' }),
        request({ extra_body: { generationConfig: { thinkingConfig: { thinkingBudget: 256 } } } }),
        false,
      ),
    )
    const config = body['generationConfig'] as Record<string, unknown>
    expect((config['thinkingConfig'] as Record<string, unknown>)['thinkingBudget']).toBe(256)
  })

  it('isGemini3 覆盖 3- 与 3. 两种写法，不误伤 2.5', () => {
    expect(isGemini3('gemini-3-pro-preview')).toBe(true)
    expect(isGemini3('gemini-3.0-pro')).toBe(true)
    expect(isGemini3('gemini-2.5-pro')).toBe(false)
    expect(isGemini3('deepseek-chat')).toBe(false)
  })
})

describe('回归：Gemini 的 extra_body 不能被 generationConfig 覆盖', () => {
  it('extra_body.generationConfig 里的自定义字段要和本层字段合并，而不是整块丢掉', () => {
    const body = bodyOf(
      gemini.buildChat(
        target(),
        request({ extra_body: { generationConfig: { responseModalities: ['TEXT'], candidateCount: 1 } } }),
        false,
      ),
    )
    const config = body['generationConfig'] as Record<string, unknown>
    // 上游自定义字段还在
    expect(config['responseModalities']).toEqual(['TEXT'])
    expect(config['candidateCount']).toBe(1)
    // 本层的权威字段同时存在
    expect(config['maxOutputTokens']).toBeDefined()
  })

  it('JSON 模式叠加在合并后的 generationConfig 上，不丢 extra_body 字段', () => {
    const body = bodyOf(
      gemini.buildChat(
        target(),
        request({ json: true, extra_body: { generationConfig: { candidateCount: 1 } } }),
        false,
      ),
    )
    const config = body['generationConfig'] as Record<string, unknown>
    expect(config['candidateCount']).toBe(1)
    expect(config['response_mime_type']).toBe('application/json')
  })
})
