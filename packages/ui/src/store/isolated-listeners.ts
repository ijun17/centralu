import type { StateCreator } from 'zustand'

/**
 * **A store listener that throws does not stop the others, or the code that set the state** (#2070).
 *
 * zustand calls its listeners in one loop inside `setState`, so a throwing one (a view's selector, or React refusing an
 * update loop, as in #2059) skipped every listener after it and threw out of `set` into its caller. A host event's
 * handler (`conversationEvent`) then stopped halfway: its later steps, the state-change notice among them, never ran
 * for that event, and the views after the failing one stayed behind the store. Each listener now runs on its own; the
 * error is logged and thrown again on its own once the others have run, so it still surfaces as an uncaught error.
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
          // Thrown again on its own, after the others ran: an uncaught error is what e2e catches as a page error, and a
          // listener that throws (React refusing an update loop, #2059) is a bug to see, not to swallow
          queueMicrotask(() => {
            throw err
          })
        }
      })
    return init(set, get, api)
  }
