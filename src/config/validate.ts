import { looksLikeSecret } from '../redact.js'
import { CAPABILITY_VALUES, LIMITS, type ConfigIssue, type StoredConfig } from './types.js'

const PROVIDER_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/
const MODEL_ALIAS = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,39}$/
/** 由适配器按 api_key 生成的鉴权头；用户再写一份只会产生冲突值（实测会拼成 "Bearer a, Bearer b"） */
const MANAGED_HEADERS = new Set(['authorization', 'proxy-authorization', 'x-api-key', 'api-key', 'host', 'content-length', 'content-type'])
/** 私网 / 回环 / 元数据地址：密钥不该发到这些地方 */
/** 私网 / 回环 / 元数据地址：密钥不该发到这些地方（IPv6 家族与边角形态由 isPrivateHost 补齐） */
const PRIVATE_HOST = /^(localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|169\.254\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+)$/i

/**
 * 私网/回环/链路本地/元数据地址判定，按地址族统一数值比对。
 *
 * 旧的正则只认 IPv4 点分与裸 `localhost`，IPv6 家族全部漏网：
 * `https://[::ffff:127.0.0.1]/`（IPv4 映射回环，hostname 规范化为 `[::ffff:7f00:1]`）、
 * `https://[::ffff:169.254.169.254]/`（映射的云元数据地址）、`[fd00::1]`（ULA）、
 * `[fe80::1]`（链路本地）、`[::]`（未指定）、尾点 `localhost.`、`0.0.0.1` 全部通过校验。
 * 这里补上第二层：hostname 带 `[` 按 IPv6 解析成 128 位数值做范围比对（含
 * `::ffff:0:0/96` 内嵌的 IPv4）；点分四段按 IPv4 数值比对；其余按主机名（剥尾点）判 localhost。
 * DNS 间接解析（nip.io 等）不在 hostname 静态检查能力内，属已知残留。
 */
const IPV4_PRIVATE_BLOCKS: ReadonlyArray<{ start: number; end: number }> = [
  { start: 0x00000000, end: 0x00ffffff }, // 0.0.0.0/8（未指定/通配绑定，整段拒绝）
  { start: 0x0a000000, end: 0x0affffff }, // 10.0.0.0/8
  { start: 0x7f000000, end: 0x7fffffff }, // 127.0.0.0/8（回环）
  { start: 0xa9fe0000, end: 0xa9feffff }, // 169.254.0.0/16（链路本地/云元数据）
  { start: 0xac100000, end: 0xac1fffff }, // 172.16.0.0/12
  { start: 0xc0a80000, end: 0xc0a8ffff }, // 192.168.0.0/16
]

function ipv4Private(value: number): boolean {
  return IPV4_PRIVATE_BLOCKS.some(({ start, end }) => value >= start && value <= end)
}

/** IPv4 点分四段 → 数值；不匹配该形态返回 undefined（交回主机名判定） */
function ipv4Value(host: string): number | undefined {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!match) return undefined
  let value = 0
  for (const part of match.slice(1)) {
    const octet = Number(part)
    if (octet > 255) return undefined
    value = value * 256 + octet
  }
  return value
}

/** IPv6 字面量（`[...]` 里的内容）→ 8 组 16 位；无法解析返回 undefined */
function ipv6Groups(host: string): number[] | undefined {
  let body = host
  const zone = body.indexOf('%')
  if (zone >= 0) body = body.slice(0, zone) // fe80::1%eth0 之类的区域后缀，剥掉再判
  if (!/^[0-9a-f:.]+$/i.test(body)) return undefined
  const halves = body.split('::')
  if (halves.length > 2) return undefined
  const parseGroups = (text: string): number[] | undefined => {
    if (!text) return []
    const parts = text.split(':')
    const out: number[] = []
    for (const part of parts) {
      if (part.includes('.')) {
        // 内嵌 IPv4（::ffff:127.0.0.1）：折成两组
        const v4 = ipv4Value(part)
        if (v4 === undefined) return undefined
        out.push(v4 >>> 16, v4 & 0xffff)
        continue
      }
      if (!/^[0-9a-f]{1,4}$/i.test(part)) return undefined
      out.push(Number.parseInt(part, 16))
    }
    return out
  }
  const head = parseGroups(halves[0] ?? '')
  if (head === undefined) return undefined
  let tail: number[] | undefined = []
  if (halves.length === 2) {
    tail = parseGroups(halves[1] ?? '')
    if (tail === undefined) return undefined
  } else if (head.length !== 8) {
    return undefined
  }
  const fill = 8 - head.length - tail.length
  if (fill < 0) return undefined
  return [...head, ...new Array<number>(fill).fill(0), ...tail]
}

