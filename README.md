# qflarebot-plugin-llm

QFlareBot 的 LLM 接口插件：提供供应商与模型配置页，并通过 `llm` 服务向其他插件提供统一的对话接口。

聊天、会话管理和工具执行不在本插件范围内，由调用方实现。

## 功能

- 管理多个 LLM 供应商，支持 OpenAI 兼容接口和 Anthropic Messages。
- 模型别名映射到供应商与上游模型。
- 模型元数据：上下文窗口、输出上限和图片/音频/工具/推理等能力，可从 models.dev 自动填充，也可手动维护。
- 提供 `chat`、`stream`、`listModels`、`resolve`、`ping` 接口。
- 工具定义与工具调用结果透传，由调用方执行工具。
- 多模态输入：文本、图片（OpenAI 兼容 / Anthropic）、音频（OpenAI 兼容）、文件（Anthropic）。
- 推理内容透传：DeepSeek `reasoning_content` 与 Anthropic thinking block 通过 `reasoning` / `reasoning_delta` 返回。
- 独立的配置页面，支持供应商/模型增删改、启停、连通性测试、拉取上游模型、导入导出。
- API Key 仅保存在插件 KV 中，页面不回显；导出文件不包含 Key 和任何可能带密钥的请求头。

## 环境要求

- QFlareBot（插件清单 API 版本 1）
- 插件权限：`net`、`kv`
- 不需要 D1、R2 或 Durable Object

## 安装

将仓库推送到公开 GitHub 后，在机器人面板「插件 → 安装插件 → 仓库链接」中粘贴仓库地址。

- 插件名：`llm`
- 包名：`qflarebot-plugin-llm`

