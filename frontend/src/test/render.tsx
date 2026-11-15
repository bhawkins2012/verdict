// Minimal component-test harness: react-dom + act under jsdom (no Testing Library dependency).
import { act, ReactElement } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

export interface Rendered {
  container: HTMLDivElement
  unmount: () => void
}

/** Render `element` at `path` (matching `route`), with a fresh React Query client (no retries). */
export function render(element: ReactElement, opts: { route?: string; path?: string; state?: unknown } = {}): Rendered {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  const path = opts.path ?? '/'
  let root: Root | undefined
  act(() => {
    root = createRoot(container)
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[{ pathname: path, state: opts.state ?? null }]}>
          <Routes>
            <Route path={opts.route ?? '/'} element={element} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    )
  })
  return {
    container,
    unmount: () => {
      act(() => root?.unmount())
      container.remove()
    },
  }
}

/** Let pending promises (mocked API calls, React Query) settle. */
export async function settle(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
  }
}

export async function click(el: Element | null): Promise<void> {
  if (!el) throw new Error('element not found')
  await act(async () => {
    ;(el as HTMLElement).click()
  })
}
