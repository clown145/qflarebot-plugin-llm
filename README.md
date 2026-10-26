# qflarebot-plugin-llm

QFlareBot 的 LLM 接口插件：提供供应商与模型配置页，并通过 `llm` 服务向其他插件提供统一的对话接口。

聊天、会话管理和工具执行不在本插件范围内，由调用方实现。

## 功能

- 管理多个 LLM 供应商，支持 OpenAI 兼容接口和 Anthropic Messages。
- 模型别名映射到供应商与上游模型。
- 提供 `chat`、`stream`、`listModels`、`resolve`、`ping` 接口。
- 工具定义与工具调用结果透传，由调用方执行工具。
- 独立的配置页面，支持供应商/模型增删改、启停、连通性测试、拉取上游模型、导入导出。
- API Key 仅保存在插件 KV 中，页面不回显，导出不包含。

## 环境要求

- QFlareBot（插件清单 API 版本 1）
- 插件权限：`net`、`kv`
- 不需要 D1、R2 或 Durable Object

## 安装

将仓库推送到公开 GitHub 后，在机器人面板「插件 → 安装插件」中粘贴仓库地址，或从插件市场安装。

- 插件名：`llm`
- 包名：`qflarebot-plugin-llm`

## 配置

安装后打开侧栏「插件页面 → LLM 接口」。

1. 在「供应商」中添加供应商：协议、接口地址、API Key、超时。
2. 在「模型」中添加模型别名：别名供调用方使用，上游模型填写服务商提供的模型名。
3. 在「设置」中选择默认模型别名并保存。
4. 在「概览」中执行一次测试，确认接口地址、Key 和模型可用。

调用方使用模型别名，不直接依赖供应商或上游模型名。

### 配置存储

配置在独立页面中管理，保存在插件 KV 的 `config:v1` 键中，不使用面板的通用配置表单。

- API Key 只存储在 KV 中，接口只返回 `api_key_set` 布尔值。
- 保存时按供应商标识合并 Key：留空保留、填写替换、清除删除。
- 导出的 JSON 不包含 Key；导入后，同标识的供应商沿用本机已存 Key，新供应商需要填写。
- KV 为最终一致：保存后其他边缘节点可能需要约一分钟同步。
- 卸载时选择清除数据会删除配置和 Key；不清除则保留。

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
```

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

`session.stream()` 仅单聊支持。群聊中的降级方式由调用方决定。

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
- 工具执行、循环次数、权限和超时预算由调用方控制。

### 错误

失败时抛出 `LLMError`，包含 `code`、`provider`、`alias`。

| code | 说明 |
| --- | --- |
| `config` | 未配置、配置损坏、别名重复或停用 |
| `unknown_model` | 模型别名不存在 |
| `auth` | 401/403，认证失败 |
| `rate_limit` | 429，上游限流 |
| `timeout` | 调用超时 |
| `aborted` | 调用方取消 |
| `network` | 无法连接上游 |
| `upstream` | 上游 5xx 或其他错误 |
| `bad_request` | 调用参数不合法 |
| `bad_response` | 上游响应无法解析 |
| `unsupported` | 协议不支持该能力 |

跨插件调用时请检查 `err.code`，不要依赖 `instanceof`。错误信息中的 API Key 已脱敏。

## 协议支持

| 协议 | 说明 | 工具调用 | JSON 输出 |
| --- | --- | --- | --- |
| `openai` | OpenAI Chat Completions 兼容接口，包括 DeepSeek、Moonshot、智谱、Qwen、SiliconFlow、OpenRouter、Ollama、Gemini 兼容端点 | 支持 | 支持 |
| `anthropic` | Anthropic Messages | 支持 | 不支持 |

`base_url` 填写到 `/v1` 层级，适配器会拼接 `/chat/completions` 或 `/messages`；已包含具体端点的地址也可识别。

原生 Gemini、Azure OpenAI 和 OpenAI Responses 尚未实现，可通过新增协议适配器扩展。

## 限制

- 单次调用默认 25 秒，硬上限 28 秒；一次 QQ 事件总时长为 30 秒。
- 一次调用使用一次 `fetch`，重试额外计算。
- SSE 增量解析，限制单行缓冲；上游响应体最多读取 8 MB。
- 热路径只读取一次配置 KV，不写入 KV 或 D1。
- 服务可在 handler、route、cron 中使用；Durable Object 的 `this.plugin` 不提供服务调用能力。

## 本地开发

SDK 与构建工具不发布到 npm。将 QFlareBot 克隆到本仓库旁边（默认路径 `../QFlareBot`）：

```bash
npm install
npm run build:page   # 生成 src/page.generated.ts，需要提交
npm run build        # 生成 dist/plugin.js 和 dist/manifest.json
npm run sync         # 同步清单到仓库根目录，需要提交
npm test
npm run typecheck
npm run preview      # 本地预览，使用内存数据，不连接机器人
```

修改 `web/` 后需要重新执行 `npm run build:page` 并提交生成文件；构建机不执行前端构建。

真实机器人联调时，可临时将 `dist/plugin.js` 以 `file:` 加入种子清单，或临时从 `apps/seed/src/index.ts` 导入；不要提交这些临时改动。

## 目录结构

```
src/
  index.ts              插件定义：服务、页面、路由、安装钩子
  contract.ts           对外服务契约
  config/               配置类型、默认值、归一化、校验、密钥合并、别名解析
  store.ts              KV 读写与首次安装
  service.ts            服务实现：配置加载、路由、参数校验、日志
  transport.ts          超时、重试、取消、上游请求
  request.ts            调用参数校验
  upstream.ts           上游错误映射与重试判断
  http.ts               JSON 响应、请求体限制、超时、脱敏
  sse.ts                SSE 增量解析
  protocols/            OpenAI / Anthropic 适配器与注册表
  routes.ts             管理页 API
  page.generated.ts     由 build-page.mjs 生成的页面，请勿手动修改
web/                    配置页源码
scripts/
  build-page.mjs        构建单文件页面
  preview.mjs           本地预览
```

## 致谢

协议字段映射参考了 [AstrBot](https://github.com/AstrBotDevs/AstrBot) 的 provider 与工具抽象。AstrBot 使用 AGPL-3.0，本插件使用 MIT，协议实现为独立编写。

## 许可证

[MIT](./LICENSE)
