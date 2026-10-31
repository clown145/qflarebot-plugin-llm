import { definePlugin } from '@qqbot/sdk'
import { createRoutes } from './routes.js'
import { ensureConfig } from './store.js'
import { createLLM } from './service.js'
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
    llm: (ctx) => createLLM(ctx),
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
        // **不能写成 `ctx.service<LLM>('llm')`。**
        //
        // 本插件的 manifest 里 `depends: {}`（也不该把自己提供的服务声明成依赖，
        // 那会在全新安装时被依赖检查当成 `dependencies_missing` 拒掉）。而框架的
        // `ctx.service()` 对**没在 depends 里声明的服务是硬拒绝**：
        //
        //   插件 llm 没有在 depends 中声明服务 llm
        //
        // 结果就是 `/llm` 命令在真实运行时 100% 不可用——单测里手工注入 services
        // 恰好绕过了这道门禁，所以测试一直是绿的。这里直接构造服务实例，
        // 与路由层（routes.ts 的 `/api/test`）走同一条路径。
        const service = createLLM(ctx)
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
