import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { claudeApiUrl } from './api-url.js'

describe("the API host Claude Code's turns reach (#1415)", () => {
  const dirs: string[] = []
  const dir = () => {
    const d = mkdtempSync(join(tmpdir(), 'claude-api-url-'))
    dirs.push(d)
    return d
  }
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  it("is the user settings' ANTHROPIC_BASE_URL first, as the CLI applies it over the environment", async () => {
    const d = dir()
    writeFileSync(join(d, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://gateway.local:8080' } }))
    expect(await claudeApiUrl({ ANTHROPIC_BASE_URL: 'http://env.local' }, d)).toBe('http://gateway.local:8080')
  })

  it("else the environment's, else Anthropic's; a settings file that is missing or not JSON is no answer", async () => {
    const d = dir()
    expect(await claudeApiUrl({ ANTHROPIC_BASE_URL: 'http://env.local' }, d)).toBe('http://env.local')
    writeFileSync(join(d, 'settings.json'), '{ not json')
    expect(await claudeApiUrl({}, d)).toBe('https://api.anthropic.com')
  })
})
