import type { StateCreator } from 'zustand'

/**
 * **A store listener that throws does not stop the others, or the code that set the state** (#2070).
 *
 * zustand calls its listeners in one loop inside `setState`, so a throwing one (a view's selector, or React refusing an
 * update loop, as in #2059) skipped every listener after it and threw out of `set` into its caller. A host event's
 * handler (`conversationEvent`) then stopped halfway: its later steps, the state-change notice among them, never ran
 * for that event, and the views after the failing one stayed behind the store. Each listener now runs on its own; the
 * error is logged as the host connection already logs a throwing subscriber (`platform/deliver.ts`).
 */
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
        }
      })
    return init(set, get, api)
  }
