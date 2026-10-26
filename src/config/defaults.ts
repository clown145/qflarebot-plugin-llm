import type { StoredConfig } from './types.js'

export const CONFIG_KEY = 'config:v1'

/** 每次新建对象：数组不能共用，否则页面/服务改一处会串到别处 */
export function createDefaultConfig(now = new Date()): StoredConfig {
  return {
    schema_version: 1,
    version: 1,
    providers: [],
    models: [],
    default_model: '',
    request_timeout_ms: 25000,
    max_retries: 1,
    updated_at: now.toISOString(),
  }
}
