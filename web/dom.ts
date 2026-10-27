/** 轻量 DOM 构造：页面里的动态值一律走 textContent，不拼 innerHTML。 */

export type Child = Node | string | number | null | undefined | false

type EventMap = Partial<Record<keyof HTMLElementEventMap, EventListener>>

export interface Props {
  class?: string
  text?: string
  title?: string
  type?: string
  value?: string | number
  placeholder?: string
  disabled?: boolean
  checked?: boolean
  selected?: boolean
  min?: string | number
  max?: string | number
  step?: string | number
  rows?: number
  style?: string
  attrs?: Record<string, string>
  on?: EventMap
  dataset?: Record<string, string>
  aria?: Record<string, string>
}

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  if (props.class) el.className = props.class
  if (props.text !== undefined) el.textContent = props.text
  if (props.title) el.title = props.title
  if (props.style) el.style.cssText = props.style
  if (props.attrs) for (const [key, value] of Object.entries(props.attrs)) el.setAttribute(key, value)
  if (props.dataset) for (const [key, value] of Object.entries(props.dataset)) el.dataset[key] = value
  if (props.aria) for (const [key, value] of Object.entries(props.aria)) el.setAttribute(`aria-${key}`, value)

  const target = el as HTMLElement & { value?: string | number; checked?: boolean; disabled?: boolean; selected?: boolean }
  if (props.type !== undefined) el.setAttribute('type', props.type)
  if (props.value !== undefined) target.value = props.value
  if (props.placeholder !== undefined) el.setAttribute('placeholder', props.placeholder)
  if (props.disabled !== undefined) target.disabled = props.disabled
  if (props.checked !== undefined) target.checked = props.checked
  if (props.selected !== undefined) target.selected = props.selected
  if (props.min !== undefined) el.setAttribute('min', String(props.min))
  if (props.max !== undefined) el.setAttribute('max', String(props.max))
  if (props.step !== undefined) el.setAttribute('step', String(props.step))
  if (props.rows !== undefined) el.setAttribute('rows', String(props.rows))

  if (props.on) for (const [name, handler] of Object.entries(props.on)) el.addEventListener(name, handler as EventListener)
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue
    el.append(child instanceof Node ? child : document.createTextNode(String(child)))
  }
  return el
}

export function clear(node: Element): void {
  while (node.firstChild) node.removeChild(node.firstChild)
}

/** field() 自动生成的 id 计数器；只在页面生命周期内递增，不参与持久化 */
let fieldIdSeed = 0

/**
 * 表单字段：label 与 control 用 for/id 关联，点标签也能聚焦控件、读屏能念出字段名。
 * 自动生成 id；control 已有 id 时直接复用，不覆盖。
 */
export function field(label: string, control: HTMLElement, desc?: string): HTMLElement {
  fieldIdSeed += 1
  if (!control.id) control.id = `field-${fieldIdSeed}`
  return h(
    'div',
    { class: 'field' },
    h('label', { text: label, attrs: { for: control.id } }),
    control,
    desc ? h('span', { class: 'desc', text: desc }) : null,
  )
}

export function badge(text: string, kind: 'ok' | 'warn' | 'err' | '' = ''): HTMLElement {
  return h('span', { class: `badge ${kind}`.trim(), text })
}

export function formatTime(iso: string): string {
  if (!iso) return '—'
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString('zh-CN', { hour12: false })
}

export function formatTokenCount(value?: number): string {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return '—'
  if (value >= 1_000_000) return `${Math.round((value / 1_000_000) * 10) / 10}M`
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`
  return String(value)
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const area = h('textarea', { value: text, style: 'position:fixed;opacity:0' })
    document.body.append(area)
    area.select()
    const ok = document.execCommand('copy')
    area.remove()
    return ok
  }
}

export function download(filename: string, text: string): void {
  const blob = new Blob([text], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = h('a', { attrs: { href: url, download: filename } })
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