> 插件市场里的条目需要单独向 [QFlareBot/plugins](https://github.com/QFlareBot/plugins) 提 PR 登记，登记前市场里搜不到本插件。

## 配置

安装后打开侧栏「插件页面 → LLM 接口」。

1. 在「模型服务」左侧点「添加」，选一个服务商模板，填写 API Key 后保存供应商。
2. 点「刷新上游」读取接口的模型列表，用「+」逐个添加，或「全部添加」。
3. 也可以「添加模型」手动填写上游模型名；别名供调用方使用，留空会按模型名自动生成。
4. 「全部别名」视图可以跨供应商检查别名、启停、测试和设置默认模型。
5. 在「设置」中选择默认模型别名和超时，点「保存设置」。
6. 在「概览」中执行一次测试，确认接口地址、Key 和模型可用。

调用方使用模型别名，不直接依赖供应商或上游模型名。

供应商设置和默认设置需要显式保存（切换供应商或刷新页面前会提示未保存）；模型的添加、编辑、启停、删除和默认模型切换会立即保存。

### 配置存储

配置在独立页面中管理，保存在插件 KV 的 `config:v1` 键中，不使用面板的通用配置表单。

> 面板「插件」详情页的「插件配置」卡片对本插件不起作用：本插件没有声明 `configSchema`，那张卡片只是给出一份不会被读取的 JSON 编辑框。配置请一律在「插件页面 → LLM 接口」里改。不要在那张卡片里写 API Key —— 没有 `writeOnly` 标记的字段不会脱敏。

- API Key 只存储在 KV 中，接口只返回 `api_key_set` 布尔值。
- 保存时按供应商合并 Key：留空保留、填写替换、清除删除。**保留只发生在接口地址与协议都没变时**——改了地址或协议又没重新填 Key，旧 Key 会被丢弃（页面会提示）。
- 导出的 JSON 不包含 Key、Key 状态；请求头只导出展示类白名单（`X-Title`、`HTTP-Referer` 等），其余头名记在 `headers_omitted` 里，值不导出。
- 导入后，同标识且地址/协议一致的供应商沿用本机已存 Key；地址变了的需要重新填写。
- KV 读取失败时配置接口返回 503，不会把读取失败当成空配置覆盖已有数据。
- KV 里是坏 JSON 或不是配置对象时返回 200 + `corrupt: true` 和空配置，页面重新保存即可覆盖；不会被误判成读失败。
- KV 为最终一致：保存后其他边缘节点可能需要约一分钟同步。
- 卸载时选择清除数据会删除配置和 Key；不清除则保留。

### 接口地址限制

- 只接受 `https` 地址：API Key 走 `Authorization` / `x-api-key` 头，明文 HTTP 会在链路上暴露。
- 拒绝回环与内网地址（`localhost`、`127.0.0.0/8`、`10.`、`172.16.`–`172.31.`、`192.168.`、`169.254.`）。
- 不要在「额外请求头」里写 `Authorization` / `x-api-key`：这两个头由适配器按 API Key 生成，重复设置会拼出坏值，保存时会被拦下。

### 模型元数据

「刷新上游」后的快速添加，以及模型弹窗里按上游模型名自动查询的目录信息，会从 [models.dev](https://models.dev) 读取模型元数据，自动填充：

- `context_window`：输入上下文上限
- `max_output_tokens`：模型输出上限
- `capabilities`：文本、图片、音频、工具、推理（JSON 按协议默认）

说明：

- 元数据只在配置页按需拉取，运行时不请求 models.dev。
- 目录请求在浏览器里直接发（不经过 Worker，避免解析 5.9 MB JSON 的 CPU）。总预算 10 秒，失败后回退到备用域名。
- 目录里没有的模型（自建模型、本地模型）需要手动填写。
- 手动修改优先于目录值；自动查询只填充空字段。模型弹窗里的「重新获取」也只填空字段；要覆盖已有值，用「按来源填充」。
- 同名模型出现在多个供应商下时，只自动填入各来源一致的字段；上下文、输出上限或能力冲突时留空，并在模型弹窗里提示选择来源或手动填写。
- 指定供应商时优先使用该供应商的目录数据；供应商不在目录里时退回全部同名候选。

## 服务接口

服务名 `llm`，契约版本 `1`。完整类型见 [`src/contract.ts`](./src/contract.ts)。

调用方在插件定义中声明依赖：

```ts
export default definePlugin({
  depends: { llm: '*' },
})
```

```ts
interface LLMService {
  readonly contractVersion: 1
  listModels(): Promise<ModelInfo[]>
  resolve(alias?: string): Promise<ResolvedModel>
  chat(req: ChatRequest): Promise<ChatResult>
  stream(req: ChatRequest): AsyncIterable<StreamEvent>
  ping(opts?: { alias?: string; provider?: string }): Promise<PingResult>
}

interface ModelInfo {
  alias: string
  provider: string
  model: string
  capabilities: ('text' | 'image' | 'audio' | 'tools' | 'json' | 'reasoning')[]
  context_window?: number
  max_output_tokens?: number
}
```

接口形状一旦改动会换服务名（`llm2`），不会原地改形状——调用方按服务名对齐即可。

### 非流式调用

```ts
const llm = ctx.service<LLMService>('llm')
const result = await llm.chat({
  model: 'chat',
  messages: [
    { role: 'system', content: '你是一个简洁的助手。' },
    { role: 'user', content: '你好' },
  ],
  temperature: 0.7,
  max_tokens: 1024,
})
return result.text
```

### 流式调用

```ts
const stream = await session.stream()
for await (const event of llm.stream({ model: 'chat', messages })) {
  if (event.type === 'text_delta') await stream.write(event.text)
}
await stream.end()
```

`session.stream()` 只在单聊真正流式；群聊由运行时在 `end()` 时一次性发出，调用方不需要另写降级。

### 推理内容

```ts
for await (const event of llm.stream({ model: 'reasoner', messages })) {
  if (event.type === 'reasoning_delta') showThinking(event.text)
  if (event.type === 'text_delta') await stream.write(event.text)
}
```

非流式结果里是 `result.reasoning`。推理内容只返回给调用方，不会在后续请求里回传（Anthropic 的 thinking 签名无法重建）。

### Gemini 思考签名（必须回传）

Gemini 2.5/3.x 的思考模型对 `functionCall` part 的 `thoughtSignature` 做**严格校验**：多轮工具调用时，带签名的 part 必须原样回传，否则上游直接返回 `400 INVALID_ARGUMENT: Function call is missing a thought_signature`。这不是可选的性能优化，不处理会让 Gemini + 工具的多轮调用完全不可用。

签名挂在 part 上，一次响应里可能有多个 part 各自带签名（多个文本 part、多个 functionCall part），所以用**数组 + part 定位**表达，形状与 serverless-agent 的 `GeminiThoughtSignature` 一致：

```ts
interface ThoughtSignature {
  part_index: number              // 回传时重建的 parts 数组下标
  part_kind: 'text' | 'function_call'
  signature: string               // 原样回传，不要改动
  tool_call_index?: number        // part_kind=function_call：在 tool_calls 里的下标
  tool_call_id?: string           // 优先按它匹配回传位置
  tool_name?: string              // id 对不上时按名字兜底
}
```

`ChatResult.thought_signatures` 拿到的数组**原样**塞回下一轮 assistant 消息即可：

```ts
const result = await llm.chat({ model: 'gemini', messages, tools })
if (result.tool_calls?.length) {
  messages.push({
    role: 'assistant',
    content: result.text,
    thought_signatures: result.thought_signatures,  // 原样回传，漏了下一轮会 400
    tool_calls: result.tool_calls,
  })
  // ...执行工具，push tool 消息，再次调用
}
```

说明：

- 回传时按 `tool_call_id` → `tool_name` → `tool_call_index` 的顺序匹配 functionCall part，文本签名按 `part_index` 贴回（越界时退回最后一个文本 part）。
- 并行工具调用时上游只在**第一个** `functionCall` part 上给签名，插件如实反映，回传时也只需要那一个。
- 流式调用同样可用：每个签名通过 `thought_signature` 事件透出（携带同样的定位字段），`done.result.thought_signatures` 里是汇总后的完整数组。
- 其他协议（OpenAI 兼容、Anthropic）不产生也不需要这个字段，传了会被忽略。
- 调用方如果只存 `text` 和 `tool_calls` 而不存签名，Gemini 多轮工具调用会失败——这是接入 Gemini 时最容易漏的一步。

### 多模态输入

`content` 可以是字符串，也可以是内容片段数组：

```ts
await llm.chat({
  model: 'vision',
  messages: [{
    role: 'user',
    content: [
      { type: 'text', text: '这张图里是什么？' },
      { type: 'image', url: 'https://example.com/cat.png' },
    ],
  }],
})
```

| 片段 | OpenAI 兼容 | Anthropic |
| --- | --- | --- |
| `text` | ✅ | ✅ |
| `image`（`url` 或 `data` + `media_type`） | ✅ | ✅ |
| `audio`（`data` + `format`） | ✅ | ❌ 抛 `unsupported` |
| `file`（`url` 或 `data` + `media_type`） | ❌ 抛 `unsupported` | ✅ |

片段数组里的 `text` 片段会拼成 `ChatResult.text`，其余片段只影响请求。

### 工具调用

工具定义随请求传入。插件负责协议转换，不执行工具。

```ts
const tools = [{
  name: 'get_weather',
  description: '查询天气',
  parameters: {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city'],
  },
}]

const result = await llm.chat({ model: 'chat', messages, tools })
if (result.tool_calls?.length) {
  messages.push({ role: 'assistant', content: result.text, tool_calls: result.tool_calls })
  for (const call of result.tool_calls) {
    const args = JSON.parse(call.arguments)
    const output = await runTool(call.name, args)
    messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(output) })
  }
  // 再次调用 llm.chat，将工具结果交回模型
}
```

- `ToolCall.arguments` 统一为 JSON 字符串。
- 流式工具调用通过 `tool_call_delta` 返回，按 `index` 累积 `arguments_delta`；`done` 事件包含组装后的 `tool_calls`。
- `tool_choice: 'none'` 在 Anthropic 协议下等价于不发送 `tools`（Anthropic 没有 `none` 类型）。
- Gemini 的工具调用签名在 `result.thought_signatures` 数组里，多轮时必须原样回传，见「Gemini 思考签名」一节。
- 工具执行、循环次数、权限和超时预算由调用方控制。

### 错误

失败时抛出 `LLMError`，包含 `code`。解析出别名之后抛出的错误还带 `provider` / `alias`；参数校验阶段的 `bad_request` 可能没有这两个字段。

| code | 说明 |
| --- | --- |
| `config` | 未配置、配置损坏、别名重复或停用 |
| `unknown_model` | 模型别名不存在 |
| `auth` | 401/403，认证失败 |
| `rate_limit` | 429，上游限流（含流内 `insufficient_quota`） |
| `timeout` | 调用超时 |
| `aborted` | 调用方取消 |
| `network` | 无法连接上游 |
| `upstream` | 上游 5xx 或其他错误 |
| `bad_request` | 调用参数不合法 |
| `bad_response` | 上游响应无法解析 |
| `unsupported` | 协议不支持该能力 |

跨插件调用时请检查 `err.code`，不要依赖 `instanceof`。任何失败路径（包括重试退避期间被取消）都会抛 `LLMError`，不会漏出原始 `DOMException`。错误信息中的 API Key 已脱敏，包括上游把 key 截断或拼进 `Bearer …` 里回显的情况。

## 协议支持

| 协议 | 说明 | 工具调用 | JSON 输出 | 多模态 |
| --- | --- | --- | --- | --- |
| `openai` | OpenAI Chat Completions 兼容接口，包括 DeepSeek、Moonshot、智谱、Qwen、SiliconFlow、OpenRouter 等 | 支持 | 支持 | 图片、音频 |
| `anthropic` | Anthropic Messages | 支持 | 不支持 | 图片、文件 |
| `gemini` | Google Gemini 原生 generateContent（generativelanguage 或兼容网关） | 支持 | 支持 | 图片、音频、文件 |

`base_url` 填写到 `/v1`（OpenAI/Anthropic）或 `/v1beta`（Gemini）层级，适配器会拼接端点；已包含具体端点的地址也可识别。

配置页内置的供应商模板有 OpenAI、Anthropic、Google Gemini、DeepSeek、OpenRouter、Moonshot、智谱 GLM、阿里云百炼、硅基流动，以及两个「自定义」模板。Ollama 等其它服务用「自定义 OpenAI 兼容」填地址即可。

原生 Azure OpenAI 和 OpenAI Responses 尚未实现，可通过新增协议适配器扩展。

## 限制

- 配置项 `request_timeout_ms` 允许填 1000–28000（兼容老配置里存的 25000/28000），默认 15000。
- 单次调用实际生效的上限是 **20 秒**（`call_timeout_max`）：一次 QQ 事件里所有插件合计只有 30 秒，框架 25 秒就告警，28 秒会把预算吃光。填得再大也会被压到 20 秒。
- 调用方传的 `timeout_ms` 同样受这个上限约束，压不到 20 秒以上。
- 一次调用使用一次 `fetch`，重试额外计算；重试只对 429、5xx 与网络错误。
- 请求体上限 256 KB（按字节算）。非流式响应体上限 2 MB；流式累计文本/工具参数上限 8 MB；管理页拉模型列表上限 2 MB。
- SSE 增量解析，限制单行缓冲。
- 热路径只读取一次配置 KV，不写入 KV 或 D1。
- 服务可在 handler、route、cron 中使用；Durable Object 的 `this.plugin` 不提供服务调用能力。

## 本地开发

SDK 与构建工具不发布到 npm。将 QFlareBot 克隆到本仓库旁边（默认路径 `../QFlareBot`），**并先构建一次**（`packages/plugin-cli` 的 bin 指向 `dist/`，而框架仓库的 `dist/` 不入库，不构建就没有 `qqbot-plugin` 命令）：

```bash
git clone https://github.com/QFlareBot/QFlareBot ../QFlareBot
(cd ../QFlareBot && pnpm install --filter '@qqbot/plugin-cli...' && pnpm --filter '@qqbot/plugin-cli...' build)

npm install
npm run build:page   # 生成 src/page.generated.ts，需要提交
npm run build        # 生成 dist/plugin.js 和 dist/manifest.json（dist/ 不入库）
npm run sync         # 同步清单到仓库根目录，需要提交
npm test
npm run typecheck
npm run preview      # 本地预览，使用内存数据，不连接机器人
```

修改 `web/` 后需要重新执行 `npm run build:page` 并提交生成文件；构建机不执行前端构建。

`build:page` 固定了 `absWorkingDir` 且开启压缩，同一份源码在任何目录跑出的产物一致，CI 用 `git diff --exit-code` 校验。

真实机器人联调时，可临时把插件加进种子清单，需要成对的 `source` 与 `manifest` 两个 `file:` 字段（见 `apps/seed/qqbot.manifest.json`）：

```jsonc
{
  "name": "llm",
  "version": "0.1.0",
  "source": "file:../../plugins/qflarebot-plugin-llm/dist/plugin.js",
  "manifest": "file:../../plugins/qflarebot-plugin-llm/dist/manifest.json",
  "enabled": true
}
```

不要提交这些临时改动。

## 目录结构

```
src/
  index.ts              插件定义：服务、页面、路由、安装钩子
  contract.ts           对外服务契约（含多模态内容与推理内容）
  apiTypes.ts           管理页 API 的请求/响应类型
  errors.ts             LLMError 与错误字段
  json.ts               解析上游 JSON 的类型守卫
  redact.ts             密钥脱敏（精确值 + 凭据形态）
  config/               配置类型、默认值、归一化、校验、密钥合并、别名解析
  store.ts              KV 读写与首次安装
  service.ts            服务实现：配置加载、路由、参数校验、日志
  transport.ts          超时、重试、取消、上游请求
  request.ts            调用参数校验
  upstream.ts           上游错误映射与重试判断
  modelMetadata.ts      models.dev 元数据到模型配置的映射
  http.ts               JSON 响应、请求体限制、超时、脱敏
  sse.ts                SSE 增量解析
  protocols/            OpenAI / Anthropic 适配器与注册表
  routes.ts             管理页 API
  page.generated.ts     由 build-page.mjs 生成的页面，请勿手动修改
web/                    配置页源码（TypeScript + DOM，build-page.mjs 打成单文件）
scripts/
  build-page.mjs        构建单文件页面
  preview.mjs           本地预览
```

## 致谢

协议字段映射参考了 [AstrBot](https://github.com/AstrBotDevs/AstrBot) 的 provider 与工具抽象（含 Gemini 适配的转换行为）。AstrBot 使用 AGPL-3.0，本插件使用 MIT，协议实现为独立编写。

## 许可证

[MIT](./LICENSE)
