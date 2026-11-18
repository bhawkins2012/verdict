import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CategoryPage } from './CategoryPage'
import { api, routes } from '../test/apiMock'
import { render, Rendered, settle } from '../test/render'

vi.mock('../lib/api', () => import('../test/apiMock'))

const lever = (id: string, name: string, extra: object = {}) => ({
  id, name, type: 'MEASUREMENT', inputFormat: 'SINGLE', unit: 'lb', explanation: `Why ${name} matters.`, allowedValues: [], position: 1,
  options: { min: 10, max: 30 }, ...extra,
})
const page = (count: number) => ({
  category: { slug: 's', name: 'Strollers' },
  levers: [lever('w', 'Weight')],
  products: Array.from({ length: count }, (_, i) => ({ id: `p${i}`, name: `P${i}`, brand: null, imageUrl: null, avgRatingLongterm: null, totalReviewCount: 0, values: {} })),
  totalInCategory: 3,
  sort: 'name',
})

/** Type into a controlled input the way a browser does (React listens for "input"). */
async function type(input: HTMLInputElement, text: string) {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  for (let i = 1; i <= text.length; i++) {
    await act(async () => {
      setValue?.call(input, text.slice(0, i))
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }
}

let view: Rendered | undefined
beforeEach(() => {
  routes.clear()
  api.get.mockClear()
  routes.set('GET /categories/s?', () => page(3))
  routes.set('GET /categories/s?lever%5Bw%5D%5Bmax%5D=1.5', () => page(1))
})
afterEach(() => view?.unmount())

describe('category page filters', () => {
  it('keeps a decimal as typed ("1." then "1.5") and sends one request after typing stops', async () => {
    view = render(<CategoryPage />, { route: '/categories/:slug', path: '/categories/s' })
    await settle()
    const max = view.container.querySelector<HTMLInputElement>('input[aria-label="Weight maximum"]')
    if (!max) throw new Error('no max input')

    await type(max, '1.')
    expect(max.value).toBe('1.')
    await type(max, '1.5')
    expect(max.value).toBe('1.5')

    await act(async () => { await new Promise((r) => setTimeout(r, 400)) })
    await settle()
    const urls = api.get.mock.calls.map((c) => c[0])
    expect(urls.filter((u) => u.includes('lever'))).toEqual(['/categories/s?lever%5Bw%5D%5Bmax%5D=1.5'])
    expect(view.container.querySelector('[data-testid="result-count"]')?.textContent).toBe('1 of 3 products')
  })
})