/** hostname（URL 解析后的原样值，IPv6 带方括号）是否私网/回环/链路本地/未指定 */
export function isPrivateHost(hostname: string): boolean {
  if (hostname.startsWith('[')) {
    if (!hostname.endsWith(']')) return true // 残缺方括号宁可拒绝
    const groups = ipv6Groups(hostname.slice(1, -1))
    if (!groups || groups.length !== 8) return true // 解析不了的 IPv6 字面量宁可拒绝
    // ::ffff:0:0/96 的 IPv4 映射地址：按内嵌 IPv4 判
    if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
      const v4 = ((groups[6]! << 16) | groups[7]!) >>> 0
      return ipv4Private(v4)
    }
    const allZero = groups.every((g) => g === 0)
    const loopback = allZero || (groups[0] === 0 && groups.slice(1, 7).every((g) => g === 0) && groups[7] === 1)
    const ula = (groups[0]! & 0xfe00) === 0xfc00 // fc00::/7（含 fd00::/8 ULA）
    const linkLocal = (groups[0]! & 0xffc0) === 0xfe80 // fe80::/10
    return loopback || ula || linkLocal
  }
  const v4 = ipv4Value(hostname)
  if (v4 !== undefined) return ipv4Private(v4)
  const host = hostname.replace(/\.$/, '').toLowerCase() // 尾点 FQDN（localhost.）
  return host === 'localhost'
}
/**
 * 云厂商元数据地址。**即使打开 `allow_http` 也必须拒绝**。
 *
 * 这是 SSRF 最经典的攻击目标：能请求到它就等于拿到实例的临时凭证。
 * 两边都要堵——IPv4 链路本地段与 IPv6 的链路本地/未指定段。
 *
 * 覆盖：
 * - `169.254.169.254`（AWS / GCP / Azure / 阿里云 / 腾讯云都用这个）
 * - `169.254.0.0/16` 整段链路本地（同段内还有别的服务）
 * - `[::ffff:169.254.169.254]` 之类的 IPv4 映射
 * - `fd00:ec2::254`（AWS 的 IPv6 元数据地址）
 * - `[fe80::...]` 链路本地
 */
export function isMetadataHost(hostname: string): boolean {
  if (hostname.startsWith('[')) {
    if (!hostname.endsWith(']')) return true
    const groups = ipv6Groups(hostname.slice(1, -1))
    if (!groups || groups.length !== 8) return true
    // IPv4 映射：::ffff:a.b.c.d
    if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
      const v4 = ((groups[6]! << 16) | groups[7]!) >>> 0
      return ipv4Metadata(v4)
    }
    // AWS IPv6 元数据地址 fd00:ec2::254
    const awsV6 =
      groups[0] === 0xfd00 && groups[1] === 0x0ec2 && groups.slice(2, 7).every((g) => g === 0) && groups[7] === 0x254
    // 链路本地 fe80::/10（元数据服务有时也绑在这）
    const linkLocal = (groups[0]! & 0xffc0) === 0xfe80
    return awsV6 || linkLocal
  }
  const v4 = ipv4Value(hostname)
  return v4 !== undefined && ipv4Metadata(v4)
}

/** IPv4 数值是否落在链路本地/元数据段 */
function ipv4Metadata(value: number): boolean {
  // 169.254.0.0/16：链路本地，云元数据都在这一段的 169.254.169.254
  return value >= 0xa9fe0000 && value <= 0xa9feffff
}

const MAX_CONTEXT_WINDOW = 10_000_000
const MAX_OUTPUT_TOKENS = 1_000_000

function issue(level: ConfigIssue['level'], path: string, message: string): ConfigIssue {
  return { level, path, message }
}

function checkTimeout(value: number, path: string, issues: ConfigIssue[]): void {
  if (!Number.isInteger(value) || value < LIMITS.timeout_min || value > LIMITS.timeout_max) {
    issues.push(issue('error', path, `超时应在 ${LIMITS.timeout_min}–${LIMITS.timeout_max} 毫秒之间`))
    return
  }
  if (value > LIMITS.call_timeout_max) {
    // 老配置里存过 25000/28000 照常能用，但实际发请求时会被压到这个上限
    issues.push(issue('warn', path, `超过单次调用实际上限 ${LIMITS.call_timeout_max} 毫秒，会被压到这个值`))
  }
}

/**
 * 校验上游接口地址。供保存路径与 /api/upstream-models、/api/test 复用。
 *
 * ## 默认拒绝 http 与内网地址
 *
 * 两道防线都为了同一件事：**别把 API Key 送去不该去的地方**。
 * http 会明文暴露 Key；内网地址可能是别人架在云上的 SSRF 跳板。
 *
 * ## `allowHttp` 是给「上游只能用 IP」开的口子
 *
 * IP 签不出证书、自签证书 Cloudflare 的 fetch 也不认，所以那种部署只能走 http。
 * 但即使打开，**云元数据地址永远拒绝**——那是 SSRF 最经典的攻击目标
 * （拿到实例的临时凭证就完事了），没有任何正当理由去请求它。
 */
