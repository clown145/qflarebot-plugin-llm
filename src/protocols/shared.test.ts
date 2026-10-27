import { describe, expect, it } from 'vitest'
import { endpointUrl, mergeUsage, modelsUrl } from './shared.js'

describe('endpointUrl', () => {
  it('基础地址补上端点', () => {
    expect(endpointUrl('https://api.test/v1', '/chat/completions')).toBe('https://api.test/v1/chat/completions')
    expect(endpointUrl('https://api.test/v1/', '/messages')).toBe('https://api.test/v1/messages')
  })

  it('已经写到端点时不重复拼接', () => {
    expect(endpointUrl('https://api.test/v1/chat/completions', '/chat/completions')).toBe('https://api.test/v1/chat/completions')
    expect(endpointUrl('https://api.test/v1/messages', '/messages')).toBe('https://api.test/v1/messages')
  })

  it('保留查询参数，且不产生双斜杠', () => {
    expect(endpointUrl('https://api.test/v1/?x=1', '/chat/completions')).toBe('https://api.test/v1/chat/completions?x=1')
    expect(endpointUrl('https://api.test/v1?x=1', '/messages')).toBe('https://api.test/v1/messages?x=1')
  })

  it('查询参数里已经带端点时不重复拼接', () => {
    expect(endpointUrl('https://api.test/v1/chat/completions?x=1', '/chat/completions')).toBe(
      'https://api.test/v1/chat/completions?x=1',
    )
  })
})

describe('modelsUrl', () => {
  it('从 v1 级地址推出 models', () => {
    expect(modelsUrl('https://api.test/v1')).toBe('https://api.test/v1/models')
    expect(modelsUrl('https://api.test/v1/')).toBe('https://api.test/v1/models')
  })

  it('从具体端点退回上一级', () => {
    expect(modelsUrl('https://api.test/v1/chat/completions')).toBe('https://api.test/v1/models')
    expect(modelsUrl('https://api.test/v1/messages')).toBe('https://api.test/v1/models')
  })

  it('保留查询参数和 hash', () => {
    expect(modelsUrl('https://api.test/v1?x=1')).toBe('https://api.test/v1/models?x=1')
    expect(modelsUrl('https://api.test/v1/?x=1')).toBe('https://api.test/v1/models?x=1')
    expect(modelsUrl('https://api.test/v1/chat/completions?x=1')).toBe('https://api.test/v1/models?x=1')
    expect(modelsUrl('https://api.test/v1#frag')).toBe('https://api.test/v1/models#frag')
  })
})

describe('mergeUsage', () => {
  it('Anthropic 流式 total 用 input+output 重算，不信任 delta 自带的 total', () => {
    // message_start: {input:2, output:0, total:2}；message_delta: {output:3, total:3}
    // 旧实现取 next.total_tokens，算出 3；正确是 5
    const merged = mergeUsage(
      { input_tokens: 2, output_tokens: 0, total_tokens: 2 },
      { output_tokens: 3, total_tokens: 3 },
    )
    expect(merged).toEqual({ input_tokens: 2, output_tokens: 3, total_tokens: 5 })
  })

  it('缺少 input 时按已有值补零重算', () => {
    const merged = mergeUsage({ output_tokens: 1 }, { output_tokens: 4, total_tokens: 4 })
    expect(merged).toEqual({ output_tokens: 4, total_tokens: 4 })
  })

  it('任一为空时直接返回另一个', () => {
    expect(mergeUsage(undefined, { input_tokens: 1 })).toEqual({ input_tokens: 1 })
    expect(mergeUsage({ input_tokens: 1 }, undefined)).toEqual({ input_tokens: 1 })
  })
})
