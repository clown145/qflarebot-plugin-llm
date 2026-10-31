import { emit } from './state.js'

const sections = new Set<string>()

/** 页面内还没有提交的编辑，包括尚未保存的模型弹窗。 */
export function setPending(section: string, dirty: boolean): void {
  const had = sections.has(section)
  if (dirty === had) return
  if (dirty) sections.add(section)
  else sections.delete(section)
  emit()
}

export function hasPendingEdits(): boolean {
  return sections.size > 0
}

/**
 * 丢弃全部未提交编辑标记。
 *
 * `resetServiceState` / `resetSettingsDraft` 会各自清掉自己那一段，但重新加载或导入后
 * 如果某个视图没走到自己的 reset（例如切换过 tab、视图模块还没渲染），残留标记会让
 * 「有未保存修改」的角标一直亮着，刷新/关闭页面时还会多弹一次 beforeunload 确认。
 * 所以整页级重置统一调这里兜底。
 */
export function clearPending(): void {
  if (sections.size === 0) return
  sections.clear()
  emit()
}
