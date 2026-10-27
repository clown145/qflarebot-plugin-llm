import type { StoredConfig } from './types.js'

export const CONFIG_KEY = 'config:v1'

/**
 * 默认超时。一次 QQ 事件里所有插件合计只有 30 秒，留足余量给调用方的工具循环和多轮调用，
 * 所以默认值比「单次调用硬上限」低一截。
 */
export const DEFAULT_TIMEOUT_MS = 15000

/** 每次新建对象：数组不能共用，否则页面/服务改一处会串到别处 */
export function createDefaultConfig(now = new Date()): StoredConfig {
  return {
    schema_version: 1,
    version: 1,
    providers: [],
    models: [],
    default_model: '',
    request_timeout_ms: DEFAULT_TIMEOUT_MS,
    max_retries: 1,
    updated_at: now.toISOString(),
  }
}
