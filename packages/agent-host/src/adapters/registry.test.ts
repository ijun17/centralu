import { describe, expect, it, vi } from 'vitest'

/*
 * Deep review of #1687, follow-up 3: the host's opener (`personOpener`, `main.ts`) reaches Antigravity's sign-in only
 * through the registry. Dropped there, the sign-in opens the browser from the host, inside the job on Windows, and no
 * type says so.
 */
const profiles = vi.hoisted(() => [] as unknown[])
vi.mock('./antigravity/index.js', async (original) => {
  const real = await original<typeof import('./antigravity/index.js')>()
  return {
    ...real,
    antigravityProfile: (deps: Parameters<typeof real.antigravityProfile>[0]) => {
      profiles.push(deps)
      return real.antigravityProfile(deps)
    },
  }
})

const { createAdapters } = await import('./registry.js')

describe("the registry's Antigravity", () => {
  it("hands the host's opener to the sign-in, and none when the host has none", () => {
    const openUrl = (_url: string) => {}
    createAdapters({ antigravity: true, openUrl })
    expect(profiles.at(-1)).toEqual({ signIn: { openUrl } })
    createAdapters({ antigravity: true })
    expect(profiles.at(-1)).toEqual({})
  })
})
