import { createBridge } from '/bridge.js'
import type { ConfigGetResponse, ConfigPutRequest, ConfigPutResponse, MetaResponse, ModelsRequest, ModelsResponse, TestRequest, TestResponse } from '../src/apiTypes.js'
import { isRecord } from '../src/json.js'

type Bridge = Awaited<ReturnType<typeof createBridge>>

let bridgePromise: Promise<Bridge> | undefined

export function getBridge(): Promise<Bridge> {
  bridgePromise ??= createBridge()
  return bridgePromise
}

export class ApiError extends Error {
  readonly status: number
  readonly payload: unknown

  constructor(message: string, status: number, payload: unknown) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.payload = payload
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const bridge = await getBridge()
  const headers = new Headers(init.headers)
  if (init.body) headers.set('content-type', 'application/json')
  const response = await bridge.fetch(path, { ...init, headers })
  let body: unknown = null
  try {
    body = await response.json()
  } catch {
    body = null
  }
  if (!response.ok || (isRecord(body) && body['ok'] === false)) {
    const message = isRecord(body) && typeof body['error'] === 'string' ? body['error'] : `请求失败（HTTP ${response.status}）`
    throw new ApiError(message, response.status, body)
  }
  return body as T
}

export const api = {
  meta: () => request<MetaResponse>('/api/meta'),
  getConfig: () => request<ConfigGetResponse>('/api/config'),
  saveConfig: (body: ConfigPutRequest) => request<ConfigPutResponse>('/api/config', { method: 'PUT', body: JSON.stringify(body) }),
  test: (body: TestRequest) => request<TestResponse>('/api/test', { method: 'POST', body: JSON.stringify(body) }),
  models: (body: ModelsRequest) => request<ModelsResponse>('/api/upstream-models', { method: 'POST', body: JSON.stringify(body) }),
}

export async function toast(message: string, level: 'info' | 'success' | 'warning' | 'error' = 'info'): Promise<void> {
  try {
    const bridge = await getBridge()
    bridge.toast(message, level)
  } catch {
    console.warn(message)
  }
}

export async function setPageTitle(title: string): Promise<void> {
  try {
    const bridge = await getBridge()
    bridge.setTitle(title)
    bridge.resize()
  } catch {
    document.title = title
  }
}

export async function resizePage(): Promise<void> {
  try {
    const bridge = await getBridge()
    bridge.resize()
  } catch {
    // 独立打开时没有桥，忽略
  }
}
