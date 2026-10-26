import { definePlugin } from '@qqbot/sdk'
import { createRoutes } from './routes.js'
import { createConfigStore, ensureConfig } from './store.js'
import { LLM } from './service.js'

export type * from './contract.js'

/** 只做配置管理与 llm 服务；聊天、上下文、工具执行都在调用方 */
export default definePlugin({
  name: 'llm',
  displayName: 'LLM 接口',
  description: '统一管理大模型供应商与模型别名，向其他插件提供 llm 服务（含工具调用透传）；不含聊天逻辑',
  apiVersion: 1,
  permissions: ['net', 'kv'],
  ui: { path: '/ui/', title: 'LLM 接口', icon: 'sparkles' },

  services: {
    llm: (ctx) => new LLM({ store: createConfigStore(ctx), logger: ctx.logger }),
  },

  hooks: {
    async onInstall(ctx) {
      await ensureConfig(ctx)
    },
  },

  routes: createRoutes(),
})
