import { describe, expect, it } from 'vitest'
import { pathsOf } from '../../os.js'
import { claudeApiUrl, type ReadText } from './api-url.js'

describe("the API host Claude Code's turns reach (#1415)", () => {
  const dir = pathsOf().join('cfg', '.claude')
  /** The files there are: a path read that is not one fails, as a missing file does */
  const files = (texts: Record<string, string>): ReadText => (path) =>
    path in texts ? Promise.resolve(texts[path] ?? '') : Promise.reject(new Error(`ENOENT: ${path}`))
  const settings = pathsOf().join(dir, 'settings.json')

  it("is the user settings' ANTHROPIC_BASE_URL first, as the CLI applies it over the environment", async () => {
    const read = files({ [settings]: JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://gateway.local:8080' } }) })
    expect(await claudeApiUrl({ ANTHROPIC_BASE_URL: 'http://env.local' }, dir, read)).toBe('http://gateway.local:8080')
  })

  it("else the environment's, else Anthropic's; a settings file that is missing or not JSON is no answer", async () => {
    expect(await claudeApiUrl({ ANTHROPIC_BASE_URL: 'http://env.local' }, dir, files({}))).toBe('http://env.local')
    expect(await claudeApiUrl({}, dir, files({ [settings]: '{ not json' }))).toBe('https://api.anthropic.com')
    expect(await claudeApiUrl({}, dir, files({ [settings]: JSON.stringify({ env: { OTHER: 'x' } }) }))).toBe('https://api.anthropic.com')
  })
})
