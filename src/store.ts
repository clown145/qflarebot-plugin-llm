import type { PluginContext } from '@qqbot/sdk'
import { CONFIG_KEY, createDefaultConfig } from './config/defaults.js'
import { isRecord, normalizeConfig } from './config/normalize.js'
import type { StoredConfig } from './config/types.js'
import { errorMessage } from './errors.js'

export const CONFIG_READ_FAILED = '读取配置失败，请稍后重试'

export interface LoadedConfig {
  config: StoredConfig
  /** KV 里的内容不是合法配置对象，页面重新保存即可覆盖 */
  corrupt: boolean
  /** KV 读取本身失败；不能当成空配置来保存覆盖 */
  readFailed?: boolean
}

export interface ConfigStore {
  read(): Promise<LoadedConfig>
  write(config: StoredConfig): Promise<void>
  /**
   * 写之前再读一次，版本不一致就拒绝写入。
   *
   * 返回 'written' | 'conflict' | 'read-failed'：
   * - **这不是原子操作**：KV 没有 compare-and-swap，两个请求仍可能同时读到同一版本、
   *   同时通过检查，后写的覆盖先写的。它能把「读到 version → 写入」的窗口从两次往返
   *   压到一次 KV 读之前，从而挡住绝大多数跨标签页 / 跨边缘节点的保存冲突；
   *   真正的串行保证来自页面的保存队列（web/save.ts），以及冲突时按 409 让用户刷新。
   * - 读失败单独成态：PUT 据此返回 503 而不是误导用户「配置被修改」的 409。
   */
  compareAndWrite(config: StoredConfig, expectedVersion: number): Promise<'written' | 'conflict' | 'read-failed'>
}

type StoreContext = Pick<PluginContext, 'kv' | 'logger'>

function emptyConfig(): StoredConfig {
  return { ...createDefaultConfig(), version: 0 }
}

export function createConfigStore(ctx: StoreContext): ConfigStore {
  return {
    async read() {
      let raw: string | null
      try {
        raw = await ctx.kv.get(CONFIG_KEY)
      } catch (err) {
        ctx.logger.warn('读取 LLM 配置失败', { error: errorMessage(err) })
        return { config: emptyConfig(), corrupt: true, readFailed: true }
      }
      if (raw === null) {
        return { config: emptyConfig(), corrupt: false }
      }

      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        ctx.logger.warn('LLM 配置不是合法 JSON，等待页面覆盖', { bytes: raw.length })
        return { config: emptyConfig(), corrupt: true }
      }
      if (!isRecord(parsed)) {
        ctx.logger.warn('LLM 配置不是对象，等待页面覆盖', { type: typeof parsed })
        return { config: emptyConfig(), corrupt: true }
      }
      return { config: normalizeConfig(parsed), corrupt: false }
    },
    async write(config) {
      await ctx.kv.put(CONFIG_KEY, config)
    },
    async compareAndWrite(config, expectedVersion) {
      const current = await this.read()
      if (current.readFailed) return 'read-failed'
      if (current.config.version !== expectedVersion) return 'conflict'
      await ctx.kv.put(CONFIG_KEY, config)
      return 'written'
    },
  }
}

/** 首次安装写入默认配置；已经有配置（包括损坏的）就不动，避免覆盖用户的密钥 */
export async function ensureConfig(ctx: StoreContext): Promise<void> {
  let raw: string | null
  try {
    raw = await ctx.kv.get(CONFIG_KEY)
  } catch (err) {
    ctx.logger.warn('检查 LLM 配置失败，页面首次保存时会自动创建', { error: errorMessage(err) })
    return
  }
  if (raw !== null) return
  try {
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
    compareAndWrite: async () => 'written',
  }
}
