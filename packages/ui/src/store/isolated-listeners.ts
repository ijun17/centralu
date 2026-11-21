import type { StateCreator } from 'zustand'

// docs/state-management.md §2: each store listener runs on its own (#2070).
export const isolatedListeners =
  <T>(init: StateCreator<T>): StateCreator<T> =>
  (set, get, api) => {
    const subscribe = api.subscribe
    api.subscribe = (listener) =>
      subscribe((state, previous) => {
        try {
          listener(state, previous)
        } catch (err) {
          console.error('A store listener threw', err)
          // Uncaught, so e2e sees it as a page error: a throwing listener is a bug to see (#2059)
          queueMicrotask(() => {
            throw err
          })
        }
      })
    return init(set, get, api)
  }
