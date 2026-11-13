import { z } from 'zod'
import { pathsOf } from '../../os.js'
import { realOs } from '../../os/real.js'
import type { ReadText } from '../claude/api-url.js'
import { codexHome } from './home.js'

const readText: ReadText = (path) => realOs().files.promises.readFile(path, 'utf8')

/** A base URL as config.toml may give it: an http(s) address, nothing else (a probe goes there) */
const BaseUrl = z.string().url().refine((u) => /^https?:\/\//i.test(u))

/**
 * The API host Codex's turns reach (`AgentAdapter.apiUrl`, #1415): `chatgpt_base_url` of the user's `config.toml` (in `CODEX_HOME` or `~/.codex`, what a
 * ChatGPT sign-in talks to), else `OPENAI_BASE_URL` (an API key's), else ChatGPT's own.
 *
 * Only that one top-level key is read, from a line of its own before the first `[table]` (`chatgpt_base_url = "https://…"`), not the whole TOML: there
 * is no TOML parser in the host, and a probe address is all this needs. A key written another way (a literal string, a dotted table) is not seen, and
 * such a session's probe asks ChatGPT's host; its wait still ends at the probe cap (`turn-continue.ts`). A project's own `.codex/config.toml` is not
 * read either, for the same reason
 */
export async function codexApiUrl(
  env: Record<string, string | undefined> = process.env,
  home: string = codexHome(env),
  read: ReadText = readText,
): Promise<string> {
  const text = await read(pathsOf().join(home, 'config.toml')).catch(() => '')
  return chatgptBaseUrl(text) ?? (env.OPENAI_BASE_URL || 'https://chatgpt.com')
}

/** `chatgpt_base_url` at the top of a config.toml's text, when it is a plain quoted http(s) address */
export function chatgptBaseUrl(toml: string): string | null {
  for (const raw of toml.split(/\r?\n/)) {
    const line = raw.trim()
    // The first table ends the top level: a key below it belongs to that table
    if (line.startsWith('[')) return null
    const m = /^chatgpt_base_url\s*=\s*"([^"\\]*)"\s*(?:#.*)?$/.exec(line)
    if (m) {
      const url = BaseUrl.safeParse(m[1])
      return url.success ? url.data : null
    }
  }
  return null
}