export function checkBaseUrl(
  value: string,
  path: string,
  issues: ConfigIssue[],
  options: { allowHttp?: boolean } = {},
): void {
  if (!value) {
    issues.push(issue('error', path, '必填'))
    return
  }
  if (/\s/.test(value)) {
    issues.push(issue('error', path, '不能包含空白字符'))
    return
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    issues.push(issue('error', path, '不是合法的 URL'))
    return
  }
  if (url.protocol !== 'https:') {
    if (url.protocol !== 'http:') {
      issues.push(issue('error', path, '只支持 http / https 地址'))
      return
    }
    if (!options.allowHttp) {
      // API Key 走 Authorization 头，明文 HTTP 会在链路上暴露
      issues.push(issue('error', path, '只支持 https 地址；用 http 会把 API Key 明文发出去。确实只能走 http（例如上游是个 IP，签不了证书）时，在下面打开「允许明文 HTTP」'))
      return
    }
  }
  // 元数据地址无论如何都拦：开了 allow_http 也不放行
  if (isMetadataHost(url.hostname)) {
    issues.push(issue('error', path, '不能是云厂商的元数据地址'))
    return
  }
  if (url.username || url.password) {
    issues.push(issue('error', path, '不要在接口地址里写用户名/密码；密钥请放到 API Key 字段'))
  }
  // 内网 / 回环：开了 allow_http 就放行（内网部署的正当场景），但上面已经有元数据兜底
  if (!options.allowHttp && (PRIVATE_HOST.test(url.hostname) || isPrivateHost(url.hostname))) {
    issues.push(issue('error', path, '不能是回环或内网地址；API Key 会被发到内网服务。确实要连内网（例如自建在局域网里的推理服务）时，在下面打开「允许明文 HTTP」'))
  }
}

