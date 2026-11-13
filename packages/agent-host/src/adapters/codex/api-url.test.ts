import { describe, expect, it } from 'vitest'
import { pathsOf } from '../../os.js'
import type { ReadText } from '../settings-text.js'
import { chatgptBaseUrl, codexApiUrl } from './api-url.js'

describe("the API host Codex's turns reach (#1415)", () => {
  const home = pathsOf().join('cfg', '.codex')
  const config = pathsOf().join(home, 'config.toml')
  const files = (texts: Record<string, string>): ReadText => (path) =>
    path in texts ? Promise.resolve(texts[path] ?? '') : Promise.reject(new Error(`ENOENT: ${path}`))

  it("is config.toml's chatgpt_base_url first (a ChatGPT sign-in's), then OPENAI_BASE_URL, then ChatGPT's", async () => {
    const read = files({ [config]: 'model = "gpt-5"\nchatgpt_base_url = "https://proxy.local:8443/backend-api/" # through the proxy\n\n[mcp_servers.x]\ncommand = "y"\n' })
    expect(await codexApiUrl({ OPENAI_BASE_URL: 'http://key.local' }, home, read)).toBe('https://proxy.local:8443/backend-api/')
    expect(await codexApiUrl({ OPENAI_BASE_URL: 'http://key.local' }, home, files({}))).toBe('http://key.local')
    expect(await codexApiUrl({}, home, files({}))).toBe('https://chatgpt.com')
  })

  it('reads only a plain top-level http(s) address: a key under a table, or not an address, is no answer', () => {
    expect(chatgptBaseUrl('[profiles.work]\nchatgpt_base_url = "https://work.local"\n')).toBeNull()
    expect(chatgptBaseUrl('chatgpt_base_url = "file:///etc/passwd"')).toBeNull()
    expect(chatgptBaseUrl('chatgpt_base_url = "not a url"')).toBeNull()
    expect(chatgptBaseUrl('# chatgpt_base_url = "https://x.local"')).toBeNull()
  })
})
