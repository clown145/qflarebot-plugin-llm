/**
 * 命令层的纯逻辑：给 `/llm` 命令组用的格式化与校验。
 *
 * 放在单独文件里而不是塞进 `index.ts`，是为了让这些逻辑**不依赖 ctx**就能测 —
 * 命令的 handler 需要 KV / logger，但「怎么把模型列表排成文本」「用户输入
 * 该匹配哪个别名」这类事情是纯函数，边界条件还多（空配置、重复别名、
 * 大小写、序号 vs 别名）。
 */

import type { ModelInfo } from '../contract.js'
import type { StoredConfig } from '../config/types.js'

/**
 * 排成给用户看的清单。
 *
 * ## 为什么用序号也保留别名
 *
 * AstrBot 的 `/provider` 只给序号（`1. xxx`），用户要打 `/provider 2`。
 * 序号短，但**会随配置变动错位** —— 加一个模型、删一个供应商，
 * 用户记住的「第 2 个」就变成别的了。
 *
 * 所以这里两样都给：序号方便快速切换，别名是稳定的真实标识。
 * 切换时两种都接受（见 `resolveModelChoice`）。
 */
export function formatModelList(models: ModelInfo[], currentModel: string): string[] {
  if (models.length === 0) {
    return [
      '还没有配置任何模型。',
      '',
      '请在面板「插件 → LLM 接口」里添加供应商与模型别名。',
    ]
  }

  // ModelInfo 里没有 provider_name（那是 ResolvedModel 才有的），
  // 所以这里展示 `provider` 的 id —— 对运维来说它同样能定位到是哪家
  const lines = models.map((model, index) => {
    const mark = model.alias === currentModel ? ' 👈' : ''
    return `${index + 1}. ${model.alias} — ${model.model}（${model.provider}）${mark}`
  })

  const current = models.find((model) => model.alias === currentModel)
  const footer = current
    ? `\n当前：${currentModel}`
    : `\n当前默认：${currentModel || '(未设置)'} —— 它不在可用列表里，配置可能不完整`

  return ['可用模型：', ...lines, footer, '\n切换：/llm use <序号或别名>']
}

/** 切换结果 */
export type SwitchPlan =
  | { kind: 'noop'; alias: string }
  | { kind: 'switch'; alias: string }
  | { kind: 'error'; message: string }

/**
 * 把用户的输入解析成要切换到哪个别名。
 *
 * 接受两种写法：
 * - **序号**：`/llm use 2` —— 快，但会随配置变动错位
 * - **别名**：`/llm use gpt-4o` —— 稳定，推荐
 *
 * 都匹配不上时给出可用清单，而不是只说「没有这个模型」——
 * 用户打错字时最想要的是看到正确拼写。
 */
export function resolveModelChoice(
  input: string,
  models: ModelInfo[],
  currentModel: string,
): SwitchPlan {
  const raw = input.trim()
  if (!raw) {
    return { kind: 'error', message: '用法：/llm use <序号或别名>' }
  }

  // 序号：必须是纯数字且在范围内
  if (/^\d+$/.test(raw)) {
    const index = Number(raw) - 1
    const picked = models[index]
    if (!picked) {
      return {
        kind: 'error',
        message: `没有第 ${raw} 个模型。可用范围是 1–${models.length}。`,
      }
    }
    return picked.alias === currentModel
      ? { kind: 'noop', alias: picked.alias }
      : { kind: 'switch', alias: picked.alias }
  }

  // 别名：先精确匹配，再忽略大小写匹配（用户可能记不清大小写）
  const exact = models.find((model) => model.alias === raw)
  const picked = exact ?? models.find((model) => model.alias.toLowerCase() === raw.toLowerCase())

  if (!picked) {
    const available = models.map((model) => model.alias).join('、')
    return {
      kind: 'error',
      message: available
        ? `没有名为「${raw}」的模型。可用：${available}`
        : '还没有配置任何模型，请先在面板「插件 → LLM 接口」里添加。',
    }
  }

  return picked.alias === currentModel
    ? { kind: 'noop', alias: picked.alias }
    : { kind: 'switch', alias: picked.alias }
}

/**
 * 把 `default_model` 换成新别名，**不动其他字段**。
 *
 * `version` 必须 +1：页面用它对乐观并发做校验，服务端改了配置却不升版本，
 * 页面下一次保存会带着旧版本号、被误判成冲突（或者更糟：覆盖掉这次切换）。
 *
 * `updated_at` 也更新，便于排障时看出配置什么时候被动过。
 */
export function withDefaultModel(config: StoredConfig, alias: string, now = new Date()): StoredConfig {
  return {
    ...config,
    default_model: alias,
    version: config.version + 1,
    updated_at: now.toISOString(),
  }
}
