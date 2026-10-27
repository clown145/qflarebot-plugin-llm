import { describe, expect, it } from 'vitest'
import { field, h } from './dom.js'

describe('field', () => {
  it('label 的 for 指向 control 的 id', () => {
    const control = h('input', { value: 'x' })
    const wrapper = field('显示名称', control)
    const label = wrapper.querySelector('label')
    expect(label).not.toBeNull()
    expect(label?.getAttribute('for')).toBeTruthy()
    expect(control.id).toBeTruthy()
    expect(label?.getAttribute('for')).toBe(control.id)
  })

  it('每个字段拿到不同 id', () => {
    const first = field('A', h('input'))
    const second = field('B', h('input'))
    const firstId = first.querySelector('input')?.id
    const secondId = second.querySelector('input')?.id
    expect(firstId).toBeTruthy()
    expect(secondId).toBeTruthy()
    expect(firstId).not.toBe(secondId)
  })

  it('control 已有 id 时不覆盖', () => {
    const control = h('input', { attrs: { id: 'my-own-id' } })
    const wrapper = field('别名', control)
    expect(control.id).toBe('my-own-id')
    expect(wrapper.querySelector('label')?.getAttribute('for')).toBe('my-own-id')
  })

  it('保留 desc 文本', () => {
    const wrapper = field('超时', h('input'), '1000–28000')
    expect(wrapper.querySelector('.desc')?.textContent).toBe('1000–28000')
  })

  it('label 可以被点击后关联到控件（通过 for 查找）', () => {
    const control = h('select')
    const wrapper = field('协议', control)
    document.body.append(wrapper)
    const label = wrapper.querySelector('label')!
    const forId = label.getAttribute('for')!
    expect(document.getElementById(forId)).toBe(control)
    wrapper.remove()
  })
})
