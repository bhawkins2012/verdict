import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CategoryPage } from './CategoryPage'
import { api, routes } from '../test/apiMock'
import { render, Rendered, settle } from '../test/render'

vi.mock('../lib/api', () => import('../test/apiMock'))

const lever = (id: string, name: string, extra: object = {}) => ({
  id, definitionId: `d-${id}`, name, type: 'MEASUREMENT', inputFormat: 'SINGLE', unit: 'lb', explanation: `Why ${name} matters.`, allowedValues: [], position: 1,
  options: { min: 10, max: 30 }, ...extra,
})
const crumbs = [{ slug: 'baby', name: 'Baby and Kids', visible: true }, { slug: 'nav', name: 'Strollers', visible: true }, { slug: 's', name: 'Full-size strollers', visible: true }]
const page = (count: number) => ({
  kind: 'DECISION', slug: 's', name: 'Full-size strollers', breadcrumbs: crumbs,
  levers: [lever('w', 'Weight')],
  products: Array.from({ length: count }, (_, i) => ({
    id: `p${i}`, name: `P${i}`, brand: null, avgRatingLongterm: null, totalReviewCount: 0, isDryRun: i === 0, alsoListed: false,
    values: { w: i === 1 ? { unknown: true } : { unknown: false, number: 10 + i, unit: 'lb', text: null, bool: null, list: [], dimensions: null, detail: null, evidence: { quote: 'q', url: 'https://x.example/', adminAttested: false } } },
  })),
  total: 3,
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

describe('decision node page', () => {
  it('shows breadcrumbs, published values and unknowns, and marks dry-run products', async () => {
    view = render(<CategoryPage />, { route: '/categories/:slug', path: '/categories/s' })
    await settle()
    const nav = view.container.querySelector('nav[aria-label="Breadcrumb"]')
    expect(nav?.textContent).toBe('DiscoverBaby and KidsStrollersFull-size strollers')
    expect(nav?.querySelector('[aria-current="page"]')?.textContent).toBe('Full-size strollers')
    const text = view.container.textContent ?? ''
    expect(text).toContain('10 lb')
    expect(text).toContain('Unknown')
    expect(text).toContain('Dry-run data')
  })

  it('on a phone the filters sit behind one "Filters" button', async () => {
    view = render(<CategoryPage />, { route: '/categories/:slug', path: '/categories/s' })
    await settle()
    const filters = view.container.querySelector('#lever-filters')
    const button = view.container.querySelector<HTMLButtonElement>('button[aria-controls="lever-filters"]')
    expect(filters?.className).toContain('hidden md:grid')
    expect(button?.getAttribute('aria-expanded')).toBe('false')
    await act(async () => { button?.click() })
    expect(view.container.querySelector('#lever-filters')?.className).not.toContain('hidden')
    expect(button?.getAttribute('aria-expanded')).toBe('true')
  })
})

describe('navigation node page', () => {
  it('shows the explainer and the children, each with its one-line difference', async () => {
    routes.set('GET /categories/nav?', () => ({
      kind: 'NAVIGATION', slug: 'nav', name: 'Strollers', breadcrumbs: crumbs.slice(0, 2), explainer: 'Strollers differ in size, wheels and fold.',
      children: [
        { slug: 's', name: 'Full-size strollers', kind: 'DECISION', line: 'For everyday use.', productCount: 18, alsoListed: false },
        { slug: 'j', name: 'Jogging strollers', kind: 'DECISION', line: 'For running.', productCount: 12, alsoListed: false },
      ],
    }))
    view = render(<CategoryPage />, { route: '/categories/:slug', path: '/categories/nav' })
    await settle()
    expect(view.container.querySelector('h2')?.textContent).toBe('Strollers')
    expect(view.container.textContent).toContain('Strollers differ in size, wheels and fold.')
    const links = [...view.container.querySelectorAll('ul a')].map((a) => [a.getAttribute('href'), a.textContent])
    expect(links).toEqual([
      ['/categories/s', 'Full-size strollersFor everyday use.18 products compared'],
      ['/categories/j', 'Jogging strollersFor running.12 products compared'],
    ])
    expect(view.container.querySelector('#lever-filters')).toBeNull()
  })
})
