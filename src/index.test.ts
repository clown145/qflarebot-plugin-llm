import { createMockContext } from '@qqbot/sdk/testing'
import { describe, expect, it } from 'vitest'
import plugin from './index.js'
import { LLM } from './service.js'

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