/** 只做结构和取值检查，不联网、不读存储；PUT 保存前与页面加载后都用它 */
export function validateConfig(config: StoredConfig): ConfigIssue[] {
  const issues: ConfigIssue[] = []

  checkTimeout(config.request_timeout_ms, 'request_timeout_ms', issues)
  if (!Number.isInteger(config.max_retries) || config.max_retries < 0 || config.max_retries > LIMITS.max_retries) {
    issues.push(issue('error', 'max_retries', `重试次数应在 0–${LIMITS.max_retries} 之间`))
  }
  if (config.providers.length === 0) issues.push(issue('warn', 'providers', '还没有供应商'))

  const providerIds = new Map<string, number>()
  config.providers.forEach((provider, index) => {
    const base = `providers.${index}`
    if (!provider.id) {
      issues.push(issue('error', `${base}.id`, '必填'))
    } else if (!PROVIDER_ID.test(provider.id)) {
      issues.push(issue('error', `${base}.id`, '只能用小写字母、数字、-、_，且以字母或数字开头'))
    } else if (providerIds.has(provider.id)) {
      issues.push(issue('error', `${base}.id`, `与第 ${providerIds.get(provider.id)! + 1} 个供应商重复`))
    } else {
      providerIds.set(provider.id, index)
    }

    if (!provider.name.trim()) issues.push(issue('error', `${base}.name`, '必填'))
    else if (provider.name.length > 60) issues.push(issue('error', `${base}.name`, '最多 60 个字符'))

    if (provider.protocol !== 'openai' && provider.protocol !== 'anthropic' && provider.protocol !== 'gemini') {
      issues.push(issue('error', `${base}.protocol`, '不支持的协议'))
    }
    checkBaseUrl(provider.base_url, `${base}.base_url`, issues, { allowHttp: provider.allow_http === true })

    if (provider.timeout_ms !== undefined) checkTimeout(provider.timeout_ms, `${base}.timeout_ms`, issues)
    if (!provider.api_key) issues.push(issue('warn', `${base}.api_key`, '未设置 API Key；上游要求认证时会调用失败'))

    for (const [key, value] of Object.entries(provider.headers ?? {})) {
      const lower = key.toLowerCase()
      if (MANAGED_HEADERS.has(lower)) {
        // 适配器会用 api_key 覆盖同名头，两处都写会拼出坏值（实测 "Bearer a, Bearer b"）
        issues.push(issue('error', `${base}.headers`, `${key} 由适配器按 API Key 生成，不要在这里重复设置`))
        continue
      }
      if (looksLikeSecret(value)) {
        issues.push(issue('warn', `${base}.headers`, `${key} 看起来像密钥；导出时会被剔除，建议改放到 API Key 字段`))
      }
    }

    const models = config.models.filter((model) => model.provider === provider.id)
    if (models.length === 0) issues.push(issue('warn', `${base}.id`, '这个供应商还没有模型别名'))
    if (!provider.enabled && models.some((model) => model.enabled)) {
      issues.push(issue('warn', `${base}.enabled`, '供应商已停用，下面的模型都不会生效'))
    }
  })

  const aliases = new Map<string, number>()
  config.models.forEach((model, index) => {
    const base = `models.${index}`
    if (!model.alias) {
      issues.push(issue('error', `${base}.alias`, '必填'))
    } else if (!MODEL_ALIAS.test(model.alias)) {
      issues.push(issue('error', `${base}.alias`, '只能用字母、数字、.、_、:、-，且以字母或数字开头'))
    } else if (aliases.has(model.alias)) {
      issues.push(issue('error', `${base}.alias`, `与第 ${aliases.get(model.alias)! + 1} 个模型别名重复`))
    } else {
      aliases.set(model.alias, index)
    }

    const provider = model.provider ? config.providers.find((item) => item.id === model.provider) : undefined
    if (!model.provider) {
      issues.push(issue('error', `${base}.provider`, '必填'))
    } else if (!provider) {
      issues.push(issue('error', `${base}.provider`, `供应商 ${model.provider} 不存在`))
    } else if (!provider.enabled) {
      issues.push(issue('warn', `${base}.provider`, `供应商 ${model.provider} 已停用`))
    }

    if (!model.model) issues.push(issue('error', `${base}.model`, '必填'))
    else if (model.model.length > 200) issues.push(issue('error', `${base}.model`, '最多 200 个字符'))

    if (model.max_tokens !== undefined && (!Number.isInteger(model.max_tokens) || model.max_tokens < 1 || model.max_tokens > LIMITS.max_tokens_max)) {
      issues.push(issue('error', `${base}.max_tokens`, `应在 1–${LIMITS.max_tokens_max} 之间`))
    }
    if (model.context_window !== undefined && (!Number.isInteger(model.context_window) || model.context_window < 1 || model.context_window > MAX_CONTEXT_WINDOW)) {
      issues.push(issue('error', `${base}.context_window`, `应在 1–${MAX_CONTEXT_WINDOW} 之间`))
    }
    if (model.max_output_tokens !== undefined && (!Number.isInteger(model.max_output_tokens) || model.max_output_tokens < 1 || model.max_output_tokens > MAX_OUTPUT_TOKENS)) {
      issues.push(issue('error', `${base}.max_output_tokens`, `应在 1–${MAX_OUTPUT_TOKENS} 之间`))
    }
    if (model.max_tokens !== undefined && model.max_output_tokens !== undefined && model.max_tokens > model.max_output_tokens) {
      issues.push(issue('warn', `${base}.max_tokens`, '默认输出上限大于模型输出上限'))
    }
    if (model.capabilities !== undefined) {
      const allowed = new Set<string>(CAPABILITY_VALUES)
      const unknown = model.capabilities.filter((item) => !allowed.has(item))
      if (unknown.length) issues.push(issue('error', `${base}.capabilities`, `不支持的能力：${unknown.join('、')}`))
      if (provider?.protocol === 'anthropic' && model.capabilities.includes('json')) {
        issues.push(issue('warn', `${base}.capabilities`, 'Anthropic 协议不支持 JSON 输出'))
      }
      if (provider?.protocol === 'anthropic' && model.capabilities.includes('audio')) {
        issues.push(issue('warn', `${base}.capabilities`, 'Anthropic 协议不支持音频输入'))
      }
    }
    if (model.temperature !== undefined && (typeof model.temperature !== 'number' || model.temperature < 0 || model.temperature > 2)) {
      issues.push(issue('error', `${base}.temperature`, '应在 0–2 之间'))
    }
  })

  if (!config.default_model) {
    issues.push(issue('warn', 'default_model', '未设置默认模型；调用方不传 model 时会报错'))
  } else {
    const model = config.models.find((item) => item.alias === config.default_model)
    if (!model) {
      issues.push(issue('error', 'default_model', `模型别名 ${config.default_model} 不存在`))
    } else {
      const provider = config.providers.find((item) => item.id === model.provider)
      if (!model.enabled) issues.push(issue('warn', 'default_model', '默认模型已停用'))
      else if (provider && !provider.enabled) issues.push(issue('warn', 'default_model', '默认模型的供应商已停用'))
    }
  }

  const usable = config.models.some((model) => {
    if (!model.enabled) return false
    const provider = config.providers.find((item) => item.id === model.provider)
    return Boolean(provider?.enabled)
  })
  if (!usable) issues.push(issue('warn', 'models', '没有可用的模型别名'))

  return issues
}

export function hasErrors(issues: ConfigIssue[]): boolean {
  return issues.some((item) => item.level === 'error')
}
