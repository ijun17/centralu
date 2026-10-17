import { existsSync, readFileSync, rmSync } from 'node:fs'

/**
 * Says after a run that a dev server died and was started again (playwright.config.ts `globalTeardown`, #651).
 *
 * scripts/e2e-web-server.mjs starts a vite that died mid-run again and writes one line per death to the file named by
 * `E2E_WEB_SERVER_EVENTS`. A run can then end green with some tests having hit a dead server, and the server's own
 * line sits in the middle of the log, behind Playwright's `[WebServer]` prefix, where GitHub reads no annotation. So
 * the deaths are told here, from the runner's own output: a `::warning::` annotation on GitHub Actions, a plain line
 * elsewhere.
 */

export interface ServerDeath {
  url: string
  how: string
  restarted: boolean
}

export function deathLines(deaths: ServerDeath[], github: boolean): string[] {
  return deaths.map((d) => {
    const text = `the dev server at ${d.url} died mid-run (${d.how}) and ${d.restarted ? 'was started again' : 'was not started again'}; the tests talking to it then may have failed for that (#651)`
    return github ? `::warning title=e2e dev server died::${text}` : `[e2e] ${text}`
  })
}

export function readDeaths(file: string): ServerDeath[] {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as ServerDeath)
}

export default async function reportServerDeaths(): Promise<void> {
  const file = process.env.E2E_WEB_SERVER_EVENTS
  if (!file) return
  for (const line of deathLines(readDeaths(file), process.env.GITHUB_ACTIONS === 'true')) console.log(line)
  rmSync(file, { force: true })
}
