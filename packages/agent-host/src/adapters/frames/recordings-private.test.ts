import { readdirSync, readFileSync } from 'node:fs'
import { homedir, hostname, userInfo } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * No committed recording carries the person who made it (#1562 review): a user name, a home or temp folder of any
 * system, or their own command list. Each recording is read as written and as the text its streamed chunks make joined,
 * since a path split across two chunks reads whole on the screen.
 */

const ROOTS = [
  fileURLToPath(new URL('../acp/recordings/', import.meta.url)),
  fileURLToPath(new URL('../antigravity/recordings/', import.meta.url)),
  fileURLToPath(new URL('../claude/recordings/', import.meta.url)),
  fileURLToPath(new URL('../codex/recordings/', import.meta.url)),
]

const PRIVATE: readonly [string, RegExp][] = [
  ['a Windows home folder', /[A-Za-z]:(?:\\\\|\\|\/)+Users(?:\\\\|\\|\/)+(?!<)[^\\/\s"'`]+/i],
  ['a Windows temp folder', /AppData(?:\\\\|\\|\/)+Local(?:\\\\|\\|\/)+Temp/i],
  ['a macOS home folder', /(?<![\w<])\/Users\/(?!<|Shared\b)[^/\s"'`]+/],
  ['a macOS temp folder', /\/var\/folders\/[^/\s"'`]+\/[^/\s"'`]+\/T\b/],
  ['a Linux home folder', /(?<![\w<])\/home\/(?!<)[^/\s"'`]+/],
  ['a bridge token', /ccb\d+:[\w-]+:[\w-]{16,}/],
  ['the account’s plan in Antigravity’s `tier`', /"tier":\{"name":"(?!<plan>|Antigravity Starter Quota")/],
  ['an OpenCode tool output id that is not a placeholder', /\btool_(?!\d{6}\b)[A-Za-z0-9]{16,}/],
  ['a secret in an environment entry', /\\?"name\\?":\\?"[A-Z_]*(?:TOKEN|SECRET|PASSWORD|KEY)[A-Z_]*\\?",\\?"value\\?":\\?"(?!<secret>)/],
]

/** What Claude Code's recordings must also be free of: its frames carry the person's account and connectors, and real session ids */
const CLAUDE_PRIVATE: readonly [string, RegExp][] = [
  ['an id that is not a placeholder', /\b(?!0{4}\d{4}-0000-4000-8000-)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i],
  ['an account address', /[\w.+-]+@[\w-]+\.[\w.-]+/],
  // The recorder's probe server is its own. Server and tool both named: a name streamed in pieces reads whole only in the joined reading, and its first piece alone (`mcp__central`) is no connector
  ['a connector of the person', /\bmcp__(?!centralu__|probe__|app-|server-\d+__)[\w.-]+?__[\w.-]+/],
]

/** What Codex's recordings must also be free of: the app-server says the account's plan and the machine's name, and numbers a response's items */
const CODEX_PRIVATE: readonly [string, RegExp][] = [
  ['the account’s plan', /"planType":"(?!<plan>)/],
  ['a response item id that is not a placeholder', /\b(?:msg|rs|call|fc|ws|resp)_(?!\d{6}\b)[0-9a-f]{16,}/],
]

/**
 * The words of the machine the test runs on. The user name is looked for only off CI: a recording is made and
 * scrubbed on a person's machine, so that is where their name could leak, while a CI runner's account is a common
 * word ("runner") that a model's own text may use (an Antigravity sub-agent named its role "Command Runner").
 */
function machineWords(codex: boolean): [string, RegExp][] {
  const words: [string, RegExp][] = []
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  try {
    const user = userInfo().username
    if (user.length >= 3 && !process.env.CI) words.push(['this machine’s user name', new RegExp(`\\b${escape(user)}\\b`, 'i')])
  } catch {
    // No user name to look for
  }
  // The machine's name, as a host in a path or an address (`\\name\share`, `user@name`, `name.local`): a bare word could be a month ("Jun") in a listing. Off CI, where a runner's name is a common word
  const machine = hostname().split('.')[0] ?? ''
  if (machine.length >= 3 && !process.env.CI) words.push(['this machine’s name', new RegExp(`[\\\\/@]${escape(machine)}\\b|\\b${escape(machine)}\\.(?:local|lan|home|internal)\\b`, 'i')])
  // A Codex app-server also says the machine's name bare, in the frames about its remote control
  if (codex && machine.length >= 4 && !process.env.CI) words.push(['this machine’s name', new RegExp(`\\b${escape(machine)}\\b`, 'i')])
  for (const form of new Set([homedir(), homedir().replace(/\\/g, '/'), homedir().replace(/\\/g, '\\\\')])) {
    if (form.length > 3) words.push(['this machine’s home folder', new RegExp(escape(form), 'i')])
  }
  return words
}

type Delta = { type?: string; text?: unknown; thinking?: unknown; partial_json?: unknown }
type Command = { name?: unknown; builtin?: unknown }
type Line = {
  dir?: string
  msg?: {
    method?: string
    type?: string
    params?: { update?: { sessionUpdate?: string; content?: { text?: unknown }; availableCommands?: { name?: unknown }[] } }
    /** Claude Code's stream-json */
    event?: { delta?: Delta }
    commands?: Command[]
    response?: { response?: { commands?: Command[] } }
  }
}

/** The recording's text as the screen would read it: every streamed chunk joined to the ones beside it */
function joinedChunks(lines: readonly Line[]): string {
  return lines
    .map((l) => {
      const u = l.msg?.params?.update
      if (u && /_chunk$/.test(u.sessionUpdate ?? '') && typeof u.content?.text === 'string') return u.content.text
      // A line of Claude Code's that is no stream event is between the pieces of a block, not a break in it
      if (typeof l.msg?.type === 'string' && l.msg.type !== 'stream_event') return ''
      const d = l.msg?.event?.delta
      const piece = d?.type === 'text_delta' ? d.text : d?.type === 'thinking_delta' ? d.thinking : d?.type === 'input_json_delta' ? d.partial_json : undefined
      return typeof piece === 'string' ? piece : '\n'
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
      const found = [...PRIVATE, ...(/[\\/](?:claude|codex)[\\/]recordings[\\/]/.test(file) ? CLAUDE_PRIVATE : []), ...(/[\\/]codex[\\/]recordings[\\/]/.test(file) ? CODEX_PRIVATE : []), ...machineWords(/[\\/]codex[\\/]recordings[\\/]/.test(file))].flatMap(([what, re]) => readings.flatMap((r) => (re.exec(r) ? [`${what}: ${re.exec(r)![0]}`] : [])))
      expect(found).toEqual([])
      const commands = lines.flatMap((l) => l.msg?.params?.update?.availableCommands ?? []).map((c) => c.name)
      expect(commands.filter((c) => typeof c !== 'string' || !/^command-\d+$/.test(c))).toEqual([])
      // Claude Code's lists keep the commands that ship with it and number the rest
      const own = lines.flatMap((l) => [...(l.msg?.commands ?? []), ...(l.msg?.response?.response?.commands ?? [])]).filter((c) => c.builtin !== true)
      expect(own.filter((c) => typeof c.name !== 'string' || !/^command-\d+$/.test(c.name))).toEqual([])
    })
  }
})
