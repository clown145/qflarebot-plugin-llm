import type { PluginContext } from '@qqbot/sdk'
import { CONFIG_KEY, createDefaultConfig } from './config/defaults.js'
import { isRecord, normalizeConfig } from './config/normalize.js'
import type { StoredConfig } from './config/types.js'
import { errorMessage } from './errors.js'

export interface LoadedConfig {
  config: StoredConfig
  corrupt: boolean
}

export interface ConfigStore {
  read(): Promise<LoadedConfig>
  write(config: StoredConfig): Promise<void>
}

type StoreContext = Pick<PluginContext, 'kv' | 'logger'>

export function createConfigStore(ctx: StoreContext): ConfigStore {
  return {
    async read() {
      let raw: unknown
      try {
        raw = await ctx.kv.getJSON<unknown>(CONFIG_KEY)
      } catch (err) {
        ctx.logger.warn('读取 LLM 配置失败', { error: errorMessage(err) })
        return { config: { ...createDefaultConfig(), version: 0 }, corrupt: true }
      }
      if (raw === null || raw === undefined) {
        return { config: { ...createDefaultConfig(), version: 0 }, corrupt: false }
      }
      if (!isRecord(raw)) {
        return { config: { ...createDefaultConfig(), version: 0 }, corrupt: true }
      }
      return { config: normalizeConfig(raw), corrupt: false }
    },
    async write(config) {
      await ctx.kv.put(CONFIG_KEY, config)
    },
  }
}

/** 首次安装写入默认配置；已经有配置（包括损坏的）就不动，避免覆盖用户的密钥 */
export async function ensureConfig(ctx: StoreContext): Promise<void> {
  try {
    const raw = await ctx.kv.getJSON<unknown>(CONFIG_KEY)
    if (raw !== null && raw !== undefined) return
    const config = createDefaultConfig()
    await ctx.kv.put(CONFIG_KEY, config)
    ctx.logger.info('已写入 LLM 默认配置', { version: config.version })
  } catch (err) {
    ctx.logger.warn('写入 LLM 默认配置失败，页面首次保存时会自动创建', { error: errorMessage(err) })
  }
}

/** 测试和页面草稿用：不落 KV，只读固定配置 */
export function fixedStore(config: StoredConfig): ConfigStore {
  return {
    read: async () => ({ config, corrupt: false }),
    write: async () => {},
  }
}
