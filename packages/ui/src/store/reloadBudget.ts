/**
 * How many times each view may reopen on its own within a window (apps-plan C-4, `followAppCode`). Each ask sweeps
 * the keys whose reopens all fall outside the window: a closed view never asks again, so its key would stay forever.
 */
export type ReloadBudget = {
  allow(key: string, now?: number): boolean
  size(): number
}

export function reloadBudget(limit: number, windowMs: number): ReloadBudget {
  const reopens = new Map<string, number[]>()
  return {
    allow(key, now = Date.now()) {
      for (const [k, times] of reopens) {
        if (times.every((t) => now - t >= windowMs)) reopens.delete(k)
      }
      const recent = (reopens.get(key) ?? []).filter((t) => now - t < windowMs)
      const ok = recent.length < limit
      if (ok) recent.push(now)
      reopens.set(key, recent)
      return ok
    },
    size: () => reopens.size,
  }
}
