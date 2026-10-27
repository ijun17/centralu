import { readdirSync, readFileSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * No committed recording carries the person who made it (#1562 review): a user name, a home or temp folder of any
 * system, or their own command list. Each recording is read as written and as the text its streamed chunks make joined,
 * since a path split across two chunks reads whole on the screen.
 */

const ROOTS = [fileURLToPath(new URL('../acp/recordings/', import.meta.url))]

const PRIVATE: readonly [string, RegExp][] = [
  ['a Windows home folder', /[A-Za-z]:(?:\\\\|\\|\/)+Users(?:\\\\|\\|\/)+(?!<)[^\\/\s"'`]+/i],
  ['a Windows temp folder', /AppData(?:\\\\|\\|\/)+Local(?:\\\\|\\|\/)+Temp/i],
  ['a macOS home folder', /(?<![\w<])\/Users\/(?!<|Shared\b)[^/\s"'`]+/],
  ['a macOS temp folder', /\/var\/folders\/[^/\s"'`]+\/[^/\s"'`]+\/T\b/],
  ['a Linux home folder', /(?<![\w<])\/home\/(?!<)[^/\s"'`]+/],
  ['a bridge token', /ccb\d+:[\w-]+:[\w-]{16,}/],
  ['a secret in an environment entry', /\\?"name\\?":\\?"[A-Z_]*(?:TOKEN|SECRET|PASSWORD|KEY)[A-Z_]*\\?",\\?"value\\?":\\?"(?!<secret>)/],
]

/**
 * The words of the machine the test runs on. The user name is looked for only off CI: a recording is made and
 * scrubbed on a person's machine, so that is where their name could leak, while a CI runner's account is a common
 * word ("runner") that a model's own text may use (an Antigravity sub-agent named its role "Command Runner").
 */
function machineWords(): [string, RegExp][] {
  const words: [string, RegExp][] = []
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  try {
    const user = userInfo().username
    if (user.length >= 3 && !process.env.CI) words.push(['this machine’s user name', new RegExp(`\\b${escape(user)}\\b`, 'i')])
  } catch {
    // No user name to look for
  }
  for (const form of new Set([homedir(), homedir().replace(/\\/g, '/'), homedir().replace(/\\/g, '\\\\')])) {
    if (form.length > 3) words.push(['this machine’s home folder', new RegExp(escape(form), 'i')])
  }
  return words
}

type Line = { dir?: string; msg?: { method?: string; params?: { update?: { sessionUpdate?: string; content?: { text?: unknown }; availableCommands?: { name?: unknown }[] } } } }

/** The recording's text as the screen would read it: every streamed chunk joined to the ones beside it */
function joinedChunks(lines: readonly Line[]): string {
  return lines
    .map((l) => {
      const u = l.msg?.params?.update
      return u && /_chunk$/.test(u.sessionUpdate ?? '') && typeof u.content?.text === 'string' ? u.content.text : '\n'
    })
    .join('')
}

const files = ROOTS.flatMap((root) => readdirSync(root).flatMap((dir) => readdirSync(join(root, dir)).filter((f) => f.endsWith('.jsonl')).map((f) => join(root, dir, f))))

describe('the committed recordings', () => {
  it('are there to check', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  for (const file of files) {
    const name = file.slice(file.lastIndexOf('recordings') + 'recordings'.length + 1)
    it(`${name} names no person, no home or temp folder, and no one's own commands`, () => {
      const text = readFileSync(file, 'utf8')
      const lines = text.split('\n').filter(Boolean).map((l) => JSON.parse(l) as Line)
      const readings = [text, joinedChunks(lines)]
      const found = [...PRIVATE, ...machineWords()].flatMap(([what, re]) => readings.flatMap((r) => (re.exec(r) ? [`${what}: ${re.exec(r)![0]}`] : [])))
      expect(found).toEqual([])
      const commands = lines.flatMap((l) => l.msg?.params?.update?.availableCommands ?? []).map((c) => c.name)
      expect(commands.filter((c) => typeof c !== 'string' || !/^command-\d+$/.test(c))).toEqual([])
    })
  }
})
