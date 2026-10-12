import { describe, expect, it } from 'vitest'
import type { FullConfig } from '@playwright/test'
import config from '../e2e/playwright.config.js'
import warmEngine from '../e2e/warm-engine.js'

/**
 * The e2e run opens the app once in its engine before any test (e2e/warm-engine.ts): on a fresh runner WebKit's first
 * page builds its caches, which took the first test of each worker past its 20 s.
 */

/** A browser type that records what was opened and closed */
function fakeEngine(log: string[], name: string) {
  return {
    launch: async () => {
      log.push(`${name}: launch`)
      return {
        newContext: async () => ({
          newPage: async () => {
            log.push(`${name}: page`)
            return { goto: async (url: string) => void log.push(`${name}: ${url}`) }
          },
          close: async () => void log.push(`${name}: context closed`),
        }),
        close: async () => void log.push(`${name}: closed`),
      }
    },
  } as never
}

const run = async (browserName: string | undefined) => {
  const log: string[] = []
  const full = { projects: [{ use: { browserName, baseURL: 'http://127.0.0.1:5174' } }] } as unknown as FullConfig
  await warmEngine(full, { chromium: fakeEngine(log, 'chromium'), webkit: fakeEngine(log, 'webkit') })
  return log
}

describe('the e2e run opens its engine once before the tests', () => {
  it('is the global setup of e2e/playwright.config.ts', () => {
    expect(config.globalSetup).toBe('./warm-engine.ts')
  })

  it('opens the app in the engine the run uses, then closes it', async () => {
    const opened = ['launch', 'page', 'http://127.0.0.1:5174/?mock=1', 'context closed', 'closed']
    expect(await run('webkit')).toEqual(opened.map((s) => `webkit: ${s}`))
    expect(await run('chromium')).toEqual(opened.map((s) => `chromium: ${s}`))
    expect(await run(undefined)).toEqual(opened.map((s) => `chromium: ${s}`))
  })
})
