import { dialogShell } from './dialogs.js'
import { badge, clear, h } from './dom.js'
import type { ProviderPreset } from './providerDraft.js'
import { PROVIDER_PRESETS } from './providerDraft.js'

export function pickProviderPreset(): Promise<ProviderPreset | null> {
  return new Promise((resolve) => {
    let done = false
    let view!: ReturnType<typeof dialogShell>
    const finish = (preset: ProviderPreset | null) => {
      if (done) return
      done = true
      resolve(preset)
      view.dialog.close()
    }

    view = dialogShell('添加供应商', () => finish(null), 'preset-dialog')
    const search = h('input', { type: 'search', placeholder: '搜索服务商或接口地址' })
    const grid = h('div', { class: 'preset-grid' })

    const render = () => {
      clear(grid)
      const keyword = search.value.trim().toLowerCase()
      const shown = PROVIDER_PRESETS.filter((preset) => {
        if (!keyword) return true
        return [preset.name, preset.description, preset.base_url, preset.protocol].some((value) => value.toLowerCase().includes(keyword))
      })
      if (shown.length === 0) {
        grid.append(h('div', { class: 'empty', text: '没有匹配的模板，可以搜索「自定义」。' }))
        return
      }
      for (const preset of shown) {
        const button = h(
          'button',
          { class: 'preset', type: 'button' },
          h('span', { class: 'preset-head' }, h('span', { class: 'preset-name', text: preset.name }), badge(preset.protocol === 'anthropic' ? 'Anthropic' : preset.protocol === 'gemini' ? 'Gemini' : 'OpenAI 兼容', '')),
          h('span', { class: 'small muted', text: preset.description }),
          h('span', { class: 'preset-url mono small', text: preset.base_url || '创建后填写接口地址' }),
        )
        button.addEventListener('click', () => finish(preset))
        grid.append(button)
      }
    }

    search.addEventListener('input', render)
    render()
    view.body.append(
      h('p', { class: 'small muted', text: '模板只预填协议和接口地址，创建后还能改名称、Key 和请求头。' }),
      h('div', { style: 'height:8px' }),
      search,
      h('div', { style: 'height:12px' }),
      grid,
    )
    view.actions.append(
      h('div', { style: 'flex:1' }),
      h('button', { class: 'qb-btn', text: '取消', type: 'button', on: { click: () => finish(null) } }),
    )
    search.focus()
  })
}
