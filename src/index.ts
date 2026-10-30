import { definePlugin } from '@qqbot/sdk'
import { createRoutes } from './routes.js'
import { createConfigStore, ensureConfig } from './store.js'
import { LLM } from './service.js'
import { formatModelList, resolveModelChoice } from './commands/switch.js'
import type { ModelInfo } from './contract.js'

/**
 * 把服务抛出的错误转成用户能看懂的一句话。
 *
 * 直接 `String(error)` 会漏出 `LLMError: ...` 这种内部形状，
 * 而这里的所有错误都是「配置没配好 / 读不到配置」这类用户能自己解决的问题。
 */
function formatServiceError(error: unknown): string {
  if (error instanceof Error) return `操作失败：${error.message}`
  return '操作失败，请稍后重试'
}

export type * from './contract.js'

/** 只做配置管理与 llm 服务；聊天、上下文、工具执行都在调用方 */
export default definePlugin({
  name: 'llm',
  displayName: 'LLM 接口',
  description: '统一管理大模型供应商与模型别名，向其他插件提供 llm 服务（含工具调用与多模态透传）；不含聊天逻辑',
  apiVersion: 1,
  permissions: ['net', 'kv'],
  // 面板侧栏目前对插件页面固定用一个图标，不读 ui.icon，所以这里不声明
  ui: { path: '/ui/', title: 'LLM 接口' },

  services: {
    llm: (ctx) => new LLM({ store: createConfigStore(ctx), logger: ctx.logger }),
  },

  /**
   * 命令组：查看与切换默认模型。
   *
   * 对标 AstrBot 的 `/provider`（`builtin_commands/commands/provider.py`）。
   *
   * ## 与 AstrBot 的差异：**全局切换，不是按会话**
   *
   * AstrBot 的 `/provider` 会 `set_provider(provider_id, umo=umo)`，
   * 按会话记「这个群用哪家」。那需要一张「会话 → 模型」的绑定表。
   *
   * 本框架的 LLM 插件只有 KV 存配置、没有 D1，而按会话切换是个界面上
   * 说不清楚的半全局状态（用户很难预期「我在这个群切了，私聊变了吗」）。
   * 所以这里只改**全局默认** `default_model` —— 语义单一，所见即所得。
   *
   * 需要按会话切的话，调用方（如 Agent 插件）持有会话表，
   * 用 `ChatRequest.model` 每次指定即可 —— 接口本来就支持。
   */
  commands: {
    /**
     * `/llm` —— 看当前模型与可用列表。
     *
     * 不带参数时列清单，等价于 AstrBot 的 `/provider`（无参）。
     */
    llm: {
      description: '查看或切换默认模型',
      usage: '/llm [use <序号或别名>]',
      aliases: ['llm 模型'],
      async handler({ ctx, argText }) {
        const service = ctx.service<LLM>('llm')
        const arg = argText.trim()

        // `/llm use <x>`
        if (arg.startsWith('use ') || arg === 'use') {
          const want = arg.slice(3).trim()
          let models: ModelInfo[]
          let current: string
          try {
            models = await service.listModels()
            current = await service.currentModel()
          } catch (error) {
            return formatServiceError(error)
          }

          const plan = resolveModelChoice(want, models, current)
          if (plan.kind === 'error') return plan.message
          if (plan.kind === 'noop') {
            // 已经是这个了：**不写 KV**（额度只有 1,000 次/天）
            return `已经在用「${plan.alias}」了。`
          }

          try {
            await service.setDefaultModel(plan.alias)
          } catch (error) {
            return formatServiceError(error)
          }
          return `已切换到「${plan.alias}」。\n这是全局默认，所有会话都会用它。`
        }

        // 不带参数或其它子命令：列清单
        try {
          const [models, current] = await Promise.all([
            service.listModels(),
            service.currentModel(),
          ])
          return formatModelList(models, current).join('\n')
        } catch (error) {
          return formatServiceError(error)
        }
      },
    },
  },

  hooks: {
    async onInstall(ctx) {
      await ensureConfig(ctx)
    },
  },

  routes: createRoutes(),
})
